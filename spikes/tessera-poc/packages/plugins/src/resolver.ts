import { CORE_TOKEN_PREFIX, type PluginDescription, type PluginManifest } from '@tessera/contracts';
import semver from 'semver';
import { isRealRange, parseManifest } from './manifest.ts';

/** Where a plugin comes from. The default policy trusts builtin and dev only. */
const KNOWN_SOURCES: ReadonlySet<string> = new Set(['builtin', 'user', 'dev']);

export type ResolutionState = 'invalid' | 'unresolved' | 'resolved';
export type ResolutionCode = 'plugin.invalidManifest' | 'plugin.duplicateId' | 'plugin.engineMismatch' | 'plugin.duplicateProvider' | 'plugin.cycle' | 'plugin.unresolved';

export interface ResolutionResult {
  /** Position in the input list. */
  readonly index: number;
  readonly id: string;
  readonly state: ResolutionState;
  /** The error code behind `invalid` or `unresolved`. */
  readonly code: ResolutionCode | undefined;
  readonly problems: readonly string[];
  readonly manifest: PluginManifest | undefined;
  /** Plugins that must activate first: `dependencies` plus the providers of `requires` and (present) `optional` tokens. */
  readonly dependsOn: readonly string[];
  /** The subset of dependsOn that comes only from `optional` tokens: a failure there does not fail this plugin. */
  readonly optionalOnly: readonly string[];
}

export interface ResolveInput {
  /** In the order the plugins were added. A later duplicate provider loses. */
  readonly descriptions: ReadonlyArray<PluginDescription>;
  /** The version of @tessera/plugin-api that `engines.tessera` is checked against. */
  readonly apiVersion: string;
  /** Every token id the core registers (contracts CoreTokenIds). A plugin cannot provide them; the `tessera.` prefix is reserved too. */
  readonly coreTokens: ReadonlySet<string>;
  /** The subset of core tokens a plugin may require without a plugin provider (PublicTokens). Default: coreTokens. */
  readonly publicTokens?: ReadonlySet<string>;
  /** Plugins that must be treated as valid even if their manifest changed meanwhile (already active). */
  readonly supportedHosts?: ReadonlySet<string>;
}

interface Node {
  readonly index: number;
  readonly description: PluginDescription;
  manifest: PluginManifest | undefined;
  state: ResolutionState;
  code: ResolutionCode | undefined;
  problems: string[];
  dependsOn: Set<string>;
  optionalOnly: Set<string>;
}

/**
 * Pure resolution (contracts.md 14.5): validate, check engines, find duplicate providers, build the graph,
 * run Kahn's algorithm, and mark missing dependencies. The input order decides which provider wins.
 */
export function resolvePlugins(input: ResolveInput): { readonly results: ReadonlyMap<string, ResolutionResult>; readonly order: readonly string[] } {
  const supportedHosts = input.supportedHosts ?? new Set(['in-process']);
  const nodes = new Map<string, Node>();
  const idOf = (d: PluginDescription): string => (typeof (d.manifest as { id?: unknown } | undefined)?.id === 'string' ? d.manifest.id : `?${nodes.size}`);

  // 1. validate manifest, engines range, host and trust
  for (const [index, description] of input.descriptions.entries()) {
    const parsed = parseManifest(description.manifest);
    const id = idOf(description);
    const node: Node = { index, description, manifest: undefined, state: 'resolved', code: undefined, problems: [], dependsOn: new Set(), optionalOnly: new Set() };
    const earlier = nodes.get(id);
    if (earlier) {
      node.state = 'invalid';
      node.code = 'plugin.duplicateId';
      node.problems.push(`plugin.duplicateId: id "${id}" is used by an earlier plugin (${earlier.description.source}); this one (${description.source}) is ignored. Precedence: builtin, dev, user, then the install date`);
      nodes.set(`${id}#duplicate${nodes.size}`, node);
      continue;
    }
    nodes.set(id, node);
    // Engines first, on the raw JSON: a newer plugin on an older host must say "engineMismatch" (needs a newer app), not "invalid manifest",
    // even when it uses fields this host does not know yet.
    const rawEngines = (description.manifest as { engines?: { tessera?: unknown } } | undefined)?.engines?.tessera;
    if (typeof rawEngines === 'string' && isRealRange(rawEngines) && !semver.satisfies(input.apiVersion, rawEngines, { includePrerelease: true })) {
      node.state = 'invalid';
      node.code = 'plugin.engineMismatch';
      node.problems.push(`plugin.engineMismatch: needs @tessera/plugin-api ${rawEngines}, this app has ${input.apiVersion}`);
      continue;
    }
    if (!KNOWN_SOURCES.has(description.source)) {
      // Fail closed: a typo in a catalog ("usr") must not turn into a trusted or an unrestricted plugin.
      node.state = 'invalid';
      node.code = 'plugin.invalidManifest';
      node.problems.push(`plugin.invalidManifest: unknown plugin source "${String(description.source)}" (known: builtin, user, dev)`);
      continue;
    }
    if (!parsed.ok) {
      node.state = 'invalid';
      node.code = 'plugin.invalidManifest';
      node.problems.push(...parsed.problems.map((p) => `plugin.invalidManifest: ${p}`));
      continue;
    }
    node.manifest = parsed.manifest;
    node.problems.push(...parsed.warnings);
    const manifest = parsed.manifest;
    if (!semver.satisfies(input.apiVersion, manifest.engines.tessera, { includePrerelease: true })) {
      node.state = 'invalid';
      node.code = 'plugin.engineMismatch';
      node.problems.push(`plugin.engineMismatch: needs @tessera/plugin-api ${manifest.engines.tessera}, this app has ${input.apiVersion}`);
      continue;
    }
    if (!supportedHosts.has(manifest.host ?? 'in-process')) {
      node.state = 'invalid';
      node.code = 'plugin.invalidManifest';
      node.problems.push(`plugin.invalidManifest: host "${manifest.host}" is not supported in v1 (in-process only)`);
      continue;
    }
    if (manifest.trust === 'first-party' && description.source !== 'builtin') {
      node.state = 'invalid';
      node.code = 'plugin.invalidManifest';
      node.problems.push('plugin.invalidManifest: trust "first-party" is accepted only for builtin plugins');
    }
  }

  const live = (): Array<[string, Node]> => [...nodes].filter(([, n]) => n.state !== 'invalid' && n.manifest);

  // 2. duplicate providers: the plugin added later becomes invalid. No silent override. A rejected plugin provides nothing.
  const providers = new Map<string, string>();
  for (const [id, node] of live()) {
    const tokens = node.manifest?.provides ?? [];
    const reserved = (t: string): boolean => input.coreTokens.has(t) || t.startsWith(CORE_TOKEN_PREFIX);
    const clash = tokens.find((t) => reserved(t) || (providers.has(t) && providers.get(t) !== id));
    if (clash !== undefined) {
      const by = reserved(clash) ? 'the core' : `"${providers.get(clash)}"`;
      markInvalid(node, 'plugin.duplicateProvider', `plugin.duplicateProvider: token "${clash}" is already provided by ${by}`);
      continue;
    }
    for (const token of tokens) providers.set(token, id);
  }

  // 2b. multi tokens: many plugins may contribute to one token (manifest contributesTo). They are never a duplicate provider.
  const contributors = new Map<string, string[]>();
  for (const [id, node] of live()) {
    for (const token of node.manifest?.contributesTo ?? []) {
      if (token.startsWith(CORE_TOKEN_PREFIX) || input.coreTokens.has(token)) {
        node.problems.push(`plugin.invalidContribution: contributesTo "${token}" is a core token id; the entry is ignored`);
        continue;
      }
      contributors.set(token, [...(contributors.get(token) ?? []), id]);
    }
  }

  // 3. edges and missing dependencies
  for (const [id, node] of live()) {
    const manifest = node.manifest as PluginManifest;
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      const target = nodes.get(dep);
      if (!target?.manifest || target.state === 'invalid') {
        markUnresolved(node, `plugin.unresolved: dependency "${dep}" ${target ? 'is invalid' : 'is not installed'}`);
      } else if (!semver.satisfies(target.manifest.version, range, { includePrerelease: true })) {
        markUnresolved(node, `plugin.unresolved: dependency "${dep}" is ${target.manifest.version}, needed ${range}`);
      } else {
        node.dependsOn.add(dep);
        node.optionalOnly.delete(dep);
      }
    }
    for (const token of manifest.requires ?? []) {
      const provider = providers.get(token);
      if (provider !== undefined && provider !== id) {
        node.dependsOn.add(provider);
        node.optionalOnly.delete(provider);
      } else if (provider === undefined && contributors.has(token)) {
        // a multi token: the contributors come first, but a missing or disabled one is no error (an optional edge)
        for (const contributor of contributors.get(token) ?? []) {
          if (contributor !== id && !node.dependsOn.has(contributor)) {
            node.dependsOn.add(contributor);
            node.optionalOnly.add(contributor);
          }
        }
      } else if (provider === undefined && !(input.publicTokens ?? input.coreTokens).has(token)) markUnresolved(node, `plugin.unresolved: no provider for required token "${token}"`);
    }
    for (const token of manifest.optional ?? []) {
      for (const contributor of contributors.get(token) ?? []) {
        if (contributor !== id && !node.dependsOn.has(contributor)) {
          node.dependsOn.add(contributor);
          node.optionalOnly.add(contributor);
        }
      }
      const provider = providers.get(token);
      if (provider !== undefined && provider !== id && !node.dependsOn.has(provider)) {
        node.dependsOn.add(provider);
        node.optionalOnly.add(provider);
      }
    }
  }

  // 4. Kahn on the hard edges (dependencies, requires): whatever stays in a cycle is invalid, with the path. An optional edge
  // only orders the activation: it is added when it makes no cycle and dropped, with a problem, when it would.
  const kahn = (graph: ReadonlyMap<string, readonly string[]>): { order: string[]; leftover: string[] } => {
    const indegree = new Map<string, number>();
    for (const [id, deps] of graph) indegree.set(id, deps.filter((d) => graph.has(d)).length);
    const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      order.push(id);
      for (const [other, deps] of graph) {
        if (deps.includes(id)) {
          const left = (indegree.get(other) ?? 0) - 1;
          indegree.set(other, left);
          if (left === 0) queue.push(other);
        }
      }
    }
    return { order, leftover: [...graph.keys()].filter((id) => !order.includes(id)) };
  };
  const edges = new Map<string, string[]>();
  for (const [id, node] of live()) edges.set(id, [...node.dependsOn].filter((d) => !node.optionalOnly.has(d) && (nodes.get(d)?.state !== 'invalid')));
  const hard = kahn(edges);
  const inCycle = hard.leftover;
  for (const id of inCycle) {
    // Only a real member of a cycle is invalid: a plugin that merely depends on one has leftover indegree too, so it is told apart here
    const path = findCycle(id, edges, new Set(inCycle));
    if (path.length > 1 && path[0] === path[path.length - 1] && path.slice(0, -1).includes(id)) markInvalid(nodes.get(id) as Node, 'plugin.cycle', `plugin.cycle: ${path.join(' -> ')}`);
  }
  // Leftovers that are not on a cycle depend on cyclic plugins: unresolved, with the name of the cyclic one
  for (const id of inCycle) {
    const node = nodes.get(id) as Node;
    if (node.state === 'invalid') continue;
    const cyclic = [...(edges.get(id) ?? [])].find((d) => nodes.get(d)?.state === 'invalid' || inCycle.includes(d));
    markUnresolved(node, `plugin.unresolved: depends on cyclic plugin "${cyclic ?? '?'}"`);
  }
  for (const id of [...edges.keys()]) if (nodes.get(id)?.state === 'invalid') edges.delete(id);
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some((next) => reaches(next, target, seen));
  };
  for (const [id, node] of live()) {
    if (!edges.has(id)) continue;
    for (const dep of [...node.optionalOnly]) {
      if (!edges.has(dep)) continue; // an invalid provider: no ordering to keep
      if (reaches(dep, id)) {
        node.dependsOn.delete(dep);
        node.optionalOnly.delete(dep);
        node.problems.push(`plugin.cycle: optional dependency "${dep}" is ignored: it would make a cycle (${id} -> ${dep} -> ... -> ${id})`);
      } else (edges.get(id) as string[]).push(dep);
    }
  }
  const finalGraph = new Map<string, string[]>();
  for (const [id, deps] of edges) if (nodes.get(id)?.state !== 'invalid' && nodes.get(id)?.state !== 'unresolved') finalGraph.set(id, deps.filter((d) => nodes.get(d)?.state !== 'invalid'));
  const order = kahn(finalGraph).order;
  const finalOrder = order.filter((id) => nodes.get(id)?.state !== 'invalid');

  // 5. propagate unresolved/invalid along the dependency edges until nothing changes
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of finalOrder) {
      const node = nodes.get(id) as Node;
      if (node.state !== 'resolved') continue;
      for (const dep of node.dependsOn) {
        if (node.optionalOnly.has(dep)) continue; // an optional provider may be broken without harming this plugin
        const target = nodes.get(dep) as Node;
        if (target.state === 'invalid') {
          markUnresolved(node, `plugin.unresolved: dependency "${dep}" is invalid`);
          changed = true;
        } else if (target.state === 'unresolved') {
          markUnresolved(node, `plugin.unresolved: dependency "${dep}" is unresolved`);
          changed = true;
        }
      }
    }
  }

  const results = new Map<string, ResolutionResult>();
  for (const [key, node] of nodes) {
    results.set(key, {
      index: node.index,
      id: node.manifest?.id ?? idOf(node.description),
      state: node.state,
      code: node.code,
      problems: node.problems,
      manifest: node.manifest,
      dependsOn: [...node.dependsOn],
      optionalOnly: [...node.optionalOnly],
    });
  }
  return { results, order: finalOrder.filter((id) => nodes.get(id)?.state === 'resolved') };
}

function markInvalid(node: Node, code: ResolutionCode, problem: string): void {
  node.state = 'invalid';
  node.code = code;
  node.problems.push(problem);
}

function markUnresolved(node: Node, problem: string): void {
  if (node.state === 'invalid') return;
  node.state = 'unresolved';
  node.code ??= 'plugin.unresolved';
  if (!node.problems.includes(problem)) node.problems.push(problem);
}

function findCycle(start: string, graph: ReadonlyMap<string, readonly string[]>, members: ReadonlySet<string>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): string[] | undefined => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (seen.has(id)) return undefined;
    seen.add(id);
    path.push(id);
    for (const next of graph.get(id) ?? []) {
      if (!members.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    return undefined;
  };
  return visit(start) ?? [start, start];
}

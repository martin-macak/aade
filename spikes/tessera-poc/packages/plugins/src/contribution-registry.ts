import { Emitter, TesseraError, reportError, toDisposable, type Event, type IDisposable } from '@tessera/base';
import type { Contribution, ContributionHandler, ContributionPoint, ContributionRegistry, PluginManifest } from '@tessera/contracts';
import { state, transact, type Observable, type State } from '@tessera/reactive';

interface PointEntry {
  readonly point: ContributionPoint<unknown>;
  readonly handler: ContributionHandler<unknown> | undefined;
  readonly applied: Map<string, IDisposable>;
}

/** The entry that owns a contested id (command, view, setting, workspace id of one point). */
interface Claim {
  readonly pluginId: string;
  readonly pointId: string;
  readonly index: number;
  readonly value: unknown;
}

/** An entry that lost a contested id. It returns when the owner goes away (I29: owners are a function of the installed set). */
interface Dropped {
  readonly ownerKey: string;
  readonly pointId: string;
  readonly index: number;
  readonly value: unknown;
  readonly problem: string;
}

interface PluginEntries {
  readonly manifest: PluginManifest;
  readonly problems: string[];
  readonly dropped: Dropped[];
  /** The activation events of the plugin, computed once while its entries are applied (one validation per entry). */
  readonly events: Set<string>;
  /** `events` as an array, rebuilt only when an event is added. */
  list: readonly string[];
}

const NO_PLUGINS: ReadonlySet<string> = new Set();

const keyOf = (pluginId: string, pointId: string, index: number): string => `${pluginId}\u0000${pointId}\u0000${index}`;

/**
 * Points, held entries and applied contributions (contracts.md 14.2).
 * Entries of a plugin are applied when the plugin becomes resolved (`applyPlugin`) and removed when it is
 * disabled, removed or invalid (`removePlugin`). Entries for a point that is not defined yet are held.
 */
export class DefaultContributionRegistry implements ContributionRegistry, IDisposable {
  readonly onDidChange: Event<{ readonly pointId: string }>;
  /** Fires with the plugin id when a problem is added after the plugin was applied (the plugin manager republishes that status). */
  readonly onDidAddProblem: Event<string>;

  readonly #changed = new Emitter<{ readonly pointId: string }>({ name: 'contributions.change', deferInTransaction: false });
  readonly #problemAdded = new Emitter<string>({ name: 'contributions.problem', deferInTransaction: false });
  readonly #points = new Map<string, PointEntry>();
  readonly #plugins = new Map<string, PluginEntries>();
  readonly #lists = new Map<string, State<readonly Contribution<unknown>[]>>();
  /** `<pointId> <identity>` -> the entry that owns the id: the best-ranked declarer (builtin, dev, user, then install date, then id). */
  readonly #owners = new Map<string, Claim>();
  /** Declared contribution point id -> the plugins whose manifest declares it (`contributionPoints`). The best-ranked one may define it. */
  readonly #pointClaims = new Map<string, Set<string>>();
  /** true when plugin `a` ranks before plugin `b`. Set by the plugin manager; without it the first applied plugin keeps an id. */
  #better: (a: string, b: string) => boolean = () => false;
  /** event -> the plugins that declare it. activateByEvent looks events up here instead of scanning every plugin. */
  readonly #byEvent = new Map<string, Set<string>>();
  /** Counter for the performance tests: how many entry validations ran (one per entry and apply, never per status publication). */
  validations = 0;

  constructor() {
    this.onDidChange = this.#changed.event;
    this.onDidAddProblem = this.#problemAdded.event;
  }

  /** The plugin manager gives the install ranking (builtin, dev, user, install date, id). */
  setRanking(better: (a: string, b: string) => boolean): void {
    this.#better = better;
  }

  /** The plugin that may define the declared point id: the best-ranked plugin that declares it in `contributionPoints`. */
  declaredPointOwner(pointId: string): string | undefined {
    let best: string | undefined;
    for (const id of this.#pointClaims.get(pointId) ?? []) if (best === undefined || this.#better(id, best)) best = id;
    return best;
  }

  /** Declared point ids that have an owner (an installed, enabled declarer). */
  declaredPointIds(): ReadonlySet<string> {
    return new Set(this.#pointClaims.keys());
  }

  // ----- points --------------------------------------------------------------------------------

  definePoint<T>(point: ContributionPoint<T>, handler?: ContributionHandler<T>): IDisposable {
    if (this.#points.has(point.id)) throw new Error(`Contribution point "${point.id}" is already defined`);
    const entry: PointEntry = {
      point: point as ContributionPoint<unknown>,
      handler: handler as ContributionHandler<unknown> | undefined,
      applied: new Map(),
    };
    this.#points.set(point.id, entry);
    for (const [pluginId, plugin] of this.#plugins) this.#applyPointEntries(pluginId, plugin, entry);
    this.#changed.fire({ pointId: point.id });
    return toDisposable(() => {
      if (this.#points.get(point.id) !== entry) return;
      this.#points.delete(point.id);
      for (const d of [...entry.applied.values()].reverse()) this.#safeDispose(d, point.id);
      entry.applied.clear();
      this.#listState(point.id).set([]);
      this.#changed.fire({ pointId: point.id });
    });
  }

  points(): readonly ContributionPoint<unknown>[] {
    return [...this.#points.values()].map((p) => p.point);
  }

  get<T>(point: ContributionPoint<T>): Observable<readonly Contribution<T>[]> {
    return this.#listState(point.id).asReadonly() as Observable<readonly Contribution<T>[]>;
  }

  #listState(pointId: string): State<readonly Contribution<unknown>[]> {
    let s = this.#lists.get(pointId);
    if (!s) {
      s = state<readonly Contribution<unknown>[]>([], { name: `contributions:${pointId}` });
      this.#lists.set(pointId, s);
    }
    return s;
  }

  // ----- plugin entries ------------------------------------------------------------------------

  /** Validates and applies every entry of the manifest whose point is defined. Returns the problems found. */
  applyPlugin(manifest: PluginManifest): readonly string[] {
    this.removePlugin(manifest.id);
    const plugin: PluginEntries = { manifest, problems: [], dropped: [], events: new Set(), list: [] };
    this.#plugins.set(manifest.id, plugin);
    for (const declared of manifest.contributionPoints ?? []) {
      const claimants = this.#pointClaims.get(declared.id) ?? new Set<string>();
      claimants.add(manifest.id);
      this.#pointClaims.set(declared.id, claimants);
    }
    for (const event of manifest.activationEvents ?? []) this.#addEvent(manifest.id, plugin, event);
    for (const token of manifest.provides ?? []) this.#addEvent(manifest.id, plugin, `onService:${token}`);
    for (const point of this.#points.values()) this.#applyPointEntries(manifest.id, plugin, point);
    return plugin.problems;
  }

  /** Removes every applied contribution of the plugin (reverse order). */
  removePlugin(pluginId: string): void {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) return;
    this.#plugins.delete(pluginId);
    for (const event of plugin.events) {
      const set = this.#byEvent.get(event);
      set?.delete(pluginId);
      if (set?.size === 0) this.#byEvent.delete(event);
    }
    for (const declared of plugin.manifest.contributionPoints ?? []) {
      const claimants = this.#pointClaims.get(declared.id);
      claimants?.delete(pluginId);
      if (claimants?.size === 0) this.#pointClaims.delete(declared.id);
    }
    const freed: string[] = [];
    for (const [key, owner] of [...this.#owners]) {
      if (owner.pluginId !== pluginId) continue;
      this.#owners.delete(key);
      freed.push(key);
    }
    for (const [pointId, point] of this.#points) {
      let touched = false;
      for (const [key, disposable] of [...point.applied].reverse()) {
        if (!key.startsWith(`${pluginId}\u0000`)) continue;
        point.applied.delete(key);
        this.#safeDispose(disposable, pointId);
        touched = true;
      }
      if (touched) {
        this.#listState(pointId).update((list) => list.filter((c) => c.pluginId !== pluginId));
        this.#changed.fire({ pointId });
      }
    }
    // The ids this plugin owned go to the best-ranked entry that lost them (a dropped duplicate returns when the owner goes away).
    for (const key of freed) this.#promote(key);
  }

  /** Gives a freed id to the best-ranked plugin that holds a dropped entry for it. */
  #promote(ownerKey: string): void {
    let best: { readonly plugin: PluginEntries; readonly dropped: Dropped } | undefined;
    for (const plugin of this.#plugins.values()) {
      const dropped = plugin.dropped.find((d) => d.ownerKey === ownerKey);
      if (dropped && (best === undefined || this.#better(plugin.manifest.id, best.plugin.manifest.id))) best = { plugin, dropped };
    }
    if (!best) return;
    const point = this.#points.get(best.dropped.pointId);
    if (!point) return;
    best.plugin.dropped.splice(best.plugin.dropped.indexOf(best.dropped), 1);
    const at = best.plugin.problems.indexOf(best.dropped.problem);
    if (at >= 0) best.plugin.problems.splice(at, 1);
    this.#applyEntry(best.plugin, point, best.dropped.index, best.dropped.value, ownerKey);
    this.#problemAdded.fire(best.plugin.manifest.id); // the status of the plugin changes (the problem is gone)
  }

  /** The owner lost the id to a better-ranked plugin: its entry is removed and kept as a dropped duplicate. */
  #evict(claim: Claim, ownerKey: string, newOwner: string): void {
    const point = this.#points.get(claim.pointId);
    const plugin = this.#plugins.get(claim.pluginId);
    const key = keyOf(claim.pluginId, claim.pointId, claim.index);
    const disposable = point?.applied.get(key);
    if (point && disposable) {
      point.applied.delete(key);
      this.#safeDispose(disposable, claim.pointId);
      this.#listState(claim.pointId).update((list) => list.filter((c) => !(c.pluginId === claim.pluginId && c.index === claim.index)));
      this.#changed.fire({ pointId: claim.pointId });
    }
    if (!plugin) return;
    const identity = ownerKey.slice(ownerKey.indexOf('\u0000') + 1);
    const problem = `plugin.duplicateContribution: ${claim.pointId}[${claim.index}] id "${identity}" is already contributed by "${newOwner}"; this entry is ignored`;
    plugin.dropped.push({ ownerKey, pointId: claim.pointId, index: claim.index, value: claim.value, problem });
    if (!plugin.problems.includes(problem)) {
      plugin.problems.push(problem);
      this.#problemAdded.fire(claim.pluginId);
    }
  }

  /** Adds a problem to a plugin's status (a point id that clashes, a late problem). */
  addProblem(pluginId: string, problem: string): void {
    const plugin = this.#plugins.get(pluginId);
    if (plugin && !plugin.problems.includes(problem)) {
      plugin.problems.push(problem);
      this.#problemAdded.fire(pluginId);
    }
  }

  /** Problems collected while applying the plugin's entries. */
  problemsOf(pluginId: string): readonly string[] {
    return this.#plugins.get(pluginId)?.problems ?? [];
  }

  /** Point ids that the plugin contributes to but nobody defined. */
  unknownPointsOf(pluginId: string): readonly string[] {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) return [];
    return Object.keys(plugin.manifest.contributes ?? {}).filter((id) => !this.#points.has(id));
  }

  /** The activation events of a plugin (manifest, provided services, and the ones its entries imply). Cached: no validation here. */
  activationEvents(pluginId: string): readonly string[] {
    return this.#plugins.get(pluginId)?.list ?? [];
  }

  /** The plugins that declare an activation event. O(1): the reverse index. */
  pluginsForEvent(event: string): ReadonlySet<string> {
    return this.#byEvent.get(event) ?? NO_PLUGINS;
  }

  #addEvent(pluginId: string, plugin: PluginEntries, event: string): void {
    if (plugin.events.has(event)) return;
    plugin.events.add(event);
    plugin.list = [...plugin.events];
    const set = this.#byEvent.get(event) ?? new Set<string>();
    set.add(pluginId);
    this.#byEvent.set(event, set);
  }

  #applyPointEntries(pluginId: string, plugin: PluginEntries, point: PointEntry): void {
    const entries = plugin.manifest.contributes?.[point.point.id];
    if (!entries) return;
    const added: Contribution<unknown>[] = [];
    /** Entries for a handler with applyAll: applied together after validation, in one transaction. */
    const batch: Array<{ readonly index: number; readonly value: unknown; readonly ownerKey: string | undefined }> = [];
    entries.forEach((raw, index) => {
      this.validations++;
      const parsed = point.point.schema.safeParse(raw); // the one validation of this entry
      if (!parsed.success) {
        plugin.problems.push(`plugin.invalidContribution: ${point.point.id}[${index}] ${parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ')}`);
        return;
      }
      // Identifier ownership: the best-ranked declarer owns an id (builtin, dev, user, install date, id), whatever the order of events was.
      // A worse-ranked duplicate is dropped with a problem; the plugin still resolves. It returns when the owner goes away.
      const identity = point.point.identity?.(parsed.data);
      const ownerKey = identity === undefined ? undefined : `${point.point.id}\u0000${identity}`;
      if (ownerKey !== undefined) {
        const owner = this.#owners.get(ownerKey);
        if (owner !== undefined && owner.pluginId !== pluginId) {
          if (!this.#better(pluginId, owner.pluginId)) {
            const problem = `plugin.duplicateContribution: ${point.point.id}[${index}] id "${identity}" is already contributed by "${owner.pluginId}"; this entry is ignored`;
            plugin.problems.push(problem);
            plugin.dropped.push({ ownerKey, pointId: point.point.id, index, value: parsed.data, problem });
            return;
          }
          this.#evict(owner, ownerKey, pluginId);
        }
      }
      if (point.handler?.applyAll) batch.push({ index, value: parsed.data, ownerKey });
      else this.#applyEntry(plugin, point, index, parsed.data, ownerKey, added);
    });
    if (batch.length > 0) this.#applyBatch(plugin, point, batch, added);
    if (added.length > 0) {
      this.#listState(point.point.id).update((list) => [...list, ...added]);
      this.#changed.fire({ pointId: point.point.id });
    }
  }

  /** Applies the validated entries of one plugin and point through `handler.applyAll`: one call inside one transaction. */
  #applyBatch(plugin: PluginEntries, point: PointEntry, batch: ReadonlyArray<{ readonly index: number; readonly value: unknown; readonly ownerKey: string | undefined }>, added: Contribution<unknown>[]): void {
    const pluginId = plugin.manifest.id;
    const contributions = batch.map((b) => Object.freeze({ pluginId, pointId: point.point.id, index: b.index, value: b.value }) as Contribution<unknown>);
    for (const b of batch) {
      if (!point.point.activationEvents) break;
      try {
        for (const event of point.point.activationEvents(b.value)) this.#addEvent(pluginId, plugin, event);
      } catch (error) {
        reportError(error, { source: 'activation', pluginId, target: `activationEvents:${point.point.id}` });
      }
    }
    let results: ReadonlyArray<IDisposable | Error>;
    try {
      results = transact(() => (point.handler as ContributionHandler<unknown> & { applyAll(c: readonly Contribution<unknown>[]): ReadonlyArray<IDisposable | Error> }).applyAll(contributions));
    } catch (error) {
      results = batch.map(() => (error instanceof Error ? error : new Error(String(error))));
    }
    batch.forEach((b, i) => {
      const outcome = results[i];
      const contribution = contributions[i] as Contribution<unknown>;
      if (outcome !== undefined && !(outcome instanceof Error)) {
        point.applied.set(keyOf(pluginId, point.point.id, b.index), outcome);
        if (b.ownerKey !== undefined) this.#owners.set(b.ownerKey, { pluginId, pointId: point.point.id, index: b.index, value: b.value });
        added.push(contribution);
        return;
      }
      const error = outcome ?? new Error('the handler returned no result for this entry');
      if (error instanceof TesseraError && error.code === 'plugin.duplicateContribution') {
        plugin.problems.push(`plugin.duplicateContribution: ${point.point.id}[${b.index}] ${error.message}; this entry is ignored`);
        return;
      }
      plugin.problems.push(`plugin.invalidContribution: ${point.point.id}[${b.index}] could not be applied: ${error.message}`);
      reportError(error, { source: 'activation', pluginId, target: `contribution:${point.point.id}` });
    });
  }

  /** Applies one validated entry whose id (if any) is free for this plugin. Returns the contribution, or undefined when the handler refused it. */
  #applyEntry(plugin: PluginEntries, point: PointEntry, index: number, value: unknown, ownerKey: string | undefined, batch?: Contribution<unknown>[]): Contribution<unknown> | undefined {
    const pluginId = plugin.manifest.id;
    const contribution: Contribution<unknown> = Object.freeze({ pluginId, pointId: point.point.id, index, value });
    // the activation events this entry implies are computed here, once (a command gives onCommand:<id>)
    if (point.point.activationEvents) {
      try {
        for (const event of point.point.activationEvents(value)) this.#addEvent(pluginId, plugin, event);
      } catch (error) {
        reportError(error, { source: 'activation', pluginId, target: `activationEvents:${point.point.id}` });
      }
    }
    try {
      const disposable = point.handler ? point.handler.apply(contribution) : toDisposable(() => {});
      point.applied.set(keyOf(pluginId, point.point.id, index), disposable);
      if (ownerKey !== undefined) this.#owners.set(ownerKey, { pluginId, pointId: point.point.id, index, value });
      if (batch) batch.push(contribution);
      else {
        // a late entry (a promotion): the list and the listeners learn about it here
        this.#listState(point.point.id).update((list) => [...list, contribution]);
        this.#changed.fire({ pointId: point.point.id });
      }
      return contribution;
    } catch (error) {
      if (error instanceof TesseraError && error.code === 'plugin.duplicateContribution') {
        // another owner holds the id (the core, or a registration outside the manifests): a problem, not an error report
        plugin.problems.push(`plugin.duplicateContribution: ${point.point.id}[${index}] ${error.message}; this entry is ignored`);
        return undefined;
      }
      plugin.problems.push(`plugin.invalidContribution: ${point.point.id}[${index}] could not be applied: ${error instanceof Error ? error.message : String(error)}`);
      reportError(error, { source: 'activation', pluginId, target: `contribution:${point.point.id}` });
      return undefined;
    }
  }

  #safeDispose(d: IDisposable, pointId: string): void {
    try {
      d.dispose();
    } catch (error) {
      reportError(error, { source: 'dispose', target: `contribution:${pointId}` });
    }
  }

  dispose(): void {
    for (const [pointId, point] of this.#points) {
      for (const d of [...point.applied.values()].reverse()) this.#safeDispose(d, pointId);
      point.applied.clear();
    }
    this.#points.clear();
    this.#plugins.clear();
    this.#changed.dispose();
    this.#problemAdded.dispose();
  }
}

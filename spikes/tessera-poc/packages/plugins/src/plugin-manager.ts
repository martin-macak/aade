import {
  Emitter,
  TesseraError,
  getScheduler,
  isDevMode,
  reportError,
  serializeError,
  withTimeout,
  type Event,
  type IDisposable,
  type StateSchema,
} from '@tessera/base';
import {
  ContextKeyService,
  ContributionRegistry,
  CoreTokenIds,
  CoreTopics,
  EventBus,
  HostEnvironment,
  InterceptorRegistry,
  Logger,
  PLUGINS_DISABLED_STORAGE_KEY,
  PluginCatalog,
  PluginState,
  PublicTokens,
  StorageService,
  TESSERA_API_VERSION,
  type DeactivateReason,
  type FailureCause,
  type PluginDescription,
  type PluginHostKind,
  type PluginManager,
  type PluginManifest,
  type PluginSource,
  type PluginStatus,
  type PluginTrust,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { state, type Observable, type State } from '@tessera/reactive';
import type { DefaultContributionRegistry } from './contribution-registry.ts';
import { InProcessPluginHost, PluginActivationError, type HostDeactivateOptions } from './host.ts';
import { decideCapabilities, hostServicesOf } from './policy.ts';
import { isAllowedTransition } from './plugin-transitions.ts';
import { resolvePlugins, type ResolutionCode, type ResolutionResult } from './resolver.ts';

const PUBLIC_TOKENS: ReadonlySet<string> = new Set(PublicTokens.map((t) => t.id));

export interface PluginManagerOptions {
  /** The @tessera/plugin-api version that `engines.tessera` is checked against. */
  readonly apiVersion?: string;
  readonly activateTimeoutMs?: number;
  readonly deactivateTimeoutMs?: number;
  /** Longest wait for the import of a plugin entry. Default 10 s. */
  readonly loadTimeoutMs?: number;
}

interface PluginRank {
  readonly source: number;
  readonly installedAt: number;
  readonly id: string;
}

/** Install precedence by source: builtin first (security), dev before user (as in VS Code), then the date, then the id. */
const SOURCE_RANK: Readonly<Record<string, number>> = { builtin: 0, dev: 1, user: 2 };

function compareRank(a: PluginRank, b: PluginRank): number {
  return a.source - b.source || a.installedAt - b.installedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface PluginRecord {
  description: PluginDescription;
  readonly seq: number;
  /** Install precedence. Kept across updates (a new version of a plugin does not lose its place). */
  readonly rank: PluginRank;
  state: PluginState;
  problems: string[];
  dependsOn: readonly string[];
  optionalOnly: readonly string[];
  failure: { cause: FailureCause; error: ReturnType<typeof serializeError>; count: number } | undefined;
  failureCount: number;
  activationReason: string | undefined;
  activationTimeMs: number | undefined;
  pending: Promise<void> | undefined;
  /** Set while the plugin goes Active to Resolved (deactivation). A consumer that activates meanwhile waits for it. */
  transition: Promise<void> | undefined;
  contributed: boolean;
  /** Set while the plugin is disabled by the user. */
  disabled: boolean;
  /** Set by disable(): the plugin and the dependents that were active, providers first. enable() activates them again (contracts 14.12). */
  reactivateOnEnable: readonly string[] | undefined;
  reloads: number;
}

/** Reads the state without TypeScript's flow narrowing (it can change while we await). */
function stateNow(record: PluginRecord): PluginState {
  return record.state;
}

const disabledSchema: StateSchema<readonly string[]> = {
  version: 1,
  schema: { safeParse: (i) => (Array.isArray(i) && i.every((x) => typeof x === 'string') ? { success: true, data: i as string[] } : { success: false, error: { issues: [{ path: [], message: 'expected string[]' }] } }) },
  initial: () => [],
};

/** A record that is running or on its way (it must not change its key). */
function isBusy(record: PluginRecord): boolean {
  return record.state === PluginState.Activating || record.state === PluginState.Active || record.state === PluginState.Deactivating || record.pending !== undefined || record.transition !== undefined;
}

/** Is `b` the same installed plugin as `a`? Same id (already known), same location without the reload query, same source and version. */
function sameInstall(a: PluginDescription, b: PluginDescription): boolean {
  const base = (location: string): string => location.split('?')[0] as string;
  const version = (d: PluginDescription): unknown => (d.manifest as { version?: unknown } | undefined)?.version;
  return base(a.location) === base(b.location) && a.source === b.source && version(a) === version(b);
}

/** Longest wait of add() for the storage that holds the disabled list. */
const STORAGE_WAIT_MS = 4000;

/** Plugin states, resolution, activation and deactivation (contracts.md 14.4 and 14.5). Window DI scope. */
export class DefaultPluginManager implements PluginManager, IDisposable {
  readonly plugins: Observable<ReadonlyMap<string, PluginStatus>>;
  readonly onDidChangeState: Event<PluginStatus>;
  readonly host: InProcessPluginHost;

  readonly #scope: Scope;
  readonly #registry: DefaultContributionRegistry;
  readonly #changed = new Emitter<PluginStatus>({ name: 'plugins.state', deferInTransaction: false });
  readonly #map: State<ReadonlyMap<string, PluginStatus>> = state<ReadonlyMap<string, PluginStatus>>(new Map(), { name: 'plugins.status' });
  readonly #records = new Map<string, PluginRecord>();
  readonly #apiVersion: string;
  #order: readonly string[] = [];
  #seq = 0;
  #catalogSub: IDisposable | undefined;
  readonly #problemSub: IDisposable;
  readonly #pointSub: IDisposable;
  readonly #disabledSub: IDisposable | undefined;
  #unknownReported = false;
  /** Depth of a removal that touches several points (removePlugin). The status is published once at its end. */
  #pointBatch = 0;
  #pointDirty = false;
  /** Dev report: how many times the status map was rebuilt because of point changes (a counter test reads it). */
  statusPublications = 0;
  /** Set by abortAll(): the shutdown gate. No activation starts after it (`plugin.shuttingDown`). */
  #closing = false;

  constructor(options?: PluginManagerOptions) {
    this.#scope = injectScope();
    this.#registry = this.#scope.get(ContributionRegistry) as DefaultContributionRegistry;
    this.#apiVersion = options?.apiVersion ?? TESSERA_API_VERSION;
    this.host = new InProcessPluginHost(this.#scope, {
      ...(options?.activateTimeoutMs !== undefined ? { activateTimeoutMs: options.activateTimeoutMs } : {}),
      ...(options?.deactivateTimeoutMs !== undefined ? { deactivateTimeoutMs: options.deactivateTimeoutMs } : {}),
      ...(options?.loadTimeoutMs !== undefined ? { loadTimeoutMs: options.loadTimeoutMs } : {}),
    });
    this.plugins = this.#map.asReadonly();
    this.onDidChangeState = this.#changed.event;
    // Ownership of a contested id is a function of the installed set: the registry asks for the install ranking (I29).
    this.#registry.setRanking((a, b) => {
      const ra = this.#records.get(a)?.rank;
      const rb = this.#records.get(b)?.rank;
      return ra !== undefined && rb !== undefined && compareRank(ra, rb) < 0;
    });
    // a problem that the registry adds later (a point id clash) shows in the status of that plugin
    this.#problemSub = this.#registry.onDidAddProblem((pluginId) => {
      this.#touch(pluginId);
      this.#publishAll();
    });
    this.#disabledSub = this.#watchDisabledList();
    // a point that gets defined (or removed) changes which entries are unknown
    this.#pointSub = this.#registry.onDidChange(() => {
      if (!this.#unknownReported) return;
      if (this.#pointBatch > 0) {
        this.#pointDirty = true; // one publication at the end of the batch, not one per point
        return;
      }
      this.#allStale = true; // which entries are unknown depends on the defined points: every status may change
      this.#publishAll();
    });
  }

  // ----- queries -------------------------------------------------------------------------------

  status(id: string): PluginStatus | undefined {
    return this.#map.peek().get(id);
  }

  isActive(pluginId: string): boolean {
    return this.#records.get(pluginId)?.state === PluginState.Active;
  }

  /** Dev-mode report of registrations that survived deactivation (must be empty). */
  liveDisposables(pluginId: string): readonly string[] {
    return this.host.liveDisposables(pluginId);
  }

  // ----- add, remove, resolve ------------------------------------------------------------------

  async add(descriptions: readonly PluginDescription[]): Promise<void> {
    // The disabled list lives in storage. Wait for the storage (bounded: it ends ready or degraded in about 4 s), so a plugin the user
    // disabled does not start enabled just because storage was slow. If it stays unavailable, say so and start with an empty list;
    // the list is applied again when storage recovers (see #watchDisabledList).
    await this.#whenStorageReady();
    const disabled = this.#readDisabled();
    for (const description of descriptions) {
      const id = (description.manifest as { id?: unknown } | undefined)?.id;
      const known = typeof id === 'string' ? this.#records.get(id) : undefined;
      if (known && sameInstall(known.description, description)) {
        // the same plugin twice (two catalog events, a double scan): one record, never a ghost
        reportError(new TesseraError('plugin.duplicateId', `Plugin "${String(id)}" from ${description.source} is already added; the second add is ignored`, { details: { id, source: description.source } }), { source: 'activation', pluginId: String(id), target: 'catalog.sync' });
        continue;
      }
      const key = typeof id === 'string' && !this.#records.has(id) ? id : `${typeof id === 'string' ? id : '?'}#${this.#seq}`;
      const record = this.#newRecord(description, typeof id === 'string' && disabled.has(id));
      this.#records.set(key, record);
      // The plugin that wins the id (by precedence) holds the plain id as its key, so activate(id) and status(id) talk to it.
      if (typeof id === 'string' && known && key !== id && compareRank(record.rank, known.rank) < 0 && !isBusy(known)) {
        if (known.contributed) {
          this.#removeContributions(id);
          known.contributed = false;
        }
        this.#records.set(id, record);
        this.#records.set(key, known);
      }
    }
    this.#resolveAll();
    await this.#catchUpStartup();
  }

  /** Removes the contributions of a plugin and publishes the status once: a plugin with ten points is one publication, not ten. */
  #removeContributions(key: string): void {
    this.#pointBatch++;
    try {
      this.#registry.removePlugin(key);
    } finally {
      this.#pointBatch--;
      if (this.#pointBatch === 0 && this.#pointDirty) {
        this.#pointDirty = false;
        this.#allStale = true;
        this.#publishAll();
      }
    }
  }

  async remove(id: string, reason: Extract<DeactivateReason, 'uninstall' | 'update'> = 'uninstall'): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    await this.deactivate(id, reason);
    this.#removeContributions(id);
    this.#records.delete(id);
    this.#publishAll();
    this.#resolveAll();
  }

  /** The install date that ranks a plugin id: remembered across updates, else the one the catalog gives, else the order of arrival. */
  readonly #installedAt = new Map<string, number>();
  #installClock = 0;

  #rankOf(description: PluginDescription): PluginRank {
    const id = (description.manifest as { id?: unknown } | undefined)?.id;
    // One install = one source and one folder: an update of it keeps its rank, a second folder with the same id is another install.
    const key = `${description.source}|${description.location.split('?')[0] as string}|${typeof id === 'string' ? id : ''}`;
    let installedAt = this.#installedAt.get(key);
    if (installedAt === undefined) {
      // a catalog date sorts before the arrival clock of plugins without one (dates are large numbers: use them as they are)
      installedAt = description.installedAt ?? Number.MAX_SAFE_INTEGER - 1_000_000 + this.#installClock++;
      this.#installedAt.set(key, installedAt);
    }
    return { source: SOURCE_RANK[description.source] ?? 9, installedAt, id: typeof id === 'string' ? id : '' };
  }

  #newRecord(description: PluginDescription, disabled: boolean): PluginRecord {
    return {
      description,
      seq: this.#seq++,
      rank: this.#rankOf(description),
      state: disabled ? PluginState.Disabled : PluginState.Discovered,
      problems: [],
      dependsOn: [],
      optionalOnly: [],
      failure: undefined,
      failureCount: 0,
      activationReason: undefined,
      activationTimeMs: undefined,
      pending: undefined,
      transition: undefined,
      contributed: false,
      disabled,
      reactivateOnEnable: undefined,
      reloads: 0,
    };
  }

  /** Validate, resolve and apply contributions for every plugin that is not running (14.5 resolution). */
  #resolveAll(): void {
    const included = [...this.#records.entries()].filter(([, r]) => !r.disabled).sort((a, b) => compareRank(a[1].rank, b[1].rank) || a[1].seq - b[1].seq);
    // The host product's services are core tokens too: a plugin cannot provide them, and `requires` of one resolves without a provider.
    const hostServices = hostServicesOf(this.#scope);
    const hostIds = [...hostServices.keys()];
    const { results, order } = resolvePlugins({
      descriptions: included.map(([, r]) => r.description),
      apiVersion: this.#apiVersion,
      coreTokens: hostIds.length === 0 ? CoreTokenIds : new Set([...CoreTokenIds, ...hostIds]),
      publicTokens: hostIds.length === 0 ? PUBLIC_TOKENS : new Set([...PUBLIC_TOKENS, ...hostIds]),
    });
    this.#order = order;
    this.#allStale = true; // resolution runs over every plugin anyway
    const byIndex = new Map<number, ResolutionResult>();
    for (const r of results.values()) byIndex.set(r.index, r);
    // One status publication for the whole pass: applying 1,000 plugins fires 1,000 point changes, and a publication per change is O(N^2).
    this.#pointBatch++;
    try {
      this.#applyResolved(included, byIndex, hostServices);
    } finally {
      this.#pointBatch--;
      if (this.#pointBatch === 0) this.#pointDirty = false;
    }
    this.#publishAll();
  }

  #applyResolved(included: ReadonlyArray<readonly [string, PluginRecord]>, byIndex: ReadonlyMap<number, ResolutionResult>, hostServices: ReturnType<typeof hostServicesOf>): void {
    included.forEach(([key, record], index) => {
      const result = byIndex.get(index);
      if (!result) return;
      record.dependsOn = result.dependsOn;
      record.optionalOnly = result.optionalOnly;
      const running: PluginState[] = [PluginState.Activating, PluginState.Active, PluginState.Deactivating, PluginState.Failed];
      if (running.includes(record.state)) return;
      record.problems = [...result.problems];
      if (result.manifest) {
        // The host policy decides which requested capabilities the plugin gets; the refused ones are visible in the status.
        for (const refused of decideCapabilities(this.#scope, record.description).refused) {
          record.problems.push(`plugin.capabilityDenied: capability "${refused}" is not granted to ${record.description.source} plugin "${result.manifest.id}"`);
        }
        for (const required of result.manifest.requires ?? []) {
          const needed = hostServices.get(required)?.capability;
          if (needed !== undefined && !decideCapabilities(this.#scope, record.description).granted.has(needed)) {
            record.problems.push(`plugin.capabilityDenied: service "${required}" needs capability "${needed}", which is not granted`);
          }
        }
      }
      if (result.state === 'resolved') {
        // The state is set first: applying a contribution may already ask for activation (a visible view).
        this.#setState(key, record, PluginState.Resolved);
        if (!record.contributed && result.manifest) {
          record.contributed = true;
          this.#registry.applyPlugin(result.manifest);
        }
      } else {
        if (record.contributed) {
          this.#removeContributions(key);
          record.contributed = false;
        }
        this.#setState(key, record, result.state === 'invalid' ? PluginState.Invalid : PluginState.Unresolved);
      }
    });
  }

  /**
   * At phase Ready: contributions for a point that nobody defined become problems (14.2 rule 3). A point that an installed plugin
   * declares in `contributionPoints` is not unknown: its entries wait until the definer runs. The problems follow the registry: when
   * the point is defined later, they disappear (they are computed in the status, not stored).
   */
  reportUnknownPoints(): void {
    this.#unknownReported = true;
    this.#allStale = true;
    this.#publishAll();
  }

  #declaredPoints(): ReadonlySet<string> {
    // The declared ids that have an owner among the contributed (resolved, enabled) plugins: the registry counts only the ranked declarer.
    return this.#registry.declaredPointIds();
  }

  #unknownPointProblems(key: string, declared: ReadonlySet<string>): string[] {
    if (!this.#unknownReported) return [];
    return this.#registry
      .unknownPointsOf(key)
      .filter((pointId) => !declared.has(pointId))
      .map((pointId) => `plugin.invalidContribution: unknown contribution point "${pointId}"`);
  }

  // ----- activation ----------------------------------------------------------------------------

  async activate(id: string, reason = 'api'): Promise<void> {
    const record = this.#records.get(id);
    if (!record) throw new TesseraError('plugin.unresolved', `Unknown plugin "${id}"`, { details: { id } });
    await this.#activateOne(id, record, reason);
  }

  async #activateOne(id: string, record: PluginRecord, reason: string): Promise<void> {
    if (record.state === PluginState.Active) return;
    if (this.#closing) throw new TesseraError('plugin.shuttingDown', `Plugin "${id}" cannot activate: the application is shutting down`, { details: { id } });
    if (record.pending) return record.pending;
    if (record.state !== PluginState.Resolved) {
      if (record.state === PluginState.Failed && record.failure) {
        throw new TesseraError('plugin.activationFailed', `Plugin "${id}" failed earlier (${record.failure.cause}); call retry() to try again`, { details: { id, cause: record.failure.cause } });
      }
      throw new TesseraError(record.state === PluginState.Unresolved ? 'plugin.unresolved' : 'plugin.activationFailed', `Plugin "${id}" cannot activate in state "${record.state}"`, { details: { id, state: record.state, problems: record.problems } });
    }
    const run = this.#doActivate(id, record, reason);
    record.pending = run;
    try {
      await run;
    } finally {
      record.pending = undefined;
    }
  }

  async #doActivate(id: string, record: PluginRecord, reason: string): Promise<void> {
    // Dependencies first (providers before consumers). The loop runs again until one pass finds every hard dependency Active
    // and not closing: a provider that closes meanwhile (hot reload, disable) is waited for, then activated again.
    for (let pass = 0; ; pass++) {
      let settled = true;
      for (const dep of record.dependsOn) {
        const depRecord = this.#records.get(dep);
        const optional = record.optionalOnly.includes(dep);
        if (!depRecord) continue;
        // The provider is on its way out: wait for it to end, then activate it again below.
        if (depRecord.transition) {
          settled = false;
          await depRecord.transition.catch(() => undefined);
        }
        if (stateNow(depRecord) === PluginState.Active) continue;
        settled = false;
        try {
          if (depRecord.state === PluginState.Resolved || depRecord.pending) await this.#activateOne(dep, depRecord, `dependency:${id}`);
          else if (!optional) throw new TesseraError('plugin.dependencyFailed', `Dependency "${dep}" is ${depRecord.state}`);
        } catch (error) {
          if (optional) continue;
          const failure = new PluginActivationError('dependencyFailed', `Dependency "${dep}" of plugin "${id}" failed`, error);
          this.#fail(id, record, failure);
          throw failure;
        }
        if (!optional && stateNow(depRecord) !== PluginState.Active) {
          const failure = new PluginActivationError('dependencyFailed', `Dependency "${dep}" of plugin "${id}" is ${depRecord.state}`, undefined);
          this.#fail(id, record, failure);
          throw failure;
        }
      }
      // After 5 passes a provider that is still changing state is taken as it is now (a bound, so a flapping provider cannot spin forever).
      if (settled || pass >= 5) break;
    }
    record.activationReason = reason;
    const started = getScheduler().now();
    this.#setState(id, record, PluginState.Activating);
    this.#publishAll();
    try {
      const interceptors = this.#scope.get(InterceptorRegistry, { optional: true });
      const manifest = record.description.manifest;
      if (interceptors) {
        const ctx = interceptors.createContext('activation', id, { pluginId: id, reason, host: manifest.host ?? 'in-process' }, { source: reason });
        await interceptors.run(ctx, async () => this.host.activate(record.description, reason));
      } else {
        await this.host.activate(record.description, reason);
      }
    } catch (error) {
      const failure = error instanceof PluginActivationError ? error : new PluginActivationError('activateThrew', `Activation of plugin "${id}" failed: ${error instanceof Error ? error.message : String(error)}`, error);
      this.#fail(id, record, failure);
      throw failure;
    }
    record.activationTimeMs = getScheduler().now() - started;
    record.failure = undefined;
    this.#setContextKey(id, true);
    this.#setState(id, record, PluginState.Active);
    // A dependent that failed only because this provider failed is not failed any more: it can activate on its next trigger
    // (the failure count stays, so a retry history is kept).
    for (const [key, other] of this.#records) {
      if (other.state === PluginState.Failed && other.failure?.cause === 'dependencyFailed' && other.dependsOn.includes(id)) {
        other.failure = undefined;
        this.#setState(key, other, PluginState.Resolved);
      }
    }
    this.#publishAll();
  }

  #fail(id: string, record: PluginRecord, error: PluginActivationError): void {
    record.failureCount++;
    record.failure = { cause: error.failureCause, error: serializeError(error), count: record.failureCount };
    this.#touch(id);
    this.#setContextKey(id, false);
    this.#setState(id, record, PluginState.Failed);
    this.#publishAll();
    reportError(error, { source: 'activation', pluginId: id, target: id });
  }

  /** Startup events that fired already ('*', 'onStartupFinished'): a plugin that becomes Resolved later (install, update, enable) gets them at once. */
  readonly #firedStartup = new Set<string>();

  /** Gives the fired startup events to plugins that became Resolved after the event (in-session install, update, enable). */
  async #catchUpStartup(): Promise<void> {
    for (const event of this.#firedStartup) await this.activateByEvent(event);
  }

  async activateByEvent(event: string): Promise<void> {
    if (this.#closing) return; // shutting down: activation events start nothing
    if (event === '*' || event === 'onStartupFinished') this.#firedStartup.add(event);
    // The reverse index gives the plugins that declare the event: O(matches), not a scan of every plugin and every entry.
    const declared = this.#registry.pluginsForEvent(event);
    const wanted = new Set<string>();
    const pendingOwners: Array<Promise<void>> = [];
    for (const id of declared) {
      const record = this.#records.get(id);
      if (!record) continue;
      if (record.state === PluginState.Resolved) wanted.add(id);
      // An activation of the owner is in flight (a command executes while its plugin starts): wait for that one only, not for unrelated plugins.
      else if (record.pending) pendingOwners.push(record.pending.catch(() => undefined));
    }
    if (wanted.size === 0) {
      await Promise.all(pendingOwners);
      return;
    }
    // transitive dependencies that are not active yet
    const all = new Set<string>();
    const visit = (id: string): void => {
      if (all.has(id)) return;
      const record = this.#records.get(id);
      if (!record || record.state === PluginState.Active) return;
      all.add(id);
      for (const dep of record.dependsOn) visit(dep);
    };
    for (const id of wanted) visit(id);
    const limit = event === 'onStartupFinished' ? 2 : 4;
    let running = 0;
    const waiting: Array<() => void> = [];
    const acquire = async (): Promise<void> => {
      if (running < limit) {
        running++;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      running++;
    };
    const release = (): void => {
      running--;
      waiting.shift()?.();
    };
    const tasks = new Map<string, Promise<void>>();
    // topological order: this.#order lists dependencies before dependents
    const position = new Map(this.#order.map((id, index) => [id, index] as const));
    const ordered = [...all].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    for (const id of ordered) {
      const record = this.#records.get(id) as PluginRecord;
      const deps = record.dependsOn.map((d) => tasks.get(d)).filter((t): t is Promise<void> => t !== undefined);
      tasks.set(
        id,
        (async () => {
          await Promise.all(deps.map((d) => d.catch(() => undefined)));
          if (record.state !== PluginState.Resolved && !record.pending) return;
          await acquire();
          try {
            await this.#activateOne(id, record, event);
          } catch {
            // already reported by #fail; activateByEvent never rejects
          } finally {
            release();
          }
        })(),
      );
    }
    await Promise.all([...tasks.values(), ...pendingOwners]);
  }

  // ----- deactivation --------------------------------------------------------------------------

  async deactivate(id: string, reason: DeactivateReason = 'disable'): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    // Another deactivation of the same plugin is in flight: join it.
    if (record.transition) return record.transition.catch(() => undefined);
    if (record.state !== PluginState.Active && !record.pending) return;
    // The provider counts as closing from here to the end, also while it waits for pending activations and for its dependents.
    // A consumer that starts to activate meanwhile waits for this and then activates the provider again (invariant 15).
    const flow = this.#deactivateFlow(id, record, reason);
    record.transition = flow;
    try {
      await flow;
    } finally {
      if (record.transition === flow) record.transition = undefined;
    }
  }

  async #deactivateFlow(id: string, record: PluginRecord, reason: DeactivateReason): Promise<void> {
    // A pending activation is bounded by itself (entry load plus activate()); the explicit bound here is a backstop for a host that is not.
    if (record.pending) await withTimeout(record.pending.catch(() => undefined), this.host.activationBudgetMs + 1000, `Waiting for the activation of plugin "${id}"`).catch(() => undefined);
    if (record.state !== PluginState.Active) return;
    // A dependent that is still activating finishes first (its pending promise), so it cannot end Active on a provider that is gone.
    // Only dependents that are past their dependency checks (state Activating) are waited for: the others see the closing provider and wait for it.
    await Promise.all(this.#activeDependents(id, true).filter((d) => this.#records.get(d)?.state === PluginState.Activating).map((dependent) => this.#records.get(dependent)?.pending?.catch(() => undefined)));
    // dependents first, in reverse topological order
    const dependents = this.#activeDependents(id).sort((a, b) => this.#order.indexOf(b) - this.#order.indexOf(a));
    for (const dependent of dependents) await this.#deactivateOne(dependent, this.#records.get(dependent) as PluginRecord, reason);
    await this.#deactivateOne(id, record, reason);
  }

  /** Plugins that depend on `id`, directly or not, and are Active (or, with includeActivating, are Activating too). */
  #activeDependents(id: string, includeActivating = false): string[] {
    const found = new Set<string>();
    const walk = (target: string): void => {
      for (const [other, record] of this.#records) {
        const live = record.state === PluginState.Active || (includeActivating && record.state === PluginState.Activating);
        if (found.has(other) || !live || !record.dependsOn.includes(target)) continue;
        found.add(other);
        walk(other);
      }
    };
    walk(id);
    return [...found];
  }

  async #deactivateOne(id: string, record: PluginRecord, reason: DeactivateReason, hostOptions?: HostDeactivateOptions): Promise<void> {
    if (record.state !== PluginState.Active) return;
    const run = this.#doDeactivate(id, record, reason, hostOptions);
    // A deactivation flow of this plugin already marks it as closing: do not replace that marker.
    if (record.transition) {
      await run;
      return;
    }
    record.transition = run;
    try {
      await run;
    } finally {
      if (record.transition === run) record.transition = undefined;
    }
  }

  async #doDeactivate(id: string, record: PluginRecord, reason: DeactivateReason, hostOptions?: HostDeactivateOptions): Promise<void> {
    this.#setState(id, record, PluginState.Deactivating);
    this.#publishAll();
    try {
      await this.host.deactivate(id, reason, hostOptions);
    } catch (error) {
      reportError(error, { source: 'deactivation', pluginId: id, target: id });
    }
    this.#setContextKey(id, false);
    this.#setState(id, record, PluginState.Resolved);
    this.#publishAll();
  }

  /** Resolves when no activation and no deactivation is in flight (new ones started meanwhile count too). */
  async #settle(): Promise<void> {
    for (;;) {
      const inFlight = [...this.#records.values()].flatMap((r) => [r.pending, r.transition]).filter((p): p is Promise<void> => p !== undefined);
      if (inFlight.length === 0) return;
      await Promise.all(inFlight.map((p) => p.catch(() => undefined)));
    }
  }

  /** Closes the shutdown gate and aborts ctx.signal of every running plugin. The shutdown dispose step calls it first. */
  abortAll(): void {
    this.#closing = true;
    this.host.abortAll();
  }

  /**
   * Shutdown (decision 1): reverse dependency waves, parallel inside a wave. Each plugin gets min(deactivateTimeoutMs, what is left of the
   * deadline divided by the waves still to run). After the deadline no deactivate() starts: the plugin is aborted and cleaned up, and listed in notStarted.
   * An activation that slipped in before the gate closed is awaited (bounded by the deadline); the loop runs until no plugin is Active.
   */
  async deactivateAll(options?: { readonly deadline?: number }): Promise<{ readonly notStarted: readonly string[]; readonly timedOut: readonly string[] }> {
    this.#closing = true;
    const deadline = options?.deadline;
    const scheduler = getScheduler();
    const notStarted: string[] = [];
    const timedOut: string[] = [];
    for (let round = 0; round < 8; round++) {
      // OSGi rule: deactivate() runs only after a successful activate(). A plugin that is still activating finishes first (bounded by the deadline).
      await this.#settleUntil(deadline);
      const active = [...this.#records.entries()].filter(([, r]) => r.state === PluginState.Active).map(([id]) => id);
      if (active.length === 0) break;
      const level = new Map<string, number>();
      const levelOf = (id: string, trail: ReadonlySet<string>): number => {
        const known = level.get(id);
        if (known !== undefined) return known;
        if (trail.has(id)) return 0;
        let result = 0;
        for (const dep of this.#records.get(id)?.dependsOn ?? []) if (active.includes(dep)) result = Math.max(result, 1 + levelOf(dep, new Set([...trail, id])));
        level.set(id, result);
        return result;
      };
      for (const id of active) levelOf(id, new Set());
      const waves = new Map<number, string[]>();
      for (const id of active) waves.set(level.get(id) ?? 0, [...(waves.get(level.get(id) ?? 0) ?? []), id]);
      const ordered = [...waves.keys()].sort((a, b) => b - a);
      for (let w = 0; w < ordered.length; w++) {
        const ids = waves.get(ordered[w] as number) as string[];
        const left = deadline === undefined ? Infinity : deadline - scheduler.now();
        const share = deadline === undefined ? undefined : Math.floor(left / (ordered.length - w));
        const expired = left <= 0;
        await Promise.all(
          ids.map(async (id) => {
            const record = this.#records.get(id);
            if (!record) return;
            if (expired) notStarted.push(id);
            await this.#deactivateOne(id, record, 'shutdown', { ...(share !== undefined ? { timeoutMs: Math.max(0, share) } : {}), ...(deadline !== undefined ? { deadline } : {}), skipDeactivate: expired, onTimeout: () => void timedOut.push(id) });
          }),
        );
      }
    }
    return { notStarted, timedOut };
  }

  /** Like #settle(), but gives up at the deadline (a hung activation must not hold the shutdown). */
  async #settleUntil(deadline: number | undefined): Promise<void> {
    if (deadline === undefined) return this.#settle();
    const left = deadline - getScheduler().now();
    if (left <= 0) return;
    let timer: IDisposable | undefined;
    const expired = new Promise<void>((resolve) => void (timer = getScheduler().timeout(resolve, left)));
    try {
      await Promise.race([this.#settle(), expired]);
    } finally {
      timer?.dispose();
    }
  }

  // ----- enable, disable, retry, reload ---------------------------------------------------------

  /**
   * The plugin and the plugins that depend on it, as far as they are Active or Activating now, providers first. Taken before a disable,
   * an update or a reload, so the same plugins can run again afterwards (contracts 14.12). After an app restart nothing was running:
   * a startup re-apply returns only the sticky startup events ('*', 'onStartupFinished').
   */
  #captureActive(id: string): string[] {
    const live = (p: string): boolean => {
      const current = this.#records.get(p)?.state;
      return current === PluginState.Active || current === PluginState.Activating;
    };
    return [id, ...this.#activeDependents(id, true)].filter(live).sort((a, b) => this.#order.indexOf(a) - this.#order.indexOf(b));
  }

  /** Activates the captured plugins again, providers first (the order of #captureActive). A failure is reported, not thrown. */
  async #reactivate(captured: readonly string[], reason: string): Promise<void> {
    for (const id of captured) {
      const record = this.#records.get(id);
      if (!record || record.state !== PluginState.Resolved) continue;
      try {
        await this.activate(id, reason);
      } catch (error) {
        reportError(error, { source: 'activation', pluginId: id, target: `reactivate:${reason}` });
      }
    }
  }

  async disable(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (!record || record.disabled) return;
    const captured = this.#captureActive(id);
    await this.deactivate(id, 'disable');
    record.reactivateOnEnable = captured;
    this.#removeContributions(id);
    record.contributed = false;
    record.disabled = true;
    record.pending = undefined;
    this.#setState(id, record, PluginState.Disabled);
    this.#writeDisabled();
    this.#resolveAll();
  }

  async enable(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (!record || !record.disabled) return;
    record.disabled = false;
    record.failure = undefined;
    record.state = PluginState.Discovered;
    this.#writeDisabled();
    this.#resolveAll();
    await this.#catchUpStartup();
    const captured = record.reactivateOnEnable;
    record.reactivateOnEnable = undefined;
    if (captured) await this.#reactivate(captured, 'enable');
  }

  async retry(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (!record || record.state !== PluginState.Failed) return;
    // A module that failed to load is cached by its URL in the browser's module map (an evaluation error is cached too): import another URL.
    if (record.failure?.cause === 'loadFailed') {
      record.reloads++;
      record.description = { ...record.description, location: `${record.description.location.split('?')[0] as string}?reload=${record.reloads}` };
    }
    this.#setState(id, record, PluginState.Resolved);
    this.#publishAll();
    await this.activate(id, 'retry');
  }

  /** Dev only: deactivate with dependents, re-import with a cache-busting query, re-validate, activate again. */
  async reload(id: string): Promise<void> {
    const host = this.#scope.get(HostEnvironment, { optional: true });
    if (host && !host.isDev) throw new TesseraError('validation', 'Plugin reload is available in dev mode only');
    const record = this.#records.get(id);
    if (!record) throw new TesseraError('plugin.unresolved', `Unknown plugin "${id}"`, { details: { id } });
    const wasActive = this.#captureActive(id);
    const dependents = wasActive.filter((p) => p !== id);
    await this.deactivate(id, 'reload');
    record.reloads++;
    // manifest changed on disk? Ask the catalog again and re-apply contributions when it differs.
    const catalog = this.#scope.get(PluginCatalog, { optional: true });
    const fresh = (await catalog?.list())?.find((d) => d.manifest.id === id);
    const base = (fresh ?? record.description).location.split('?')[0] as string;
    const next: PluginDescription = { ...(fresh ?? record.description), location: `${base}?reload=${record.reloads}` };
    if (JSON.stringify(fresh?.manifest) !== JSON.stringify(record.description.manifest) && fresh) {
      this.#removeContributions(id);
      record.contributed = false;
    }
    record.description = next;
    record.failure = undefined;
    if (record.state === PluginState.Failed) record.state = PluginState.Discovered;
    this.#resolveAll();
    if (wasActive.includes(id)) await this.activate(id, 'reload');
    for (const dependent of dependents) {
      const r = this.#records.get(dependent);
      if (r?.state === PluginState.Resolved) await this.activate(dependent, 'reload').catch(() => undefined);
    }
  }

  // ----- catalog sync --------------------------------------------------------------------------

  /** Follows PluginCatalog.onDidChange: new plugins are added, vanished ones removed. */
  watchCatalog(): IDisposable {
    const catalog = this.#scope.get(PluginCatalog);
    this.#catalogSub?.dispose();
    // ADR-018 rule 2 (one operation per target): catalog syncs run one after the other, and events that arrive while a sync runs
    // coalesce into one more run. A file watcher that fires twice gives one sync, not two overlapping ones that create a ghost record.
    let running: Promise<void> | undefined;
    let again = false;
    const sync = async (): Promise<void> => {
      try {
        const list = await catalog.list();
        const ids = new Set(list.map((d) => d.manifest.id));
        // A new version of an installed plugin is a reload: the old version ends (reason 'update'), the new one is added.
        const updated = list.filter((d) => {
          const known = this.#records.get(d.manifest.id);
          const knownVersion = (known?.description.manifest as { version?: unknown } | undefined)?.version;
          return known !== undefined && typeof knownVersion === 'string' && knownVersion !== d.manifest.version;
        });
        // What ran before the update runs again afterwards: the plugin and its active dependents (contracts 14.12).
        const toReactivate: string[] = [];
        for (const d of updated) {
          this.#scope.get(Logger, { optional: true })?.info(`Plugin "${d.manifest.id}" changed to version ${d.manifest.version}: reloading it`, { pluginId: d.manifest.id });
          for (const captured of this.#captureActive(d.manifest.id)) if (!toReactivate.includes(captured)) toReactivate.push(captured);
          await this.remove(d.manifest.id, 'update');
        }
        const fresh = list.filter((d) => !this.#records.has(d.manifest.id));
        for (const id of [...this.#records.keys()]) if (!ids.has(id) && !id.includes('#')) await this.remove(id, 'uninstall');
        if (fresh.length > 0) await this.add(fresh);
        if (toReactivate.length > 0) await this.#reactivate(toReactivate, 'update');
      } catch (error) {
        reportError(error, { source: 'activation', target: 'catalog.sync' });
      }
    };
    const trigger = (): void => {
      if (running) {
        again = true;
        return;
      }
      running = (async () => {
        do {
          again = false;
          await sync();
        } while (again);
      })().finally(() => {
        running = undefined;
      });
    };
    this.#catalogSub = catalog.onDidChange(trigger);
    return this.#catalogSub;
  }

  // ----- state publication ---------------------------------------------------------------------

  #setState(key: string, record: PluginRecord, next: PluginState): void {
    if (record.state === next) return;
    // Dev assertion (I33): a plugin changes state only along the contracts 14.4 diagram. A violation is reported, the change still happens.
    if (isDevMode() && !isAllowedTransition(record.state, next)) {
      reportError(new TesseraError('plugin.invalidTransition', `Plugin "${key}" changed state from ${record.state} to ${next}, which contracts 14.4 does not allow`, { details: { id: key, from: record.state, to: next } }), { source: 'activation', pluginId: key, target: 'stateTransition' });
    }
    record.state = next;
    this.#dirty.add(key);
    this.#stale.add(key);
  }
  readonly #dirty = new Set<string>();
  /** Plugins whose status object must be rebuilt at the next publication. The others keep their frozen object. */
  readonly #stale = new Set<string>();
  #allStale = true;
  readonly #statuses = new Map<string, PluginStatus>();
  /** Counter for the performance tests: how many status objects were built (one per changed plugin, not one per plugin and publication). */
  statusesBuilt = 0;

  /** A field of the record changed without a state change (failure, problems, events): rebuild that status. */
  #touch(key: string): void {
    this.#stale.add(key);
  }

  #statusOf(key: string, record: PluginRecord, declared: ReadonlySet<string> = this.#declaredPoints()): PluginStatus {
    this.statusesBuilt++;
    const manifest: Partial<PluginManifest> = record.description.manifest ?? {};
    const host: PluginHostKind = manifest.host ?? 'in-process';
    const trust: PluginTrust = manifest.trust ?? 'trusted';
    const source: PluginSource = record.description.source;
    return Object.freeze({
      id: typeof manifest.id === 'string' ? manifest.id : key,
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      state: record.state,
      source,
      host,
      trust,
      activationEvents: record.contributed || record.state === PluginState.Active ? this.#registry.activationEvents(key) : [...(manifest.activationEvents ?? [])],
      activationReason: record.activationReason,
      activationTimeMs: record.activationTimeMs,
      failure: record.failure,
      // Resolution problems plus the live problems of the registry (invalid entries, points defined later).
      problems: [...new Set([...record.problems, ...(record.contributed ? [...this.#registry.problemsOf(key), ...this.#unknownPointProblems(key, declared)] : [])])],
    });
  }

  /**
   * Rebuilds the status of the plugins that changed since the last call and fires onDidChangeState for every plugin whose state changed.
   * The status objects of the other plugins are reused, so one state change costs one status, not one per installed plugin.
   */
  #publishAll(): void {
    const everything = this.#allStale;
    const declared = this.#declaredPoints();
    let changed = everything;
    for (const key of this.#statuses.keys()) {
      if (!this.#records.has(key)) {
        this.#statuses.delete(key); // removed plugin
        changed = true;
      }
    }
    for (const [key, record] of this.#records) {
      if (!everything && !this.#stale.has(key) && this.#statuses.has(key)) continue;
      this.#statuses.set(key, this.#statusOf(key, record, declared));
      changed = true;
    }
    this.#allStale = false;
    this.#stale.clear();
    if (changed) {
      this.statusPublications++;
      this.#map.set(new Map(this.#statuses));
    }
    const map = this.#statuses;
    const dirty = [...this.#dirty];
    this.#dirty.clear();
    for (const key of dirty) {
      const status = map.get(key);
      if (!status) continue;
      this.#changed.fire(status);
      try {
        this.#scope.get(EventBus).root.publish(CoreTopics.pluginState, { pluginId: status.id, state: status.state });
      } catch (error) {
        reportError(error, { source: 'activation', pluginId: status.id, target: 'pluginState' });
      }
    }
  }

  #setContextKey(id: string, active: boolean): void {
    this.#scope.get(ContextKeyService).root.set(`plugin.${id}.active`, active);
  }

  // ----- persistence of enablement -------------------------------------------------------------

  #readDisabled(): ReadonlySet<string> {
    try {
      const storage = this.#scope.get(StorageService, { optional: true });
      if (!storage) return new Set();
      return new Set(storage.getVersioned('application', PLUGINS_DISABLED_STORAGE_KEY, disabledSchema).value);
    } catch {
      return new Set(); // storage not ready: plugins start enabled
    }
  }

  #storageWarned = false;

  /** Waits for the storage to be ready, at most STORAGE_WAIT_MS. Reports once when the disabled list could not be read. */
  async #whenStorageReady(): Promise<void> {
    const storage = this.#scope.get(StorageService, { optional: true });
    if (!storage || storage.isReady) return;
    let timer: IDisposable | undefined;
    const expired = new Promise<void>((resolve) => void (timer = getScheduler().timeout(resolve, STORAGE_WAIT_MS)));
    try {
      await Promise.race([storage.whenReady().catch(() => undefined), expired]);
    } finally {
      timer?.dispose();
    }
    if (!storage.isReady && !this.#storageWarned) {
      this.#storageWarned = true;
      reportError(new TesseraError('plugin.disabledListUnavailable', 'The storage is not ready: the list of disabled plugins could not be read, so plugins start enabled. It is applied again when the storage is ready', {}), { source: 'persistence', target: PLUGINS_DISABLED_STORAGE_KEY });
    }
  }

  /**
   * The disabled list changed behind our back (storage became ready late, a retry after degraded mode, another window): apply it.
   * Our own writes are not external, so they do not come back here.
   */
  #watchDisabledList(): IDisposable | undefined {
    const storage = this.#scope.get(StorageService, { optional: true });
    return storage?.onDidChange((e) => {
      if (!e.external || e.scope !== 'application' || !e.keys.has(PLUGINS_DISABLED_STORAGE_KEY)) return;
      void this.#applyDisabledList();
    });
  }

  async #applyDisabledList(): Promise<void> {
    const disabled = this.#readDisabled();
    for (const [id, record] of [...this.#records]) {
      const manifestId = (record.description.manifest as { id?: string }).id ?? id;
      if (disabled.has(manifestId) && !record.disabled) await this.disable(id).catch((error: unknown) => reportError(error, { source: 'deactivation', pluginId: id, target: 'disabledList' }));
      else if (!disabled.has(manifestId) && record.disabled) await this.enable(id);
    }
  }

  #writeDisabled(): void {
    try {
      const storage = this.#scope.get(StorageService, { optional: true });
      if (!storage) return;
      const ids = [...this.#records].filter(([, r]) => r.disabled).map(([id]) => id);
      storage.setVersioned('application', PLUGINS_DISABLED_STORAGE_KEY, ids, disabledSchema);
    } catch (error) {
      reportError(error, { source: 'persistence', target: PLUGINS_DISABLED_STORAGE_KEY });
    }
  }

  async dispose(): Promise<void> {
    this.#problemSub.dispose();
    this.#pointSub.dispose();
    this.#disabledSub?.dispose();
    this.#catalogSub?.dispose();
    // The scope awaits this, so plugin stores are disposed before the window scope is gone.
    // An activation in flight finishes first: it must not write its state after the host ended.
    await this.#settle();
    this.#changed.dispose();
    await this.host.dispose();
  }
}

export type { ResolutionCode };

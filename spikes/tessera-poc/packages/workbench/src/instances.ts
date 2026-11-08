import {
  DeferredPromise,
  DisposableStore,
  MigrationStatus,
  TesseraError,
  generateId,
  getScheduler,
  migrateValue,
  reportError,
  type IDisposable,
  type StateSchema,
  type StoredValue,
} from '@tessera/base';
import {
  type ClosedInstanceSnapshot,
  type PlacementId,
  type ViewInstance,
  type ViewInstanceId,
  type ViewInstanceRegistry,
  type ViewProvider,
  type ViewRegistry,
  type WorkItem,
} from '@tessera/contracts';
import type { Scope } from '@tessera/di';
import { state, type Observable, type State } from '@tessera/reactive';

export const GRACE_MS = 30_000;
export const MAX_CLOSED_INSTANCES = 50;

/** The identity and the persisted state of one view instance. It outlives the live part (scope and view model). */
export interface InstanceEntry {
  readonly id: ViewInstanceId;
  readonly viewType: string;
  readonly key: string;
  workItemPath: string;
  refCount: number;
  live: LiveInstance | undefined;
  /** Shared state as stored (snapshot, or the last value of a live instance). Kept raw while no provider exists. */
  storedShared: StoredValue | undefined;
  readonly placements: State<ReadonlySet<PlacementId>>;
  graceTimer: IDisposable | undefined;
}

class LiveInstance implements ViewInstance {
  readonly id: ViewInstanceId;
  readonly viewType: string;
  readonly key: string;
  readonly workItemPath: string;
  readonly scope: Scope;
  readonly viewModel: unknown;
  readonly shared: State<unknown>;
  readonly placements: Observable<ReadonlySet<PlacementId>>;
  readonly sharedSchema: StateSchema<unknown> | undefined;
  readonly #entry: InstanceEntry;

  constructor(entry: InstanceEntry, scope: Scope, viewModel: unknown, shared: State<unknown>, sharedSchema: StateSchema<unknown> | undefined) {
    this.#entry = entry;
    this.id = entry.id;
    this.viewType = entry.viewType;
    this.key = entry.key;
    this.workItemPath = entry.workItemPath;
    this.scope = scope;
    this.viewModel = viewModel;
    this.shared = shared;
    this.sharedSchema = sharedSchema;
    this.placements = entry.placements.asReadonly();
  }

  get refCount(): number {
    return this.#entry.refCount;
  }
}

const keyOf = (viewType: string, key: string): string => `${viewType}\u0000${key}`;

function hasDispose(value: unknown): value is IDisposable {
  return typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function';
}

/** Ref-counted view instances per (view type, key) in one window (contracts.md 15.4). Window DI scope. */
export class DefaultViewInstanceRegistry implements ViewInstanceRegistry, IDisposable {
  readonly #views: ViewRegistry;
  readonly #entries = new Map<string, InstanceEntry>();
  readonly #byId = new Map<ViewInstanceId, InstanceEntry>();
  #closed: ClosedInstanceSnapshot[] = [];
  #onChange: (() => void) | undefined;
  #isReferenced: ((id: ViewInstanceId) => boolean) | undefined;

  constructor(views: ViewRegistry) {
    this.#views = views;
  }

  /** The workbench tells the registry when something changed (to schedule a layout save) and which entries placements still use. */
  connect(onChange: () => void, isReferenced: (id: ViewInstanceId) => boolean): void {
    this.#onChange = onChange;
    this.#isReferenced = isReferenced;
  }

  // ----- identity ------------------------------------------------------------------------------

  /** Finds or creates the identity entry. No scope and no view model yet. */
  ensureEntry(viewType: string, key: string, workItemPath: string, options?: { readonly id?: ViewInstanceId; readonly storedShared?: StoredValue }): InstanceEntry {
    const existing = this.#entries.get(keyOf(viewType, key));
    if (existing) return existing;
    const closed = this.#takeClosed(viewType, key);
    const entry: InstanceEntry = {
      id: options?.id ?? (generateId('vi') as ViewInstanceId),
      viewType,
      key,
      workItemPath,
      refCount: 0,
      live: undefined,
      storedShared: options?.storedShared ?? closed?.shared,
      placements: state<ReadonlySet<PlacementId>>(new Set(), { name: `instance.placements:${viewType}` }),
      graceTimer: undefined,
    };
    this.#entries.set(keyOf(viewType, key), entry);
    this.#byId.set(entry.id, entry);
    return entry;
  }

  entry(id: ViewInstanceId): InstanceEntry | undefined {
    return this.#byId.get(id);
  }

  entries(): readonly InstanceEntry[] {
    return [...this.#entries.values()];
  }

  attach(entry: InstanceEntry, placement: PlacementId): void {
    entry.placements.update((s) => new Set([...s, placement]));
  }

  detach(entry: InstanceEntry, placement: PlacementId): void {
    entry.placements.update((s) => new Set([...s].filter((p) => p !== placement)));
  }

  // ----- ViewInstanceRegistry ------------------------------------------------------------------

  /** Live parts that are being disposed (state: Retiring). A new live part of the same instance waits for them: a view model that owns a pty or a lock must never exist twice. */
  readonly #retiring = new Map<string, Promise<void>>();

  /** Resolves when no live part of this instance is being disposed. */
  whenRetired(viewType: string, key: string): Promise<void> {
    return this.#retiring.get(keyOf(viewType, key)) ?? Promise.resolve();
  }

  /** Instances marked Retiring by beginSuspend() whose live part is not disposed yet: the placeholder promise resolves when it is. */
  readonly #announced = new Map<string, DeferredPromise<void>>();

  /**
   * The plugin of a view type is going away and its presenters still dispose. Marks every live instance of the type Retiring now, so
   * whenRetired() and acquire() see the end of the old live part, whatever happens before suspendViewType() disposes it.
   */
  beginSuspend(viewType: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.viewType !== viewType || !entry.live) continue;
      const id = keyOf(viewType, entry.key);
      if (this.#retiring.has(id)) continue;
      const placeholder = new DeferredPromise<void>();
      this.#announced.set(id, placeholder);
      this.#retiring.set(id, placeholder.promise);
    }
  }

  #disposeLive(viewType: string, key: string, live: LiveInstance): void {
    const id = keyOf(viewType, key);
    const announced = this.#announced.get(id);
    this.#announced.delete(id);
    const before = announced ? undefined : this.#retiring.get(id);
    const done: Promise<void> = live.scope.dispose().catch((e: unknown) => reportError(e, { source: 'dispose', target: `view:${viewType}` }));
    // a second dispose of the same instance (suspend, then retire) chains behind the first
    const chained = before ? Promise.all([before, done]).then(() => undefined) : done;
    this.#retiring.set(id, chained);
    if (announced) void chained.then(() => announced.resolve());
    void chained.finally(() => {
      if (this.#retiring.get(id) === chained) this.#retiring.delete(id);
    });
  }

  acquire(viewType: string, key: string, owner: WorkItem): ViewInstance {
    if (this.#retiring.has(keyOf(viewType, key))) {
      throw new TesseraError('workbench.instanceRetiring', `The view instance "${viewType}" is still being disposed; await whenRetired() before acquiring it again`, { details: { viewType, key } });
    }
    const entry = this.ensureEntry(viewType, key, owner.path);
    entry.graceTimer?.dispose();
    entry.graceTimer = undefined;
    if (!entry.live) entry.live = this.#materialize(entry, owner);
    entry.refCount++;
    return entry.live;
  }

  release(id: ViewInstanceId): void {
    const entry = this.#byId.get(id);
    if (!entry || entry.refCount === 0) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    // the retain rule (15.4 instance rule 4)
    const retain = this.#views.descriptor(entry.viewType)?.retain ?? 'grace';
    if (retain === 'none') this.#retire(entry);
    else if (retain === 'grace') entry.graceTimer = getScheduler().timeout(() => this.#retire(entry), GRACE_MS);
    // 'workItem': the live part ends when the WorkItem terminates (its scope disposes the view scope)
  }

  get(id: ViewInstanceId): ViewInstance | undefined {
    return this.#byId.get(id)?.live;
  }

  find(viewType: string, key: string): ViewInstance | undefined {
    return this.#entries.get(keyOf(viewType, key))?.live;
  }

  /**
   * Called when a stored view state was unusable and reset to initial (reset-newer, reset-invalid, reset-no-path). The workbench
   * keeps a `.bak` copy of the stored value next to the layout key, like StorageService.getVersioned does (contracts 16.1 rule 5).
   */
  onStateReset: ((event: { readonly kind: 'shared' | 'local'; readonly id: string; readonly stored: StoredValue }) => void) | undefined;

  // ----- live part -----------------------------------------------------------------------------

  #materialize(entry: InstanceEntry, owner: WorkItem): LiveInstance {
    const provider = this.#views.provider(entry.viewType) as ViewProvider | undefined;
    if (!provider) {
      throw new TesseraError('workbench.unknownView', `View type "${entry.viewType}" has no provider: its plugin is not active`, { details: { viewType: entry.viewType } });
    }
    const scope = owner.scope.createChild('view', entry.key === '' ? entry.viewType : `${entry.viewType}:${entry.key}`);
    const store = new DisposableStore(`view:${entry.viewType}`);
    scope.track(store);
    const schema = provider.sharedState as StateSchema<unknown> | undefined;
    let initial: unknown;
    if (schema) {
      const result = migrateValue(entry.storedShared, schema);
      initial = result.value;
      if (result.status === MigrationStatus.ResetInvalid || result.status === MigrationStatus.ResetNewer || result.status === MigrationStatus.ResetNoPath) {
        if (entry.storedShared !== undefined) this.onStateReset?.({ kind: 'shared', id: entry.id, stored: entry.storedShared });
        reportError(result.error ?? new Error(`Shared state of "${entry.viewType}" was reset (${result.status})`), { source: 'view', pluginId: this.#views.descriptor(entry.viewType)?.owner ?? 'core', target: `${entry.viewType}.sharedState` });
      }
    }
    const shared = state<unknown>(initial, { name: `view.shared:${entry.viewType}` });
    let live!: LiveInstance;
    try {
      const viewModel = provider.createViewModel
        ? scope.run(() =>
            provider.createViewModel?.({
              instance: { id: entry.id, viewType: entry.viewType, key: entry.key, workItemPath: owner.path },
              shared: shared as State<never>,
              workItem: owner,
              store,
            }),
          )
        : undefined;
      if (hasDispose(viewModel)) scope.track(viewModel as object);
      live = new LiveInstance(entry, scope, viewModel, shared, schema);
    } catch (error) {
      void scope.dispose().catch((e: unknown) => reportError(e, { source: 'dispose', target: `view:${entry.viewType}` }));
      throw error;
    }
    entry.workItemPath = owner.path;
    // The live part ends with its scope. That also happens when the owning WorkItem terminates: keep the state.
    scope.onWillDispose(() => this.#capture(entry, live));
    return live;
  }

  /** Saves the shared state of a live instance into the entry before the live part goes away. */
  #capture(entry: InstanceEntry, live: LiveInstance): void {
    if (entry.live !== live) return;
    if (live.sharedSchema) entry.storedShared = { v: live.sharedSchema.version, data: live.shared.peek() };
    entry.live = undefined;
  }

  /** Disposes the live part now (retain policy reached). The state goes into the closed-instance cache. */
  #retire(entry: InstanceEntry): void {
    entry.graceTimer = undefined;
    const live = entry.live;
    if (live) {
      this.#capture(entry, live);
      // The live part is gone from the entry at once: a later acquire (after whenRetired) builds a new one, never hands out the disposed one.
      entry.live = undefined;
      this.#disposeLive(entry.viewType, entry.key, live);
    }
    if (entry.refCount === 0 && !(this.#isReferenced?.(entry.id) ?? false)) {
      if (entry.storedShared) this.#pushClosed({ viewType: entry.viewType, key: entry.key, shared: entry.storedShared, closedAt: new Date().toISOString() });
      this.#entries.delete(keyOf(entry.viewType, entry.key));
      this.#byId.delete(entry.id);
    }
    this.#onChange?.();
  }

  /** Called when the plugin of a view type stops: live parts end, state is kept, the entries stay. */
  suspendViewType(viewType: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.viewType !== viewType) continue;
      entry.graceTimer?.dispose();
      entry.graceTimer = undefined;
      const live = entry.live;
      entry.refCount = 0;
      if (live) {
        this.#capture(entry, live);
        entry.live = undefined; // see #retire: the entry is Retiring until the live part is disposed; a re-acquire awaits whenRetired()
        this.#disposeLive(viewType, entry.key, live);
      }
    }
    // an announced instance that had no live part left to dispose is not Retiring any more
    for (const [id, placeholder] of [...this.#announced]) {
      if (!id.startsWith(`${viewType}\u0000`)) continue;
      this.#announced.delete(id);
      this.#retiring.delete(id);
      placeholder.resolve();
    }
  }

  /** Drops an entry whose placements are all gone (a closed placement of a type without provider, for example). */
  forgetIfUnused(entry: InstanceEntry): void {
    if (entry.refCount > 0 || entry.live || entry.placements.peek().size > 0 || entry.graceTimer) return;
    if (entry.storedShared) this.#pushClosed({ viewType: entry.viewType, key: entry.key, shared: entry.storedShared, closedAt: new Date().toISOString() });
    this.#entries.delete(keyOf(entry.viewType, entry.key));
    this.#byId.delete(entry.id);
  }

  /** resetLayout: every instance ends now, its state is thrown away, and so is the closed-instance cache. */
  discardAll(): void {
    for (const entry of [...this.#entries.values()]) {
      entry.graceTimer?.dispose();
      entry.graceTimer = undefined;
      const live = entry.live;
      entry.live = undefined; // not captured: the state is discarded
      entry.storedShared = undefined;
      if (live) this.#disposeLive(entry.viewType, entry.key, live);
      if (entry.refCount === 0 && entry.placements.peek().size === 0) {
        this.#entries.delete(keyOf(entry.viewType, entry.key));
        this.#byId.delete(entry.id);
      }
    }
    this.#closed = [];
  }

  // ----- closed-instance cache -----------------------------------------------------------------

  get closedInstances(): readonly ClosedInstanceSnapshot[] {
    return this.#closed;
  }

  restoreClosed(list: readonly ClosedInstanceSnapshot[]): void {
    this.#closed = list.slice(0, MAX_CLOSED_INSTANCES);
  }

  #pushClosed(item: ClosedInstanceSnapshot): void {
    this.#closed = [item, ...this.#closed.filter((c) => !(c.viewType === item.viewType && c.key === item.key))].slice(0, MAX_CLOSED_INSTANCES);
  }

  #takeClosed(viewType: string, key: string): ClosedInstanceSnapshot | undefined {
    const found = this.#closed.find((c) => c.viewType === viewType && c.key === key);
    if (found) this.#closed = this.#closed.filter((c) => c !== found);
    return found;
  }

  /** The stored shared state of an entry, for the snapshot. */
  sharedOf(entry: InstanceEntry): StoredValue | undefined {
    if (entry.live?.sharedSchema) return { v: entry.live.sharedSchema.version, data: entry.live.shared.peek() };
    return entry.storedShared;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      entry.graceTimer?.dispose();
      entry.graceTimer = undefined;
    }
    this.#entries.clear();
    this.#byId.clear();
  }
}

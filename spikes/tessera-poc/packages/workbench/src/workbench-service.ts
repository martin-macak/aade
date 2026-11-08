import {
  DeferredPromise,
  DisposableStore,
  Emitter,
  MigrationStatus,
  TesseraError,
  generateId,
  migrateValue,
  reportError,
  toDisposable,
  type Event,
  type IDisposable,
  type StateSchema,
  type StoredValue,
} from '@tessera/base';
import {
  ActivationService,
  CommandRegistry,
  CommandService,
  ContextKeyService,
  CoreTopics,
  DockSurfaceFactory,
  EDITOR_AREA_WORKSPACE,
  EventBus,
  HostEnvironment,
  LAYOUT_STORAGE_KEY,
  LifecycleService,
  StorageService,
  LayoutStore,
  Logger,
  PlacementStatus,
  PluginManager,
  SelectionService,
  ViewInstanceRegistry,
  ViewRegistry,
  WorkItemService,
  WorkbenchCommands,
  WorkspaceKind,
  emptyOverrides,
  type ContextKeyScope,
  type DockChange,
  type DockDesired,
  type DockPosition,
  type DockSlot,
  type PartId,
  type PlacementId,
  type PlacementRecord,
  type PlacementRef,
  type PlacementTarget,
  type BeforeShutdownEvent,
  type Presenter,
  type PresenterContext,
  type ShowViewOptions,
  type ViewDescriptor,
  type ViewInstance,
  type ViewInstanceId,
  type ViewProvider,
  type WindowId,
  type WorkItem,
  type WorkbenchAdapterApi,
  type WorkbenchService,
  type WorkbenchSnapshot,
  type WorkbenchState,
  type WorkspaceContribution,
  type WorkspaceHost,
  type WorkspaceInit,
  type WorkspaceRecord,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { computed, constant, state, type Observable, type State } from '@tessera/reactive';
import { DockBinding } from './dock-sync.ts';
import type { DefaultViewInstanceRegistry, InstanceEntry } from './instances.ts';
import type { DefaultLayoutStore, LayoutSource } from './layout-store.ts';
import * as model from './model.ts';
import { MAX_VIEW_STATE_BYTES } from './layout-store.ts';
import { PlacementStateAutosave } from './placement-state-autosave.ts';
import { PlacementImpl } from './placement.ts';
import type { DefaultSelectionService } from './selection.ts';
import type { DefaultViewRegistry } from './view-registry.ts';

const CONTAINER_KINDS: ReadonlySet<string> = new Set([WorkspaceKind.Tabs, WorkspaceKind.Accordion, WorkspaceKind.Deck, WorkspaceKind.Zone, WorkspaceKind.Dialog]);
const isContainer = (kind: string): boolean => CONTAINER_KINDS.has(kind);

function fail(code: string, message: string, details?: Record<string, unknown>): TesseraError {
  return new TesseraError(code, message, details ? { details } : undefined);
}

const defaultPlacementId = (workspaceId: string, viewType: string): PlacementId => `p:${workspaceId}:${viewType}` as PlacementId;

interface WorkspaceDef {
  readonly value: WorkspaceContribution;
  readonly owner: string;
  readonly seq: number;
}

/** What could not be restored but must survive the next save (contracts.md 16.4 delta rule 4). */
interface Retained {
  placements: Record<string, WorkbenchSnapshot['placements'][string]>;
  instances: Record<string, WorkbenchSnapshot['instances'][string]>;
  workspaces: Record<string, WorkbenchSnapshot['workspaces'][string]>;
}

/**
 * The window's UI model and its commands (contracts.md section 15). It owns membership and identity of placements,
 * workspaces, presenters, restore and the sync with dock surfaces. DOM-free: renderers and the dock surface report facts
 * through the WorkbenchAdapterApi methods of this class.
 */
export class DefaultWorkbenchService implements WorkbenchService, WorkbenchAdapterApi, LayoutSource, IDisposable {
  readonly state: Observable<WorkbenchState>;
  readonly focused: Observable<PlacementRef | undefined>;

  readonly #scope: Scope;
  readonly #views: DefaultViewRegistry;
  readonly #instances: DefaultViewInstanceRegistry;
  readonly #windowId: WindowId;
  readonly #appVersion: string;
  readonly #state: State<WorkbenchState>;
  readonly #placements = new Map<PlacementId, PlacementImpl>();
  readonly #bindings = new Map<string, DockBinding>();
  readonly #jobs = new Map<PlacementId, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #defs = new Map<string, WorkspaceDef>();
  readonly #defWorkspaces = new Set<string>();
  readonly #userShown = new Set<string>();
  readonly #retained: Retained = { placements: {}, instances: {}, workspaces: {} };
  readonly #subscriptions = new DisposableStore('workbench');
  readonly #autosave: PlacementStateAutosave;
  readonly #activated = new Map<string, Emitter<PlacementId>>();
  #snapshot: WorkbenchSnapshot | undefined;
  #defSeq = 0;
  #restoring: Promise<void> | undefined;
  #restoredPlacements = 0;
  #disposed = false;
  #layoutLoaded = false;

  constructor() {
    this.#scope = injectScope();
    this.#views = this.#scope.get(ViewRegistry) as DefaultViewRegistry;
    this.#instances = this.#scope.get(ViewInstanceRegistry) as DefaultViewInstanceRegistry;
    this.#instances.onStateReset = (event) => this.#backupReset(event.kind, event.id, event.stored);
    const host = this.#scope.get(HostEnvironment);
    this.#windowId = host.windowId;
    this.#appVersion = host.appVersion;
    this.#state = state(model.initialState(this.#windowId), { name: 'workbench.state' });
    this.state = this.#state.asReadonly();
    this.focused = computed(() => {
      const id = this.#state.get().focus;
      return id === undefined ? undefined : this.#placements.get(id)?.ref();
    }, { name: 'workbench.focused' });
    this.#instances.connect(
      () => this.#layout().scheduleSave(),
      (id) => this.#state.peek().instances[id] !== undefined,
    );
    this.#layout().setSource(this);
    this.#autosave = new PlacementStateAutosave(() => this.#layout().scheduleSave());
    // A terminated WorkItem ends the placements of the view instances it owns. The instance belongs to the WorkItem of its first acquirer
    // (documented in workbench.md): when that one terminates, every placement of the instance closes, local state kept in the layout.
    this.#subscriptions.add(this.#scope.get(WorkItemService).onDidTerminate((workItem) => this.#workItemTerminated(workItem.path)));
    // After degraded mode the stored layout replaces the session's defaults (storage.retryLoad: backend wins): rebuild from it.
    this.#subscriptions.add(
      this.#scope.get(StorageService).onDidChange((e) => {
        if (e.reason !== 'recovered' || e.scope !== 'project' || !e.keys.has(LAYOUT_STORAGE_KEY)) return;
        if (this.#scope.get(HostEnvironment, { optional: true })?.safeMode === true) return;
        void this.reloadLayout().catch((error: unknown) => reportError(error, { source: 'persistence', target: 'workbench.reloadLayout' }));
      }),
    );
    // views appear and disappear with their plugins; providers appear when a plugin activates
    this.#subscriptions.add(this.#views.onDidChangeDescriptors(() => this.reconcile()));
    this.#subscriptions.add(this.#views.onDidRegisterProvider((viewType) => this.#providerAppeared(viewType)));
    this.#subscriptions.add(this.#views.onDidUnregisterProvider((viewType) => this.#providerGone(viewType)));
    const plugins = this.#scope.get(PluginManager, { optional: true });
    if (plugins) {
      this.#subscriptions.add(
        plugins.onDidChangeState((status) => {
          if (status.state === 'deactivating' || status.state === 'failed') this.#pluginStopped(status.id, status.state === 'failed' ? `Plugin "${status.id}" failed` : `Plugin "${status.id}" is deactivated`);
        }),
      );
    }
  }

  // ----- small accessors -----------------------------------------------------------------------

  #layout(): DefaultLayoutStore {
    return this.#scope.get(LayoutStore) as DefaultLayoutStore;
  }
  #windowContext(): ContextKeyScope {
    return this.#scope.get(WorkItemService).root.context;
  }
  #commands(): CommandService {
    return this.#scope.get(CommandService);
  }
  #logger(): Logger | undefined {
    return this.#scope.get(Logger, { optional: true });
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#background.add(promise);
    void promise.then(
      () => this.#background.delete(promise),
      () => this.#background.delete(promise),
    );
    return promise;
  }

  /** Resolves when background work (placeholder teardown, dock reports, presenter jobs) has settled. For tests and shutdown. */
  /**
   * The core quit participant (registered by the workbench module): asks each presenter canClose() one placement at a time, the focused
   * one first, and stops at the first false. The veto id is `placement:<id>`. There is no timeout: a presenter may show a dialog, and the
   * user's "quit anyway" (force) is the exit. A throwing canClose vetoes and is reported, like a close().
   */
  beforeShutdown(event: BeforeShutdownEvent): void {
    const focus = this.#state.peek().focus;
    const ordered = [...this.#placements.values()].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
    let stopped = false;
    let chain: Promise<void> = Promise.resolve();
    for (const placement of ordered) {
      if (!placement.presenter?.canClose) continue;
      const result = chain.then(async (): Promise<boolean> => {
        if (stopped || this.#placements.get(placement.id) !== placement) return false;
        let blocked: boolean;
        try {
          blocked = (await placement.presenter?.canClose?.()) === false;
        } catch (error) {
          reportError(error, { source: 'view', pluginId: this.#views.descriptor(placement.viewType)?.owner ?? 'core', target: `${placement.viewType}.canClose` });
          blocked = true;
        }
        if (blocked) stopped = true;
        return blocked;
      });
      chain = result.then(() => undefined, () => undefined);
      event.veto(result, `placement:${placement.id}`);
    }
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const work = [...this.#background, ...this.#jobs.values(), ...[...this.#bindings.values()].map((b) => b.idle())];
      if (work.length === 0) return;
      await Promise.allSettled(work);
      await Promise.resolve();
    }
  }

  // ----- reading the model ---------------------------------------------------------------------

  placement(id: PlacementId | string): PlacementImpl | undefined {
    return this.#placements.get(id as PlacementId);
  }
  instance(id: ViewInstanceId): ViewInstance | undefined {
    return this.#instances.get(id);
  }
  /** The dock binding of a workspace. Renderers use it to mount the surface into a host element. */
  dockSurface(workspaceId: string): DockBinding['surface'] | undefined {
    return this.#bindings.get(workspaceId)?.surface;
  }
  dockBinding(workspaceId: string): DockBinding | undefined {
    return this.#bindings.get(workspaceId);
  }

  workspace(id: string): WorkspaceHost | undefined {
    return this.#state.peek().workspaces[id] ? new WorkspaceHostImpl(this, id) : undefined;
  }

  onDidActivateIn(workspaceId: string): Event<PlacementId> {
    let emitter = this.#activated.get(workspaceId);
    if (!emitter) {
      emitter = new Emitter<PlacementId>({ name: `workspace.activated:${workspaceId}`, deferInTransaction: false });
      this.#activated.set(workspaceId, emitter);
    }
    return emitter.event;
  }

  // ===========================================================================================
  // WorkbenchService: every mutation is a command (contracts.md 15.5)
  // ===========================================================================================

  showView(viewType: string, options?: ShowViewOptions): Promise<PlacementRef> {
    return this.#commands().execute<PlacementRef>(WorkbenchCommands.showView, { viewType, options }, { source: 'api' });
  }
  activate(id: PlacementId, options?: { readonly focus?: boolean }): Promise<void> {
    return this.#commands().execute<void>(WorkbenchCommands.activatePlacement, { id, focus: options?.focus }, { source: 'api', placementId: id });
  }
  hide(id: PlacementId): Promise<void> {
    return this.#commands().execute<void>(WorkbenchCommands.hidePlacement, { id }, { source: 'api', placementId: id });
  }
  close(id: PlacementId, options?: { readonly force?: boolean }): Promise<boolean> {
    return this.#commands().execute<boolean>(WorkbenchCommands.closePlacement, { id, force: options?.force === true }, { source: 'api', placementId: id });
  }
  move(id: PlacementId, target: PlacementTarget): Promise<void> {
    return this.#commands().execute<void>(WorkbenchCommands.movePlacement, { id, target }, { source: 'api', placementId: id });
  }
  setPartVisible(windowId: WindowId, part: PartId, visible: boolean): Promise<void> {
    return this.#commands().execute<void>(WorkbenchCommands.setPartVisible, { windowId, part, visible }, { source: 'api' });
  }
  resetLayout(): Promise<void> {
    return this.#commands().execute<void>(WorkbenchCommands.resetLayout, {}, { source: 'api' });
  }

  /** Declares the `workbench.*` commands and registers their handlers. Called by the module at Starting. */
  registerCommands(): IDisposable {
    const registry = this.#scope.get(CommandRegistry);
    const store = new DisposableStore('workbench.commands');
    const titles: Record<string, string> = {
      [WorkbenchCommands.showView]: 'Show View',
      [WorkbenchCommands.activatePlacement]: 'Activate Placement',
      [WorkbenchCommands.hidePlacement]: 'Hide Placement',
      [WorkbenchCommands.closePlacement]: 'Close Placement',
      [WorkbenchCommands.movePlacement]: 'Move Placement',
      [WorkbenchCommands.setPartVisible]: 'Set Part Visible',
      [WorkbenchCommands.resetLayout]: 'Reset Layout',
    };
    for (const [id, title] of Object.entries(titles)) store.add(registry.declare({ id, title, category: 'Workbench', owner: 'core', palette: false }));
    const handle = <A, R>(id: string, run: (args: A) => R | Promise<R>): void => {
      store.add(registry.registerHandler<A, R>(id, { run: (args) => run(args) }, 'core'));
    };
    handle(WorkbenchCommands.showView, (a: { viewType: string; options?: ShowViewOptions }) => this.doShowView(a.viewType, a.options));
    handle(WorkbenchCommands.activatePlacement, (a: { id: PlacementId; focus?: boolean | undefined }) => this.doActivate(a.id, a.focus === undefined ? undefined : { focus: a.focus }));
    handle(WorkbenchCommands.hidePlacement, (a: { id: PlacementId }) => this.doHide(a.id));
    handle(WorkbenchCommands.closePlacement, (a: { id: PlacementId; force?: boolean }) => this.doClose(a.id, a.force === true));
    handle(WorkbenchCommands.movePlacement, (a: { id: PlacementId; target: PlacementTarget; slot?: DockSlot }) => this.doMove(a.id, a.target, a.slot));
    handle(WorkbenchCommands.setPartVisible, (a: { windowId: WindowId; part: PartId; visible: boolean }) => this.doSetPartVisible(a.windowId, a.part, a.visible));
    handle(WorkbenchCommands.resetLayout, () => this.doResetLayout());
    this.#subscriptions.add(store);
    return store;
  }

  // ----- showView (15.5 algorithm) -------------------------------------------------------------

  async doShowView(viewType: string, options: ShowViewOptions = {}): Promise<PlacementRef> {
    let descriptor = this.#views.descriptor(viewType);
    if (!descriptor) {
      await this.#scope.get(ActivationService, { optional: true })?.activateByEvent(`onView:${viewType}`);
      descriptor = this.#views.descriptor(viewType);
    }
    if (!descriptor) throw fail('workbench.unknownView', `Unknown view type "${viewType}"`, { viewType });
    if (descriptor.when !== undefined && !this.#windowContext().evaluate(descriptor.when)) {
      throw fail('workbench.viewNotApplicable', `View "${viewType}" does not apply here (when: ${descriptor.when})`, { viewType });
    }
    const keyed = (descriptor.multiplicity ?? 'singleton') === 'keyed';
    const key = keyed ? options.key : '';
    if (key === undefined) throw fail('workbench.keyRequired', `View type "${viewType}" is keyed: pass options.key`, { viewType });
    const target = options.target;
    if (target?.kind === 'newWindow') throw fail('workbench.moveRejected', 'Opening a new window is not supported in v1', { viewType });
    const s = this.#state.peek();
    const workspaceId = (target && 'workspace' in target ? target.workspace : undefined) ?? options.workspace ?? s.overrides.views[viewType]?.workspace ?? descriptor.workspace ?? EDITOR_AREA_WORKSPACE;
    const workspace = s.workspaces[workspaceId];
    if (!workspace) throw fail('workbench.unknownWorkspace', `Unknown workspace "${workspaceId}"`, { workspaceId });
    if (keyed && isContainer(workspace.kind)) throw fail('workbench.moveRejected', `Keyed view type "${viewType}" cannot live in the container workspace "${workspaceId}"`, { viewType, workspaceId });

    const entry = this.#instances.ensureEntry(viewType, key, options.workItem?.path ?? descriptor.workItem ?? 'root');
    const reuse = options.reuse ?? 'activate';
    const focus = options.focus !== false;
    if (reuse === 'activate') {
      const existing = [...entry.placements.peek()].map((id) => this.#placements.get(id)).filter((p): p is PlacementImpl => p !== undefined);
      const inTarget = existing.find((p) => p.workspaceId === workspaceId);
      const reused = inTarget ?? (descriptor.multiPlacement === false ? existing[0] : undefined);
      if (reused) {
        await this.doActivate(reused.id, { focus });
        return reused.ref();
      }
    }
    const container = isContainer(workspace.kind);
    const id = container ? defaultPlacementId(workspaceId, viewType) : (generateId('p') as PlacementId);
    if (this.#placements.has(id)) {
      await this.doActivate(id, { focus });
      return (this.#placements.get(id) as PlacementImpl).ref();
    }
    if (container) {
      this.#userShown.add(id);
      const views = s.overrides.views[viewType];
      if (views?.hidden) this.#setOverrides({ ...s.overrides, views: { ...s.overrides.views, [viewType]: { ...views, hidden: false } } });
    }
    const placement = this.#createPlacement({ id, entry, workspaceId, ...(target?.kind === 'workspace' && target.index !== undefined ? { index: target.index } : {}) });
    // resolve by path: a plugin passes a PluginWorkItem facade, which has no scope
    if (options.workItem) placement.ownerOverride = this.#scope.get(WorkItemService).find(options.workItem.path);
    if (target?.kind === 'dock' && target.position) this.#bindings.get(workspaceId)?.positions.set(id, target.position);
    if (target?.kind === 'floating') this.#update((st) => model.setDockSlot(st, id, { group: 'floating', where: 'floating', popoutId: undefined }, false));
    this.#publishPlacement('placementOpened', placement);
    if (focus) await this.doActivate(id, { focus });
    else await this.#afterChange(workspaceId); // opened in the background: it is not activated or focused
    await this.#settleJob(placement);
    return placement.ref();
  }

  // ----- activate, hide, focus -----------------------------------------------------------------

  async doActivate(id: PlacementId, options?: { readonly focus?: boolean }): Promise<void> {
    const p = this.#placements.get(id);
    if (!p) throw fail('validation', `Unknown placement "${id}"`, { id });
    const wsId = p.workspaceId;
    this.#update((s) => {
      let next = model.setActive(s, wsId, id);
      next = model.setCollapsed(next, wsId, id, false);
      const ws = next.workspaces[wsId];
      if (ws?.partId && isContainer(ws.kind)) {
        const part = next.windows[this.#windowId]?.parts[ws.partId];
        if (part && part.active !== wsId) next = model.withPart(next, this.#windowId, { ...part, active: wsId });
      }
      return next;
    });
    if (options?.focus !== false) this.#setFocus(p);
    this.#activatedEmitter(wsId)?.fire(id);
    await this.#afterChange(wsId);
    await this.#settleJob(p);
  }

  async doHide(id: PlacementId): Promise<void> {
    const p = this.#placements.get(id);
    if (!p) return;
    const ws = this.#state.peek().workspaces[p.workspaceId];
    if (!ws) return;
    if (isContainer(ws.kind)) {
      // a container placement is hidden by a delta (override), the placement itself goes away
      await this.doClose(p.id, true);
      return;
    }
    p.visibleState.set(false);
    p.context.set('placement.visible', false);
    if (p.statusState.peek() === PlacementStatus.Attached) this.#setStatus(p, PlacementStatus.Hidden);
    this.#layout().scheduleSave();
  }

  #activatedEmitter(wsId: string): Emitter<PlacementId> | undefined {
    return this.#activated.get(wsId);
  }

  #setFocus(p: PlacementImpl | undefined): void {
    const previous = this.#state.peek().focus;
    if (previous === p?.id) return;
    if (previous !== undefined) {
      const old = this.#placements.get(previous);
      old?.focusedState.set(false);
      old?.context.set('placement.focused', false);
    }
    this.#update((s) => model.setFocus(s, p?.id));
    p?.focusedState.set(true);
    p?.context.set('placement.focused', true);
    const keys = this.#scope.get(ContextKeyService);
    const win = this.#windowContext();
    win.set('focusedPlacement', p?.id);
    win.set('focusedView', p?.viewType);
    win.set('focusedWorkspace', p?.workspaceId);
    keys.setFocused(p?.context);
    (this.#scope.get(SelectionService, { optional: true }) as DefaultSelectionService | undefined)?.noteFocus(p?.id);
    this.#layout().scheduleSave();
  }

  // ----- close (15.6) --------------------------------------------------------------------------

  /** The close in flight per placement. A second close() joins it; a force call escalates it (skips the pending canClose). */
  readonly #closing = new Map<PlacementId, { readonly promise: Promise<boolean>; escalate(): void }>();

  async doClose(id: PlacementId, force: boolean): Promise<boolean> {
    const pending = this.#closing.get(id);
    if (pending) {
      if (force) pending.escalate();
      return pending.promise;
    }
    const p = this.#placements.get(id);
    if (!p) return true;
    const escalated = new DeferredPromise<void>();
    const promise = this.#closeNow(p, force, escalated.promise).finally(() => {
      this.#closing.delete(id);
    });
    this.#closing.set(id, { promise, escalate: () => escalated.resolve() });
    return promise;
  }

  async #closeNow(p: PlacementImpl, force: boolean, escalated: Promise<void>): Promise<boolean> {
    const descriptor = this.#views.descriptor(p.viewType);
    const previous = p.statusState.peek();
    // 2. presenter veto. Unless force: canClose false on the descriptor, then presenter.canClose().
    this.#setStatus(p, PlacementStatus.Closing);
    if (!force) {
      let allowed = descriptor?.canClose !== false;
      if (allowed) {
        try {
          allowed = (await Promise.race([p.presenter?.canClose?.(), escalated.then(() => true)])) !== false;
        } catch (error) {
          reportError(error, { source: 'view', pluginId: descriptor?.owner ?? 'core', target: `${p.viewType}.canClose` });
          allowed = false; // a throwing veto handler vetoes
        }
      }
      if (!allowed) {
        this.#setStatus(p, previous);
        return false;
      }
    }
    // 3. teardown
    const workspaceId = p.workspaceId;
    const ws = this.#state.peek().workspaces[workspaceId];
    if (ws && isContainer(ws.kind)) {
      const current = this.#state.peek().overrides;
      this.#userShown.delete(p.id);
      this.#setOverrides({ ...current, views: { ...current.views, [p.viewType]: { ...current.views[p.viewType], hidden: true } } });
    }
    await this.#teardown(p);
    this.#publishPlacement('placementClosed', p);
    await this.#afterChange(workspaceId);
    return true;
  }

  /** Disposes presenter, scope, context and the record; releases the view instance. Status ends 'closed'. */
  async #teardown(p: PlacementImpl, options?: { readonly keepLocal?: boolean }): Promise<void> {
    this.#jobs.delete(p.id);
    const wasFocused = this.#state.peek().focus === p.id;
    p.selection?.dispose();
    const scope = p.scope;
    p.presenterState.set(undefined);
    p.scope = undefined;
    if (scope) {
      try {
        await scope.dispose();
      } catch (error) {
        reportError(error, { source: 'dispose', pluginId: this.#views.descriptor(p.viewType)?.owner ?? 'core', target: `placement:${p.id}` });
      }
    }
    this.#update((s) => model.removePlacement(s, p.id));
    this.#placements.delete(p.id);
    this.#instances.detach(p.entry, p.id);
    if (p.acquired) {
      p.acquired = false;
      this.#instances.release(p.entry.id);
    }
    this.#instances.forgetIfUnused(p.entry);
    if (options?.keepLocal && p.localSchema) this.#retained.placements[p.id] = { viewType: p.viewType, instanceId: p.instanceId, workspaceId: p.workspaceId, local: { v: p.localSchema.version, data: p.local.peek() }, dock: this.#state.peek().placements[p.id]?.dock };
    p.statusState.set(PlacementStatus.Closed);
    p.focusedState.set(false);
    p.visibleState.set(false);
    p.context.dispose();
    if (wasFocused) {
      const ws = this.#state.peek().workspaces[p.workspaceId];
      this.#setFocus(ws?.active ? this.#placements.get(ws.active) : undefined);
    }
    this.#layout().scheduleSave();
  }

  // ----- move ----------------------------------------------------------------------------------

  async doMove(id: PlacementId, target: PlacementTarget, slot?: DockSlot): Promise<void> {
    const p = this.#placements.get(id);
    if (!p) throw fail('validation', `Unknown placement "${id}"`, { id });
    const descriptor = this.#views.descriptor(p.viewType);
    if (descriptor?.canMove === false) throw fail('workbench.moveRejected', `View "${p.viewType}" cannot be moved`, { id });
    if (target.kind === 'newWindow') throw fail('workbench.moveRejected', 'Moving to a new window is not supported in v1', { id });
    const from = p.workspaceId;
    const to = target.workspace;
    const toWs = this.#state.peek().workspaces[to];
    if (!toWs) throw fail('workbench.unknownWorkspace', `Unknown workspace "${to}"`, { workspaceId: to });
    if (to === from) {
      if (toWs.kind === WorkspaceKind.Dock) {
        if (slot) this.#update((s) => model.setDockSlot(s, id, slot, true));
        else if (target.kind === 'dock' && target.position) this.#bindings.get(to)?.positions.set(id, target.position);
        await this.#afterChange(to);
      } else if (target.kind === 'workspace' && target.index !== undefined) {
        this.#update((s) => model.movePlacementRecord(s, id, to, target.index));
        await this.#afterChange(to);
      }
      return;
    }
    if (isContainer(this.#state.peek().workspaces[from]?.kind ?? '') && toWs.kind === WorkspaceKind.Dock) {
      // contracts 16.4 rule 3: a container placement moves into a dock by hiding it there and opening a dock placement of the same instance
      await this.doShowView(p.viewType, { key: p.entry.key, workspace: to, reuse: 'new', ...(target.kind === 'dock' && target.position ? { target } : {}) });
      return;
    }
    if (toWs.kind !== WorkspaceKind.Dock && p.entry.key !== '') throw fail('workbench.moveRejected', 'A keyed view cannot move into a container workspace', { id });
    this.#update((s) => model.movePlacementRecord(s, id, to, target.kind === 'workspace' ? target.index : undefined));
    p.workspaceId = to;
    p.context.set('workspace', to);
    if (target.kind === 'dock' && target.position) this.#bindings.get(to)?.positions.set(id, target.position);
    this.#setOverrideWorkspace(p.viewType, to);
    await this.#afterChange(from);
    await this.#afterChange(to);
  }

  #setOverrideWorkspace(viewType: string, workspace: string): void {
    const current = this.#state.peek().overrides;
    this.#setOverrides({ ...current, views: { ...current.views, [viewType]: { ...current.views[viewType], workspace } } });
  }

  async doSetPartVisible(windowId: WindowId, partId: PartId, visible: boolean): Promise<void> {
    const part = this.#state.peek().windows[windowId]?.parts[partId];
    if (!part) throw fail('workbench.unknownWorkspace', `Unknown part "${partId}"`, { partId });
    this.#update((s) => model.withPart(s, windowId, { ...part, visible }));
    this.#windowContext().set(`part.${partId}.visible`, visible);
    await this.#afterChange(undefined);
  }

  /** A lazily migrated view state was reset: keep a copy of the stored value (once per state and session), like a reset layout does. */
  readonly #backedUp = new Set<string>();
  #backupReset(kind: 'shared' | 'local', id: string, stored: StoredValue): void {
    const key = `${LAYOUT_STORAGE_KEY}.bak.${kind}.${id}.v${typeof stored.v === 'number' ? stored.v : 'invalid'}`;
    if (this.#backedUp.has(key)) return;
    this.#backedUp.add(key);
    try {
      this.#scope.get(StorageService).set('project', key, stored);
    } catch (error) {
      reportError(error, { source: 'persistence', target: key });
    }
  }

  async doResetLayout(): Promise<void> {
    // The stored snapshot and the closed-instance cache belong to the layout that is being thrown away: a view hidden there must not
    // come back, and the old local and shared state must not be restored into the new layout.
    this.#snapshot = undefined;
    for (const p of [...this.#placements.values()]) await this.#teardown(p);
    this.#instances.discardAll(); // after the teardown: closing the instances pushes their state into the cache, and retained instances keep theirs
    this.#userShown.clear();
    this.#retained.placements = {};
    this.#retained.instances = {};
    this.#retained.workspaces = {};
    this.#update((s) => model.withOverrides(s, emptyOverrides()));
    this.reconcile();
    await this.#afterChange(undefined);
  }

  createWorkspace(init: WorkspaceInit): IDisposable {
    const record: WorkspaceRecord = {
      id: init.id,
      kind: init.kind,
      windowId: init.windowId ?? this.#windowId,
      partId: init.partId,
      title: init.title,
      icon: init.icon,
      owner: init.owner,
      members: [],
      active: undefined,
      collapsed: [],
      arrangement: undefined,
    };
    this.#addWorkspace(record);
    return toDisposable(() => void this.#track(this.#removeWorkspaceNow(init.id)));
  }

  #addWorkspace(record: WorkspaceRecord): void {
    if (this.#state.peek().workspaces[record.id]) throw fail('validation', `Workspace "${record.id}" already exists`, { id: record.id });
    this.#update((s) => {
      let next = model.withWorkspace(s, record);
      if (record.partId) {
        const part = next.windows[record.windowId]?.parts[record.partId];
        if (part && !part.workspaces.includes(record.id)) next = model.withPart(next, record.windowId, { ...part, workspaces: [...part.workspaces, record.id], active: part.active ?? record.id }, true);
      }
      return next;
    });
    if (record.kind === WorkspaceKind.Dock) this.#ensureBinding(record.id);
  }

  async #removeWorkspaceNow(id: string): Promise<void> {
    const ws = this.#state.peek().workspaces[id];
    if (!ws) return;
    for (const pid of [...ws.members]) {
      const p = this.#placements.get(pid);
      if (p) await this.#teardown(p, { keepLocal: true });
    }
    this.#update((s) => model.removeWorkspace(s, id));
    const binding = this.#bindings.get(id);
    if (binding) {
      this.#bindings.delete(id);
      binding.surface.dispose();
    }
    this.#layout().scheduleSave();
  }

  // ===========================================================================================
  // Placements, presenters, visibility
  // ===========================================================================================

  #createPlacement(init: { id: PlacementId; entry: InstanceEntry; workspaceId: string; index?: number; storedLocal?: StoredValue; dock?: DockSlot; status?: PlacementRecord['status'] }): PlacementImpl {
    const context = this.#windowContext().createChild(`placement:${init.id}`);
    context.set('view', init.entry.viewType);
    context.set('workspace', init.workspaceId);
    context.set('placement.focused', false);
    context.set('placement.visible', false);
    const placement = new PlacementImpl({
      id: init.id,
      viewType: init.entry.viewType,
      entry: init.entry,
      workspaceId: init.workspaceId,
      windowId: this.#windowId,
      context,
      status: init.status ?? PlacementStatus.Pending,
      storedLocal: init.storedLocal,
      titleOf: (viewType) => this.#views.descriptors.get().get(viewType)?.title ?? viewType,
    });
    this.#placements.set(init.id, placement);
    this.#instances.attach(init.entry, init.id);
    const record: PlacementRecord = { id: init.id, viewType: init.entry.viewType, instanceId: init.entry.id, workspaceId: init.workspaceId, status: placement.statusState.peek(), dock: init.dock };
    this.#update((s) =>
      model.addPlacement(s, record, { id: init.entry.id, viewType: init.entry.viewType, key: init.entry.key, workItemPath: init.entry.workItemPath }, init.index),
    );
    this.#layout().scheduleSave();
    return placement;
  }

  #setStatus(p: PlacementImpl, status: PlacementRecord['status']): void {
    if (p.statusState.peek() === status) return;
    p.statusState.set(status);
    if (this.#state.peek().placements[p.id]) this.#update((s) => model.setStatus(s, p.id, status), false);
  }

  /** Recomputes which container placements are visible. Dock placements get their visibility from the surface. */
  #syncVisibility(): void {
    const s = this.#state.peek();
    for (const ws of Object.values(s.workspaces)) {
      if (!isContainer(ws.kind)) continue;
      const part = ws.partId ? s.windows[ws.windowId]?.parts[ws.partId] : undefined;
      const partShown = part ? part.visible && part.active === ws.id : true;
      for (const id of ws.members) {
        const p = this.#placements.get(id);
        if (!p) continue;
        const exclusive = ws.kind === WorkspaceKind.Tabs || ws.kind === WorkspaceKind.Deck || ws.kind === WorkspaceKind.Dialog;
        const shown = partShown && (exclusive ? ws.active === id : !ws.collapsed.includes(id));
        this.#setVisible(p, shown);
      }
    }
    for (const ws of Object.values(s.workspaces)) {
      if (ws.kind !== WorkspaceKind.Dock || this.#bindings.has(ws.id)) continue;
      // no dock surface at all (no adapter installed): the active member counts as visible
      for (const id of ws.members) {
        const p = this.#placements.get(id);
        if (p) this.#setVisible(p, ws.active === id);
      }
    }
  }

  #setVisible(p: PlacementImpl, visible: boolean): void {
    if (p.visibleState.peek() === visible) {
      if (visible && !p.presenter && !this.#jobs.has(p.id) && p.statusState.peek() === PlacementStatus.Pending) this.#startJob(p);
      return;
    }
    p.visibleState.set(visible);
    p.context.set('placement.visible', visible);
    const status = p.statusState.peek();
    if (visible) {
      if (p.presenter) {
        if (status === PlacementStatus.Hidden) this.#setStatus(p, PlacementStatus.Attached);
      } else if (status === PlacementStatus.Pending || status === PlacementStatus.Placeholder) {
        this.#startJob(p);
      }
    } else if (status === PlacementStatus.Attached) {
      this.#setStatus(p, PlacementStatus.Hidden);
    }
  }

  async #afterChange(workspaceId: string | undefined): Promise<void> {
    this.#syncVisibility();
    this.#layout().scheduleSave();
    if (workspaceId !== undefined) await this.#syncDock(workspaceId);
    else await Promise.all([...this.#bindings.keys()].map((id) => this.#syncDock(id)));
  }

  async #settleJob(p: PlacementImpl): Promise<void> {
    const job = this.#jobs.get(p.id);
    if (job) await job.catch(() => undefined);
  }

  // ----- presenter creation (15.7 rule 1) -------------------------------------------------------

  #startJob(p: PlacementImpl): Promise<void> {
    const existing = this.#jobs.get(p.id);
    if (existing) return existing;
    const job = this.#createPresenter(p).finally(() => {
      if (this.#jobs.get(p.id) === job) this.#jobs.delete(p.id);
    });
    this.#jobs.set(p.id, job);
    return job;
  }

  async ensurePresenter(id: PlacementId): Promise<Presenter | undefined> {
    const p = this.#placements.get(id);
    if (!p) return undefined;
    if (!p.presenter) await this.#startJob(p);
    return p.presenter;
  }

  async #createPresenter(p: PlacementImpl): Promise<void> {
    const descriptor = this.#views.descriptor(p.viewType);
    if (!descriptor) {
      this.#makePlaceholder(p, `Unknown view type "${p.viewType}"`);
      return;
    }
    let provider = this.#views.provider(p.viewType) as ViewProvider | undefined;
    if (!provider) {
      await this.#scope.get(ActivationService, { optional: true })?.activateByEvent(`onView:${p.viewType}`);
      provider = this.#views.provider(p.viewType) as ViewProvider | undefined;
    }
    if (p.statusState.peek() === PlacementStatus.Closing || p.statusState.peek() === PlacementStatus.Closed || !this.#placements.has(p.id)) return;
    if (!provider) {
      this.#makePlaceholder(p, this.#whyMissing(descriptor));
      return;
    }
    // the owner WorkItem (15.4 rule 2)
    const workItems = this.#scope.get(WorkItemService);
    const owner: WorkItem = p.ownerOverride ?? workItems.find(p.entry.workItemPath) ?? workItems.find(descriptor.workItem ?? 'root') ?? this.#fallbackOwner(workItems.root, descriptor);
    // The previous live part of this instance may still be disposing (retire, suspend, reset): wait, so two view models never overlap.
    await this.#instances.whenRetired(p.viewType, p.entry.key);
    if (p.statusState.peek() === PlacementStatus.Closing || p.statusState.peek() === PlacementStatus.Closed || !this.#placements.has(p.id)) return;
    let instance: ViewInstance;
    try {
      instance = this.#instances.acquire(p.viewType, p.entry.key, owner);
      p.acquired = true;
    } catch (error) {
      reportError(error, { source: 'view', pluginId: descriptor.owner, target: p.viewType });
      this.#makePlaceholder(p, `The view model of "${p.viewType}" failed: ${messageOf(error)}`);
      return;
    }
    // local state: migrated from the stored value, or initial
    const localSchema = provider.localState as StateSchema<unknown> | undefined;
    p.localSchema = localSchema;
    if (localSchema) {
      const result = migrateValue(p.storedLocal, localSchema);
      p.local.set(result.value);
      if (result.status === MigrationStatus.ResetInvalid || result.status === MigrationStatus.ResetNewer || result.status === MigrationStatus.ResetNoPath) {
        if (p.storedLocal !== undefined) this.#backupReset('local', p.id, p.storedLocal);
        reportError(result.error ?? new Error(`Local state of "${p.viewType}" was reset (${result.status})`), { source: 'view', pluginId: descriptor.owner, target: `${p.viewType}.localState` });
      }
    }
    const scope = instance.scope.createChild('placement', p.id);
    const store = new DisposableStore(`placement:${p.id}`);
    scope.track(store);
    // An edit of the view's local or shared state schedules a layout save (the watches end with the placement scope).
    scope.track(this.#autosave.watch(p.local));
    scope.track(this.#autosave.watch(instance.shared));
    const selection = (this.#scope.get(SelectionService) as DefaultSelectionService).publisherFor(p.id);
    const ctx: PresenterContext<unknown, unknown> = {
      placement: p.ref(),
      instance: { id: instance.id, viewType: instance.viewType, key: instance.key, workItemPath: instance.workItemPath },
      viewModel: instance.viewModel,
      local: p.local,
      workItem: owner,
      context: p.context,
      visible: p.visible,
      focused: p.focused,
      selection,
      store,
    };
    let presenter: Presenter;
    try {
      presenter = scope.run(() => (provider as ViewProvider).createPresenter(ctx));
      scope.track(presenter);
    } catch (error) {
      reportError(error, { source: 'view', pluginId: descriptor.owner, target: `${p.viewType}.createPresenter` });
      selection.dispose();
      await scope.dispose().catch(() => undefined);
      p.acquired = false;
      this.#instances.release(p.entry.id);
      this.#makePlaceholder(p, `The presenter of "${p.viewType}" failed: ${messageOf(error)}`);
      return;
    }
    if (!this.#placements.has(p.id)) {
      await scope.dispose().catch(() => undefined);
      return;
    }
    p.scope = scope;
    p.store = store;
    p.selection = selection;
    p.problem = undefined;
    p.presenterState.set(presenter);
    this.#setStatus(p, p.visibleState.peek() ? PlacementStatus.Attached : PlacementStatus.Hidden);
    this.#layout().scheduleSave();
  }

  #fallbackOwner(root: WorkItem, descriptor: ViewDescriptor): WorkItem {
    this.#logger()?.warn(`View "${descriptor.id}" names the WorkItem "${descriptor.workItem}", which does not exist; using the root WorkItem`);
    return root;
  }

  #whyMissing(descriptor: ViewDescriptor): string {
    const status = this.#scope.get(PluginManager, { optional: true })?.status(descriptor.owner);
    if (status?.state === 'failed') return `Plugin "${descriptor.owner}" failed (${status.failure?.cause ?? 'unknown'})`;
    if (status && status.state !== 'active') return `Plugin "${descriptor.owner}" is ${status.state}`;
    return `The plugin "${descriptor.owner}" did not register a provider for "${descriptor.id}"`;
  }

  #workItemTerminated(path: string): void {
    if (this.#scope.state !== 'active') return; // the window is closing: the layout was saved before the scopes went
    // During a shutdown every plugin ends and its WorkItems terminate; the layout must keep the placements for the next session.
    const shutdown = this.#scope.get(LifecycleService, { optional: true })?.shutdownState.peek();
    if (shutdown !== undefined && shutdown !== 'running' && shutdown !== 'vetoing') return;
    const affected = [...this.#placements.values()].filter(
      (p) => p.entry.workItemPath === path && p.statusState.peek() !== PlacementStatus.Placeholder && p.statusState.peek() !== PlacementStatus.Closing && p.statusState.peek() !== PlacementStatus.Closed,
    );
    if (affected.length === 0) return;
    this.#track(
      (async () => {
        for (const p of affected) {
          if (this.#placements.get(p.id) !== p) continue;
          try {
            this.#setStatus(p, PlacementStatus.Closing);
            await this.#teardown(p, { keepLocal: true });
            this.#publishPlacement('placementClosed', p);
            await this.#afterChange(p.workspaceId);
          } catch (error) {
            reportError(error, { source: 'view', pluginId: this.#views.descriptor(p.viewType)?.owner ?? 'core', target: `workItemTerminated:${path}` });
          }
        }
      })(),
    );
  }

  #makePlaceholder(p: PlacementImpl, problem: string): void {
    p.problem = problem;
    this.#setStatus(p, PlacementStatus.Placeholder);
  }

  /** The plugin that owns the view types is going away: presenters end, local and shared state stay. */
  #pluginStopped(pluginId: string, reason: string): void {
    // placements that are already placeholders were handled by an earlier signal (state change, then provider removal)
    const affected = [...this.#placements.values()].filter((p) => this.#views.descriptor(p.viewType)?.owner === pluginId && p.statusState.peek() !== PlacementStatus.Placeholder);
    if (affected.length === 0) return;
    const types = new Set(affected.map((p) => p.viewType));
    // The instances are Retiring from now on, before the (slow) presenter disposals run: a plugin that comes back at once (reload)
    // waits in whenRetired() and never gets the old view model.
    for (const viewType of types) this.#instances.beginSuspend(viewType);
    this.#track(
      (async () => {
        for (const p of affected) await this.#suspend(p, reason);
        for (const viewType of types) this.#instances.suspendViewType(viewType);
      })(),
    );
  }

  async #suspend(p: PlacementImpl, reason: string): Promise<void> {
    // the placeholder is visible at once; the later signal (provider removed) then finds it handled
    this.#makePlaceholder(p, reason);
    this.#jobs.delete(p.id);
    p.selection?.dispose();
    p.selection = undefined;
    const scope = p.scope;
    if (p.localSchema) p.storedLocal = { v: p.localSchema.version, data: p.local.peek() };
    p.presenterState.set(undefined);
    p.scope = undefined;
    p.store = undefined;
    if (scope) {
      try {
        await scope.dispose();
      } catch (error) {
        reportError(error, { source: 'dispose', pluginId: this.#views.descriptor(p.viewType)?.owner ?? 'core', target: `placement:${p.id}` });
      }
    }
    p.acquired = false;
  }

  #providerAppeared(viewType: string): void {
    for (const p of this.#placements.values()) {
      if (p.viewType !== viewType || p.presenter || p.statusState.peek() === PlacementStatus.Closing) continue;
      this.#setStatus(p, PlacementStatus.Pending);
      p.problem = undefined;
      if (p.visibleState.peek()) this.#startJob(p);
    }
  }

  #providerGone(viewType: string): void {
    // the plugin deactivated without a state event we saw (a direct dispose): treat it like a stop
    const owner = this.#views.descriptor(viewType)?.owner;
    if (owner) this.#pluginStopped(owner, `The provider of "${viewType}" was removed`);
  }

  // ===========================================================================================
  // Adapter port (15.8) and dock sync (15.9)
  // ===========================================================================================

  reportVisible(id: PlacementId, visible: boolean): void {
    const p = this.#placements.get(id);
    if (!p) return;
    const ws = this.#state.peek().workspaces[p.workspaceId];
    if (!ws || isContainer(ws.kind)) return; // container visibility is derived from the model
    this.#setVisible(p, visible);
  }

  reportFocus(id: PlacementId | undefined): void {
    this.#setFocus(id === undefined ? undefined : this.#placements.get(id));
  }

  requestClose(id: PlacementId): void {
    this.#track(
      this.#commands()
        .execute(WorkbenchCommands.closePlacement, { id, force: false }, { source: 'view', placementId: id })
        .catch((error: unknown) => reportError(error, { source: 'command', target: WorkbenchCommands.closePlacement })),
    );
  }

  reportDockChange(workspaceId: string, change: DockChange): void {
    if (change.origin === 'model') return; // an echo of apply(): dropped (15.9 rule 1)
    this.#track(this.#handleDockChange(workspaceId, change));
  }

  async #handleDockChange(workspaceId: string, change: DockChange): Promise<void> {
    const binding = this.#bindings.get(workspaceId);
    const ws = this.#state.peek().workspaces[workspaceId];
    if (!binding || !ws || ws.kind !== WorkspaceKind.Dock) return;
    // rule 3: a report built against an older revision is rebased; membership is never taken from it
    if (change.revision < this.#state.peek().revision) {
      await this.#syncDock(workspaceId);
      return;
    }
    if (change.reasons.has('geometry')) {
      this.#update((s) => model.setArrangement(s, workspaceId, binding.surface.snapshot()), false);
      this.#layout().scheduleSave();
    }
    let reverted = false;
    if (change.reasons.has('structure') && change.projection) {
      const members = new Set(this.#state.peek().workspaces[workspaceId]?.members ?? []);
      const projected = change.projection;
      // a member missing from the projection, or an unknown id in it, is drift: the model wins
      for (const id of members) if (!projected.has(id)) reverted = true;
      for (const id of projected.keys()) if (!members.has(id)) reverted = true;
      for (const [id, slot] of projected) {
        if (!members.has(id)) continue;
        const current = this.#state.peek().placements[id]?.dock;
        if (current && current.group === slot.group && current.where === slot.where && current.popoutId === slot.popoutId) continue;
        try {
          // rule 4: the surface report is a proposal; it becomes a command that interceptors may veto
          await this.#commands().execute(WorkbenchCommands.movePlacement, { id, target: { kind: 'dock', workspace: workspaceId }, slot }, { source: 'view', placementId: id });
        } catch {
          reverted = true; // vetoed or invalid: the tab goes back (the command service already reported nothing for a plain veto)
        }
      }
    }
    if (change.reasons.has('active') && change.active !== undefined && this.#state.peek().workspaces[workspaceId]?.members.includes(change.active) && this.#state.peek().workspaces[workspaceId]?.active !== change.active) {
      try {
        await this.#commands().execute(WorkbenchCommands.activatePlacement, { id: change.active, focus: true }, { source: 'view', placementId: change.active });
      } catch {
        reverted = true;
      }
    }
    void reverted; // a sync follows in every case: with an unchanged revision the surface restores, with a new one it adopts
    await this.#syncDock(workspaceId);
  }

  #ensureBinding(workspaceId: string): DockBinding | undefined {
    const existing = this.#bindings.get(workspaceId);
    if (existing) return existing;
    const factory = this.#scope.get(DockSurfaceFactory, { optional: true });
    if (!factory) return undefined;
    const surface = factory.create(workspaceId);
    const binding = new DockBinding(surface, workspaceId);
    this.#bindings.set(workspaceId, binding);
    this.#subscriptions.add(surface.onDidChange((change) => this.reportDockChange(workspaceId, change)));
    // Headless and test hosts have no host element. A renderer replaces this call by mounting the surface itself.
    surface.mount(undefined, { mounter: NULL_MOUNTER, adapter: this, workspaceId });
    return binding;
  }

  /** Creates the surfaces of all dock workspaces. The module calls it once when the factory is available. */
  ensureSurfaces(): void {
    for (const ws of Object.values(this.#state.peek().workspaces)) if (ws.kind === WorkspaceKind.Dock) this.#ensureBinding(ws.id);
  }

  #syncDock(workspaceId: string): Promise<void> {
    const binding = this.#bindings.get(workspaceId);
    if (!binding) return Promise.resolve();
    return binding.sync(() => this.#desired(binding));
  }

  #desired(binding: DockBinding): DockDesired {
    const s = this.#state.peek();
    const ws = s.workspaces[binding.workspaceId];
    const members = (ws?.members ?? []).map((id) => {
      const record = s.placements[id];
      const placement = this.#placements.get(id);
      const position = binding.positions.get(id);
      binding.positions.delete(id);
      return { id, title: placement?.title.peek() ?? record?.viewType ?? id, position, where: record?.dock?.where ?? ('grid' as const) };
    });
    return { revision: s.revision, members, active: ws?.active };
  }

  // ===========================================================================================
  // Defaults from contributions, overrides
  // ===========================================================================================

  /** Registers a container workspace definition from the `workspaces` point. */
  addWorkspaceDef(value: WorkspaceContribution, owner: string): IDisposable {
    const key = `${owner}\u0000${value.id}`;
    this.#defs.set(key, { value, owner, seq: this.#defSeq++ });
    this.reconcile();
    return toDisposable(() => {
      this.#defs.delete(key);
      this.reconcile();
    });
  }

  #setOverrides(overrides: WorkbenchState['overrides']): void {
    this.#update((s) => model.withOverrides(s, overrides));
  }

  /**
   * Builds container workspaces and their default placements from definitions, view descriptors and overrides
   * (restore steps 3 and 4, contracts.md 16.4 delta rules 1 and 5). Idempotent: it runs again whenever a plugin
   * adds or removes definitions, so contributed views show up without plugin code.
   */
  reconcile(): void {
    // Defaults are built at restore step 3, after the snapshot is known (so stored local state attaches). Before that, only collect definitions.
    if (this.#disposed || !this.#layoutLoaded) return;
    const s0 = this.#state.peek();
    const overrides = s0.overrides;
    const wanted = [...this.#defs.values()]
      .filter((d) => overrides.workspaces[d.value.id]?.hidden !== true)
      .filter((d) => d.value.when === undefined || this.#whenHolds(d.value.when))
      .sort((a, b) => (overrides.workspaces[a.value.id]?.order ?? a.value.order ?? 0) - (overrides.workspaces[b.value.id]?.order ?? b.value.order ?? 0) || a.seq - b.seq);
    const wantedIds = new Set(wanted.map((d) => d.value.id));
    // workspaces that came from definitions and are gone now
    for (const id of [...this.#defWorkspaces]) {
      if (wantedIds.has(id)) continue;
      this.#defWorkspaces.delete(id);
      this.#track(this.#removeWorkspaceNow(id));
    }
    for (const def of wanted) {
      if (this.#state.peek().workspaces[def.value.id]) continue;
      const part = overrides.workspaces[def.value.id]?.part ?? def.value.part;
      this.#addWorkspace({
        id: def.value.id,
        kind: def.value.kind,
        windowId: this.#windowId,
        partId: part,
        title: def.value.title,
        icon: def.value.icon,
        owner: def.owner,
        members: [],
        active: undefined,
        collapsed: this.#snapshot?.workspaces[def.value.id]?.collapsed.map((c) => c as PlacementId) ?? [],
        arrangement: undefined,
      });
      this.#defWorkspaces.add(def.value.id);
    }
    // default placements of container workspaces
    const descriptors = [...this.#views.descriptors.peek().values()];
    for (const ws of Object.values(this.#state.peek().workspaces)) {
      if (!isContainer(ws.kind)) continue;
      const mine = descriptors
        .filter((d) => (d.multiplicity ?? 'singleton') === 'singleton')
        .filter((d) => (overrides.views[d.id]?.workspace ?? d.workspace ?? EDITOR_AREA_WORKSPACE) === ws.id)
        .filter((d) => overrides.views[d.id]?.hidden !== true)
        .filter((d) => d.when === undefined || this.#whenHolds(d.when))
        .filter((d) => d.visibleByDefault !== false || this.#userShown.has(defaultPlacementId(ws.id, d.id)) || this.#snapshot?.placements[defaultPlacementId(ws.id, d.id)] !== undefined)
        .sort((a, b) => (overrides.views[a.id]?.order ?? a.order ?? 0) - (overrides.views[b.id]?.order ?? b.order ?? 0));
      const mineIds = new Set(mine.map((d) => defaultPlacementId(ws.id, d.id)));
      for (const d of mine) {
        const id = defaultPlacementId(ws.id, d.id);
        if (this.#placements.has(id)) continue;
        const entry = this.#entryFor(d.id, '', d.workItem ?? 'root');
        const stored = this.#storedLocalOfContainerPlacement(id, d.id);
        delete this.#retained.placements[id];
        this.#createPlacement({ id, entry, workspaceId: ws.id, ...(stored ? { storedLocal: stored } : {}) });
      }
      for (const pid of ws.members) {
        if (mineIds.has(pid)) continue;
        const p = this.#placements.get(pid);
        if (p && !this.#views.descriptor(p.viewType)) this.#track(this.#teardown(p, { keepLocal: true }));
        else if (p && overrides.views[p.viewType]?.hidden === true) this.#track(this.#teardown(p, { keepLocal: true }));
      }
      // a side bar shows the first workspace that has members when nothing is active yet
    }
    this.#fixPartActive();
    this.#syncVisibility();
    this.#layout().scheduleSave();
  }

  /**
   * The stored local state of a container placement. The id of a container placement is built from the workspace and the view type,
   * so a view that was moved to another container workspace has a new id: its local state is found by view type among the
   * placements that are not materialized (retained after a move or a close) and among the placements of the stored snapshot.
   */
  #storedLocalOfContainerPlacement(id: PlacementId, viewType: string): StoredValue | undefined {
    const direct = this.#snapshot?.placements[id]?.local ?? this.#retained.placements[id]?.local;
    if (direct) return direct;
    const container = (workspaceId: string): boolean => {
      const ws = this.#state.peek().workspaces[workspaceId];
      return ws === undefined || isContainer(ws.kind);
    };
    for (const [otherId, ps] of Object.entries(this.#retained.placements)) {
      if (ps.viewType !== viewType || !ps.local || !container(ps.workspaceId)) continue;
      delete this.#retained.placements[otherId];
      return ps.local;
    }
    for (const [otherId, ps] of Object.entries(this.#snapshot?.placements ?? {})) {
      if (otherId !== id && ps.viewType === viewType && ps.local && container(ps.workspaceId) && !this.#placements.has(otherId as PlacementId)) return ps.local;
    }
    return undefined;
  }

  #fixPartActive(): void {
    const s = this.#state.peek();
    const window = s.windows[this.#windowId];
    if (!window) return;
    for (const part of Object.values(window.parts)) {
      if (!part || part.workspaces.length === 0) continue;
      if (part.active && part.workspaces.includes(part.active)) continue;
      this.#update((st) => model.withPart(st, this.#windowId, { ...part, active: part.workspaces[0] }));
    }
    for (const ws of Object.values(this.#state.peek().workspaces)) {
      if (isContainer(ws.kind) && (ws.active === undefined || !ws.members.includes(ws.active)) && ws.members.length > 0) {
        this.#update((st) => model.setActive(st, ws.id, ws.members[0]));
      }
    }
  }

  #whenHolds(when: string): boolean {
    try {
      return this.#windowContext().evaluate(when);
    } catch (error) {
      reportError(error, { source: 'view', target: `when:${when}` });
      return false;
    }
  }

  #entryFor(viewType: string, key: string, workItemPath: string): InstanceEntry {
    const stored = this.#snapshot ? Object.entries(this.#snapshot.instances).find(([, i]) => i.viewType === viewType && i.key === key) : undefined;
    return this.#instances.ensureEntry(viewType, key, stored?.[1].workItemPath ?? workItemPath, stored ? { id: stored[0] as ViewInstanceId, ...(stored[1].shared ? { storedShared: stored[1].shared } : {}) } : undefined);
  }

  // ===========================================================================================
  // Snapshot and restore (16.4, 16.5)
  // ===========================================================================================

  /** Last snapshot built, with capped states: a state that is too large keeps the value stored there. */
  #lastBuilt: WorkbenchSnapshot | undefined;
  readonly #oversizeReported = new Set<string>();

  /**
   * A view state above MAX_VIEW_STATE_BYTES is left out of the snapshot (the layout key has a 1 MB limit, and one big state would
   * veto the save of the whole layout). The last stored value stays (undefined: the schema's initial value applies on restore).
   * Reported once per state with layout.viewStateTooLarge and the plugin id of the view.
   */
  #capState(value: StoredValue | undefined, previous: StoredValue | undefined, label: string, viewType: string): StoredValue | undefined {
    if (value === undefined) return value;
    let size: number;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      size = Infinity;
    }
    if (size <= MAX_VIEW_STATE_BYTES) return value;
    if (!this.#oversizeReported.has(label)) {
      this.#oversizeReported.add(label);
      const owner = this.#views.descriptor(viewType)?.owner;
      reportError(
        new TesseraError('layout.viewStateTooLarge', `The ${label} state of view "${viewType}" is ${Number.isFinite(size) ? size : 'too many'} bytes, above ${MAX_VIEW_STATE_BYTES}. It is not saved; the last saved value is kept`, {
          details: { label, viewType, size, limit: MAX_VIEW_STATE_BYTES },
        }),
        { source: 'persistence', target: 'workbench.layout', ...(owner !== undefined ? { pluginId: owner } : {}) },
      );
    }
    return previous;
  }

  snapshot(): WorkbenchSnapshot {
    const built = this.#buildSnapshot();
    this.#lastBuilt = built;
    return built;
  }

  #buildSnapshot(): WorkbenchSnapshot {
    const previous = this.#lastBuilt ?? this.#snapshot;
    const s = this.#state.peek();
    const window = s.windows[this.#windowId];
    const placements: Record<string, WorkbenchSnapshot['placements'][string]> = { ...this.#retained.placements };
    for (const record of Object.values(s.placements)) {
      const p = this.#placements.get(record.id);
      let local: StoredValue | undefined = p?.storedLocal;
      if (p?.presenter && p.localSchema) local = { v: p.localSchema.version, data: p.local.peek() };
      local = this.#capState(local, previous?.placements[record.id]?.local, `placement ${record.id} local`, record.viewType);
      placements[record.id] = { viewType: record.viewType, instanceId: record.instanceId, workspaceId: record.workspaceId, local, dock: record.dock };
    }
    const instances: Record<string, WorkbenchSnapshot['instances'][string]> = { ...this.#retained.instances };
    for (const entry of this.#instances.entries()) {
      const shared = this.#capState(this.#instances.sharedOf(entry), previous?.instances[entry.id]?.shared, `instance ${entry.id} shared`, entry.viewType);
      instances[entry.id] = { viewType: entry.viewType, key: entry.key, workItemPath: entry.workItemPath, shared };
    }
    const workspaces: Record<string, WorkbenchSnapshot['workspaces'][string]> = { ...this.#retained.workspaces };
    for (const ws of Object.values(s.workspaces)) {
      workspaces[ws.id] = {
        active: ws.active,
        collapsed: [...ws.collapsed],
        members: ws.kind === WorkspaceKind.Dock ? [...ws.members] : undefined,
        // the live blob of the surface is the truth for geometry; the record holds the last reported one
        arrangement: this.#bindings.get(ws.id)?.surface.snapshot() ?? ws.arrangement,
      };
    }
    const parts: Record<string, { visible: boolean; size: number | undefined; active: string | undefined }> = {};
    for (const part of Object.values(window?.parts ?? {})) if (part) parts[part.id] = { visible: part.visible, size: part.size, active: part.active };
    return {
      savedAt: new Date().toISOString(),
      appVersion: this.#appVersion,
      windows: [{ id: this.#windowId, kind: 'main', bounds: window?.bounds, parts }],
      workspaces,
      placements,
      instances,
      closedInstances: [...this.#instances.closedInstances],
      overrides: s.overrides,
      focus: s.focus,
    };
  }

  /** Restore steps 2 to 6 (phase Ready). View models and presenters do not exist yet. */
  async loadLayout(): Promise<void> {
    const result = await this.#layout().load();
    const usable = result.status === MigrationStatus.Current || result.status === MigrationStatus.Migrated;
    if (!usable && result.status !== MigrationStatus.Missing) {
      this.#logger()?.warn(`The stored layout was not used (${result.status}); a backup was kept and the default layout applies`);
    }
    const snapshot = usable ? result.value : undefined;
    this.#snapshot = snapshot;
    if (snapshot) {
      this.#instances.restoreClosed(snapshot.closedInstances);
      this.#update((s) => model.withOverrides(s, snapshot.overrides));
      const part = snapshot.windows[0]?.parts;
      for (const [id, saved] of Object.entries(part ?? {})) {
        const record = this.#state.peek().windows[this.#windowId]?.parts[id as PartId];
        if (record) this.#update((s) => model.withPart(s, this.#windowId, { ...record, visible: saved.visible, size: saved.size, active: saved.active ?? record.active }));
      }
    }
    // steps 3 and 4: defaults from contributions plus overrides
    this.#layoutLoaded = true;
    this.reconcile();
    if (snapshot) this.#restoreFromSnapshot(snapshot);
  }

  /**
   * Internal. Throws the session's layout away and builds the workbench again from the stored snapshot (the reset path, then the startup
   * reconcile). LayoutStore's storage subscription calls it when the stored layout arrives late (retryLoad after degraded mode).
   */
  async reloadLayout(): Promise<void> {
    await this.doResetLayout();
    this.#layoutLoaded = false;
    this.#restoring = undefined;
    await this.loadLayout();
    await this.whenRestored();
  }

  /** Steps 5 and 6: dock placements from the snapshot (ids kept), stored state attached, nothing created yet. */
  #restoreFromSnapshot(snapshot: WorkbenchSnapshot): void {
    this.ensureSurfaces();
    const order = new Map<string, number>();
    for (const [wsId, saved] of Object.entries(snapshot.workspaces)) (saved.members ?? []).forEach((id, i) => order.set(`${wsId}\u0000${id}`, i));
    const dockPlacements = Object.entries(snapshot.placements)
      .filter(([, ps]) => this.#state.peek().workspaces[ps.workspaceId]?.kind === WorkspaceKind.Dock)
      .sort((a, b) => (order.get(`${a[1].workspaceId}\u0000${a[0]}`) ?? 0) - (order.get(`${b[1].workspaceId}\u0000${b[0]}`) ?? 0));
    for (const [id, ps] of dockPlacements) {
      try {
        const stored = snapshot.instances[ps.instanceId];
        const entry = this.#instances.ensureEntry(ps.viewType, stored?.key ?? '', stored?.workItemPath ?? 'root', {
          id: ps.instanceId as ViewInstanceId,
          ...(stored?.shared ? { storedShared: stored.shared } : {}),
        });
        const known = this.#views.descriptor(ps.viewType) !== undefined;
        const placement = this.#createPlacement({ id: id as PlacementId, entry, workspaceId: ps.workspaceId, ...(ps.local ? { storedLocal: ps.local } : {}), ...(ps.dock ? { dock: ps.dock } : {}), });
        if (!known) this.#makePlaceholder(placement, `Unknown view type "${ps.viewType}"`);
      } catch (error) {
        reportError(error, { source: 'unknown', target: `restore:${id}` });
      }
    }
    // everything that cannot be materialized stays as it was
    for (const [id, ps] of Object.entries(snapshot.placements)) {
      if (this.#placements.has(id as PlacementId)) continue;
      const ws = this.#state.peek().workspaces[ps.workspaceId];
      if (!ws || ws.kind === WorkspaceKind.Dock) {
        if (!ws) this.#retained.placements[id] = ps;
      }
    }
    for (const [id, saved] of Object.entries(snapshot.workspaces)) {
      const ws = this.#state.peek().workspaces[id];
      if (!ws) this.#retained.workspaces[id] = saved;
      else {
        const active = saved.active && this.#placements.has(saved.active as PlacementId) ? (saved.active as PlacementId) : ws.active;
        this.#update((s) => model.setArrangement(model.setActive(s, id, active), id, saved.arrangement));
      }
    }
    this.#fixPartActive();
  }

  /** Steps 7 to 10, run once after the host mounted the window (the shell calls whenRestored after mount). */
  whenRestored(): Promise<void> {
    this.#restoring ??= this.#completeRestore();
    return this.#restoring;
  }

  async #completeRestore(): Promise<void> {
    try {
      this.ensureSurfaces();
      const snapshot = this.#snapshot;
      for (const [id, binding] of this.#bindings) {
        const ws = this.#state.peek().workspaces[id];
        if (!ws) continue;
        const arrangement = snapshot?.workspaces[id]?.arrangement ?? ws.arrangement;
        if (arrangement) {
          try {
            const report = await binding.surface.restore(arrangement, new Set(ws.members));
            for (const dropped of report.dropped) {
              const p = this.#placements.get(dropped);
              if (p) await this.#teardown(p, { keepLocal: true });
            }
            if (report.rebuilt) this.#logger()?.warn(`The dock arrangement of "${id}" was rejected and rebuilt from its members`);
          } catch (error) {
            reportError(error, { source: 'unknown', target: `restore:${id}` });
          }
        }
        await this.#syncDock(id);
      }
      this.#syncVisibility();
      // step 9: presenters of visible placements only
      await this.settle();
      const focus = snapshot?.focus as PlacementId | undefined;
      if (focus !== undefined && this.#placements.has(focus)) this.#setFocus(this.#placements.get(focus));
      this.#restoredPlacements = this.#placements.size;
      this.#scope.get(EventBus).root.publish(CoreTopics.workbenchRestored, { placements: this.#restoredPlacements });
    } catch (error) {
      reportError(error, { source: 'unknown', target: 'workbench.restore' });
    }
  }

  // ----- misc ----------------------------------------------------------------------------------

  #update(fn: (s: WorkbenchState) => WorkbenchState, save = true): void {
    const next = fn(this.#state.peek());
    if (next === this.#state.peek()) return;
    this.#state.set(next);
    if (save) this.#layout().scheduleSave();
  }

  #publishPlacement(topic: 'placementOpened' | 'placementClosed', p: PlacementImpl): void {
    try {
      this.#scope.get(EventBus).root.publish(CoreTopics[topic], { placement: p.ref() });
    } catch (error) {
      reportError(error, { source: 'unknown', target: topic });
    }
  }

  checkDockInvariantFor(workspaceId: string): string | undefined {
    return this.checkDockInvariant(workspaceId);
  }

  /** Dev-mode invariant (15.9 rule 8): the panel ids of a surface equal the members of its workspace. */
  checkDockInvariant(workspaceId: string): string | undefined {
    const binding = this.#bindings.get(workspaceId);
    const surface = binding?.surface as { panelIds?: () => readonly PlacementId[] } | undefined;
    if (!surface?.panelIds) return undefined;
    const members = [...(this.#state.peek().workspaces[workspaceId]?.members ?? [])].sort();
    const panels = [...surface.panelIds()].sort();
    if (members.length === panels.length && members.every((m, i) => m === panels[i])) return undefined;
    const problem = `workbench.syncDrift: workspace "${workspaceId}" has members [${members.join(', ')}] but panels [${panels.join(', ')}]`;
    reportError(fail('workbench.syncDrift', problem, { workspaceId, members, panels }), { source: 'unknown', target: `dock:${workspaceId}` });
    return problem;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const p of [...this.#placements.values()]) {
      p.selection?.dispose();
      const scope = p.scope;
      p.scope = undefined;
      p.presenterState.set(undefined);
      if (scope) await scope.dispose().catch(() => undefined);
      p.context.dispose();
    }
    this.#placements.clear();
    for (const binding of this.#bindings.values()) binding.surface.dispose();
    this.#bindings.clear();
    for (const emitter of this.#activated.values()) emitter.dispose();
    this.#subscriptions.dispose();
  }
}

const NULL_MOUNTER = {
  rendererId: 'none',
  ensureUi: async (): Promise<boolean> => false,
  canMount: (): boolean => false,
  mount: (): IDisposable => toDisposable(() => {}),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** CAB IWorkspace over one workspace record (contracts.md 15.5). */
class WorkspaceHostImpl implements WorkspaceHost {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly placements: Observable<readonly PlacementId[]>;
  readonly active: Observable<PlacementId | undefined>;
  readonly onDidActivate: Event<PlacementId>;
  readonly #service: DefaultWorkbenchService;

  constructor(service: DefaultWorkbenchService, id: string) {
    this.#service = service;
    this.id = id;
    this.kind = (service.state.peek().workspaces[id] as WorkspaceRecord).kind;
    this.placements = computed(() => service.state.get().workspaces[id]?.members ?? [], { name: `workspace.members:${id}`, equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
    this.active = computed(() => service.state.get().workspaces[id]?.active, { name: `workspace.active:${id}` });
    this.onDidActivate = service.onDidActivateIn(id);
  }

  show(viewType: string, options?: Omit<ShowViewOptions, 'workspace' | 'target'>): Promise<PlacementRef> {
    return this.#service.showView(viewType, { ...options, workspace: this.id });
  }
  activate(id: PlacementId): Promise<void> {
    return this.#service.activate(id);
  }
  hide(id: PlacementId): Promise<void> {
    return this.#service.hide(id);
  }
  close(id: PlacementId, options?: { readonly force?: boolean }): Promise<boolean> {
    return this.#service.close(id, options);
  }
}

export type { DockPosition };
export { constant };

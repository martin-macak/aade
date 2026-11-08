import { Emitter, reportError, toDisposable, type Event, type IDisposable } from '@tessera/base';
import {
  ViewRegistry,
  WorkbenchService,
  type DockArrangement,
  type DockChange,
  type DockDesired,
  type DockPosition,
  type DockRestoreReport,
  type DockSlot,
  type DockSurface,
  type PlacementId,
  type ViewMounter,
  type WorkbenchAdapterApi,
} from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { resolveMountTarget } from '@tessera/dom';
import { createDockview, themeAbyss, themeLight, type CreateComponentOptions, type DockviewApi, type GroupPanelPartInitParameters, type IDockviewPanel, type SerializedDockview } from './dockview.ts';
import { checkArrangement, DOCKVIEW_ENGINE, DOCKVIEW_ENGINE_VERSION, PLACEMENT_COMPONENT, TAB_COMPONENT, panelIdsOf, wrapArrangement } from './arrangement.ts';
import { PlacementPanel, PlacementTab, type PanelHooks } from './panels.ts';

export interface DockviewSurfaceOptions {
  /** The window DI scope: where the surface finds the workbench, the view registry and the adapter port. */
  readonly services: ScopeReader;
}

interface PanelBinding {
  readonly panel: PlacementPanel;
  readonly id: PlacementId;
  visible: boolean;
  /** Bumped on every show or hide, so a finished async show can tell that it is stale. */
  generation: number;
  mount: IDisposable | undefined;
  mountedPresenter: unknown;
  showingPlaceholder: boolean;
  status: IDisposable | undefined;
  /** The latest visibility dockview told us this tick; applied in a microtask (dockview flips it while it builds a group). */
  pendingVisible: boolean;
  flushQueued: boolean;
  api: GroupPanelPartInitParameters['api'] | undefined;
  off: IDisposable[];
}

type Slots = ReadonlyMap<PlacementId, DockSlot>;
type UserReason = 'geometry' | 'structure' | 'active';

const slotsEqual = (a: Slots, b: Slots): boolean => {
  if (a.size !== b.size) return false;
  for (const [id, slot] of a) {
    const other = b.get(id);
    if (!other || other.group !== slot.group || other.where !== slot.where || other.popoutId !== slot.popoutId) return false;
  }
  return true;
};

/**
 * The DockSurface on dockview-core (contracts.md 15.9). The core owns membership and identity, dockview owns geometry.
 *
 * - Origin filter: every model-driven call (apply, restore) runs inside `#applying`. Events raised there carry origin
 *   'model' and the workbench drops them. Events outside it are user gestures.
 * - Reason filter: a geometry-only change refreshes the blob. A structure change carries the projection of every member.
 *   A structure change whose projection equals the accepted one (a tab reordered inside its group) is downgraded to geometry.
 * - Revision filter: a higher `desired.revision` adopts the slots the user made. The same revision restores the last
 *   accepted slots, which moves a vetoed tab back (deviations.md, 15.9).
 * - Close routing: the tab close button calls adapter.requestClose, never dockview's own close.
 * - Placeholders: a placement without a presenter shows a note in its panel. State is kept by the workbench.
 *
 * The workbench mounts every surface at once with no host element (headless). That call is "deferred": the surface tracks
 * the model and draws nothing until `attach` gives it a host element.
 */
export class DockviewSurface implements DockSurface<HTMLElement>, PanelHooks {
  readonly engine: { readonly id: string; readonly version: string } = { id: DOCKVIEW_ENGINE, version: DOCKVIEW_ENGINE_VERSION };
  readonly onDidChange: Event<DockChange>;

  readonly #services: ScopeReader;
  readonly #changes = new Emitter<DockChange>({ name: 'dockview.change', deferInTransaction: false });
  readonly #bindings = new Map<PlacementId, PanelBinding>();
  readonly #disposables: IDisposable[] = [];
  #adapter: WorkbenchAdapterApi | undefined;
  #mounter: ViewMounter<HTMLElement> | undefined;
  #workspaceId = '';
  #api: DockviewApi | undefined;
  #host: HTMLElement | undefined;
  #desired: DockDesired | undefined;
  #revision = 0;
  #applying = 0;
  #modelPending = false;
  #userPending = new Set<UserReason>();
  #flushScheduled = false;
  /** The slots (and blob) of the last state the model accepted. A same-revision apply restores them. */
  #acceptedSlots: Slots = new Map();
  #acceptedBlob: SerializedDockview | undefined;
  /** An arrangement given to restore() while detached, applied on attach. */
  #pendingArrangement: { readonly data: SerializedDockview; readonly known: ReadonlySet<PlacementId> } | undefined;
  #lastBlob: SerializedDockview | undefined;
  #disposed = false;

  constructor(options: DockviewSurfaceOptions) {
    this.#services = options.services;
    this.onDidChange = this.#changes.event;
  }

  // ----- mounting ------------------------------------------------------------------------------

  mount(host: HTMLElement | undefined, deps: { readonly mounter: ViewMounter<HTMLElement>; readonly adapter: WorkbenchAdapterApi; readonly workspaceId: string }): void {
    this.#adapter = deps.adapter;
    this.#workspaceId = deps.workspaceId;
    this.#mounter = deps.mounter;
    if (host) this.attach(host, deps.mounter);
  }

  /** Binds the surface to a host element (the renderer calls this through DockSurfaceHost). Dispose detaches. */
  attach(host: HTMLElement, mounter: ViewMounter<HTMLElement>): IDisposable {
    if (this.#disposed) throw new Error('The dock surface is disposed.');
    if (this.#api) this.detach();
    this.#mounter = mounter;
    this.#host = host;
    const dark = host.ownerDocument.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
    host.classList.add('tessera-dock-host');
    const api = createDockview(host, {
      theme: dark ? themeAbyss : themeLight,
      defaultTabComponent: TAB_COMPONENT,
      closeEmptyGroups: true,
      // dockview's own tab menu has a close item that bypasses the workbench close pipeline; the workbench offers the placement/tab menu instead
      getTabContextMenuItems: () => [],
      createComponent: () => new PlacementPanel(this),
      createTabComponent: (options: CreateComponentOptions) => (options.name === TAB_COMPONENT ? new PlacementTab(this) : undefined),
    });
    this.#api = api;
    this.#disposables.push(api.onDidLayoutChange((e) => this.#onLayout(e.reasons)));
    this.#disposables.push(api.onDidActivePanelChange(() => this.#note('active')));
    this.#disposables.push(api.onDidAddPanel(() => this.#note('structure')));
    this.#disposables.push(api.onDidRemovePanel(() => this.#note('structure')));
    this.#disposables.push(api.onDidMovePanel(() => this.#note('structure')));
    this.#disposables.push(api.onWillDrop((event) => this.#onWillDrop(event.getData()?.panelId ?? undefined, () => event.preventDefault())));
    // re-project what the model wants and what a restore asked for
    this.#withModel(() => {
      const pending = this.#pendingArrangement;
      this.#pendingArrangement = undefined;
      const blob = pending?.data ?? this.#lastBlob;
      if (blob) this.#loadBlob(api, blob, pending?.known);
      if (this.#desired) this.#project(api, this.#desired);
      this.#acceptedBlob = api.toJSON();
      this.#acceptedSlots = this.#slots();
    });
    return toDisposable(() => {
      if (this.#api === api) this.detach();
    });
  }

  /** Drops the dockview component and mounted views. The model state stays; attach() projects it again. */
  detach(): void {
    const api = this.#api;
    if (!api) return;
    this.#lastBlob = api.toJSON();
    for (const d of this.#disposables.splice(0)) d.dispose();
    for (const b of this.#bindings.values()) this.#hide(b);
    for (const b of [...this.#bindings.values()]) {
      if (b.visible) this.#adapter?.reportVisible(b.id, false);
    }
    this.#api = undefined;
    this.#withModel(() => api.dispose());
    this.#host?.classList.remove('tessera-dock-host');
    this.#host?.replaceChildren();
    this.#host = undefined;
    this.#bindings.clear();
    this.#userPending.clear();
  }

  // ----- DockSurface ---------------------------------------------------------------------------

  async apply(desired: DockDesired): Promise<void> {
    if (this.#disposed) return;
    const higher = desired.revision > this.#revision;
    const previous = this.#desired;
    this.#desired = desired;
    this.#revision = Math.max(this.#revision, desired.revision);
    const api = this.#api;
    if (!api) return; // deferred: the model state is kept for attach()
    this.#withModel(() => {
      if (!higher && previous && !slotsEqual(this.#slots(), this.#acceptedSlots) && this.#acceptedBlob) {
        // same revision and the surface moved a tab that the model did not accept (a veto, or an invalid move): move it back
        this.#loadBlob(api, this.#acceptedBlob, undefined, true);
      }
      this.#project(api, desired);
      if (higher || !previous) {
        this.#acceptedBlob = api.toJSON();
        this.#acceptedSlots = this.#slots();
      }
    });
    await Promise.resolve();
  }

  snapshot(): DockArrangement {
    const api = this.#api;
    const data = api?.toJSON() ?? this.#pendingArrangement?.data ?? this.#lastBlob ?? emptyBlob();
    return wrapArrangement(data);
  }

  async restore(arrangement: DockArrangement, known: ReadonlySet<PlacementId>): Promise<DockRestoreReport> {
    const checked = checkArrangement(arrangement);

    const api = this.#api;
    if (!checked.ok) {
      // not an error: the report says rebuilt, and the workbench decides what to tell the user
      if (api) this.#withModel(() => this.#rebuild(api, known));
      return { restored: [...known], dropped: [], rebuilt: true };
    }
    const inBlob = panelIdsOf(checked.data);
    const restored = inBlob.filter((id) => known.has(id));
    const dropped = inBlob.filter((id) => !known.has(id));
    if (!api) {
      this.#pendingArrangement = { data: checked.data, known };
      return { restored, dropped, rebuilt: false };
    }
    let rebuilt = false;
    this.#withModel(() => {
      try {
        this.#loadBlob(api, checked.data, known);
      } catch (error) {
        reportError(error, { source: 'view', target: `dock:${this.#workspaceId}` });
        this.#rebuild(api, known);
        rebuilt = true;
      }
      this.#acceptedBlob = api.toJSON();
      this.#acceptedSlots = this.#slots();
    });
    return { restored: rebuilt ? [...known] : restored, dropped: rebuilt ? [] : dropped, rebuilt };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.detach();
    this.#disposed = true;
    this.#pendingArrangement = undefined;
    this.#changes.dispose();
  }

  /** The dockview API while attached. For tests and diagnostics only: the model never reads it. */
  get api(): DockviewApi | undefined {
    return this.#api;
  }

  /** The ids of the panels the surface shows now (for tests and the dev invariant of contracts.md 15.9 rule 8). */
  panelIds(): readonly PlacementId[] {
    return (this.#api?.panels ?? []).map((p) => p.id as PlacementId);
  }

  // ----- PanelHooks ----------------------------------------------------------------------------

  panelReady(panel: PlacementPanel, api: GroupPanelPartInitParameters['api']): void {
    const binding: PanelBinding = { panel, id: panel.id, visible: false, generation: 0, mount: undefined, mountedPresenter: undefined, showingPlaceholder: false, status: undefined, pendingVisible: false, flushQueued: false, api, off: [] };
    this.#bindings.set(panel.id, binding);
    binding.off.push(api.onDidVisibilityChange((e) => this.#queueVisible(binding, e.isVisible)));
    const placement = this.#services.get(WorkbenchService).placement(panel.id);
    // a placement that turns into a placeholder (plugin deactivated) or back (provider registered) redraws its panel
    binding.status = placement?.status.subscribe(() => this.#refresh(binding));
    // the tab title follows the presenter's title observable ("Tasks (2)"), which the model reads only when it applies
    if (placement) {
      const title = placement.title;
      binding.off.push(title.subscribe((t) => this.#withModel(() => api.setTitle(t))));
      if (api.title !== title.peek()) this.#withModel(() => api.setTitle(title.peek()));
    }
    this.#queueVisible(binding, api.isVisible);
  }

  panelGone(panel: PlacementPanel): void {
    const binding = this.#bindings.get(panel.id);
    if (!binding || binding.panel !== panel) return;
    this.#hide(binding);
    binding.status?.dispose();
    for (const d of binding.off) d.dispose();
    if (binding.visible) this.#adapter?.reportVisible(binding.id, false);
    this.#bindings.delete(panel.id);
  }

  requestClose(id: PlacementId): void {
    this.#adapter?.requestClose(id);
  }

  // ----- views in panels -----------------------------------------------------------------------

  /**
   * dockview reports a panel as visible while it builds the group (a hidden tab flips true, then false). Reporting that
   * would create a presenter for a tab nobody sees (contracts.md 15.7 rule 1). The surface applies the last value of the tick.
   */
  #queueVisible(b: PanelBinding, visible: boolean): void {
    b.pendingVisible = visible;
    if (b.flushQueued) return;
    b.flushQueued = true;
    queueMicrotask(() => {
      b.flushQueued = false;
      if (this.#bindings.get(b.id) === b && !this.#disposed) this.#setVisible(b, b.pendingVisible);
    });
  }

  #setVisible(b: PanelBinding, visible: boolean): void {
    if (b.visible === visible) return;
    b.visible = visible;
    this.#adapter?.reportVisible(b.id, visible);
    if (visible) void this.#show(b);
    else this.#hide(b);
  }

  #refresh(b: PanelBinding): void {
    if (!b.visible) return;
    const placement = this.#services.get(WorkbenchService).placement(b.id);
    if (!placement) return;
    const placeholder = placement.status.peek() === 'placeholder';
    if (placeholder !== b.showingPlaceholder || (!placeholder && placement.presenter !== undefined && placement.presenter !== b.mountedPresenter)) {
      this.#hide(b);
      void this.#show(b);
    }
  }

  async #show(b: PanelBinding): Promise<void> {
    const generation = ++b.generation;
    const stale = (): boolean => !b.visible || b.generation !== generation || this.#disposed || this.#bindings.get(b.id) !== b;
    try {
      const placement = this.#services.get(WorkbenchService).placement(b.id);
      // a placeholder stays one: asking for its presenter would activate the owning plugin again (a deactivation must hold)
      const target = placement?.status.peek() === 'placeholder' ? undefined : await resolveMountTarget(this.#services, b.id);
      if (stale()) return;
      if (!target) {
        b.showingPlaceholder = true;
        b.mountedPresenter = undefined;
        this.#placeholder(b, placement?.viewType ?? b.id, placement?.problem);
        return;
      }
      const mounter = this.#mounter;
      const ok = mounter ? await mounter.ensureUi(target.placement.viewType) : false;
      if (stale()) return;
      if (!mounter || !ok || !mounter.canMount(target.placement.viewType)) {
        b.showingPlaceholder = true;
        this.#placeholder(b, target.placement.viewType, 'The owning plugin has no UI for this renderer.');
        return;
      }
      b.panel.noteHost.replaceChildren();
      b.showingPlaceholder = false;
      b.mountedPresenter = target.presenter;
      b.mount = mounter.mount(b.panel.viewHost, target);
    } catch (error) {
      reportError(error, { source: 'view', target: `dock:${this.#workspaceId}:${b.id}` });
    }
  }

  #hide(b: PanelBinding): void {
    b.generation++;
    b.mount?.dispose();
    b.mount = undefined;
    b.mountedPresenter = undefined;
    b.showingPlaceholder = false;
    b.panel.noteHost.replaceChildren();
  }

  #placeholder(b: PanelBinding, viewType: string, problem: string | undefined): void {
    const note = b.panel.noteHost.ownerDocument.createElement('div');
    note.className = 'tessera-dock-placeholder';
    note.setAttribute('role', 'note');
    note.dataset['placeholder'] = viewType;
    const title = b.panel.noteHost.ownerDocument.createElement('strong');
    title.textContent = viewType;
    note.append(title, ` is not available. ${problem ?? ''}`.trimEnd());
    b.panel.noteHost.replaceChildren(note);
  }

  // ----- model to surface ----------------------------------------------------------------------

  #withModel<T>(fn: () => T): T {
    // dockview coalesces layout events in a microtask that is queued during fn(). The guard therefore ends in a microtask
    // that is queued after fn(): FIFO order makes the coalesced echo run while the guard is still up.
    this.#applying++;
    try {
      return fn();
    } finally {
      queueMicrotask(() => void this.#applying--);
    }
  }

  #project(api: DockviewApi, desired: DockDesired): void {
    const wanted = new Set(desired.members.map((m) => m.id as string));
    for (const panel of [...api.panels]) if (!wanted.has(panel.id)) api.removePanel(panel);
    for (const member of desired.members) {
      const existing = api.getPanel(member.id);
      if (existing) {
        if (existing.title !== member.title) existing.api.setTitle(member.title);
        continue;
      }
      api.addPanel({ id: member.id, component: PLACEMENT_COMPONENT, tabComponent: TAB_COMPONENT, title: member.title, params: { placementId: member.id }, inactive: member.id !== desired.active, ...this.#placementOf(api, member.where, member.position) });
    }
    if (desired.active !== undefined) {
      const panel = api.getPanel(desired.active);
      if (panel && api.activePanel?.id !== panel.id) panel.api.setActive();
    }
  }

  #placementOf(api: DockviewApi, where: 'grid' | 'floating' | 'popout', position: DockPosition | undefined): Record<string, unknown> {
    if (where === 'floating') return { floating: true };
    if (!position) return {};
    const direction = position.direction;
    if (position.reference && api.getPanel(position.reference)) return { position: { referencePanel: position.reference, direction } };
    return direction === 'within' ? {} : { position: { direction } };
  }

  #loadBlob(api: DockviewApi, data: SerializedDockview, known: ReadonlySet<PlacementId> | undefined, reuse = false): void {
    api.fromJSON(data, { reuseExistingPanels: reuse });
    if (known) for (const panel of [...api.panels]) if (!known.has(panel.id as PlacementId)) api.removePanel(panel);
  }

  #rebuild(api: DockviewApi, known: ReadonlySet<PlacementId>): void {
    api.clear();
    for (const id of known) {
      const title = this.#desired?.members.find((m) => m.id === id)?.title ?? id;
      api.addPanel({ id, component: PLACEMENT_COMPONENT, tabComponent: TAB_COMPONENT, title, params: { placementId: id }, inactive: true });
    }
  }

  #onWillDrop(panelId: string | undefined, prevent: () => void): void {
    if (!panelId) return;
    const placement = this.#services.get(WorkbenchService).placement(panelId as PlacementId);
    const descriptor = placement ? this.#services.get(ViewRegistry, { optional: true })?.descriptor(placement.viewType) : undefined;
    if (descriptor?.canMove === false) prevent(); // block early; the workbench would revert the move anyway
  }

  // ----- surface to model ----------------------------------------------------------------------

  #slots(): Slots {
    const out = new Map<PlacementId, DockSlot>();
    const api = this.#api;
    if (!api) return out;
    for (const panel of api.panels) {
      const type = panel.api.location.type;
      const where = type === 'floating' ? 'floating' : type === 'popout' ? 'popout' : 'grid';
      out.set(panel.id as PlacementId, { group: panel.group.id, where, popoutId: where === 'popout' ? panel.group.id : undefined });
    }
    return out;
  }

  #onLayout(reasons: ReadonlySet<string>): void {
    if (reasons.has('geometry')) this.#note('geometry');
    if (reasons.has('structure')) this.#note('structure');
    if (reasons.has('activePanel')) this.#note('active');
  }

  #note(reason: UserReason): void {
    if (this.#applying > 0) this.#modelPending = true;
    else this.#userPending.add(reason);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    this.#flushScheduled = false;
    if (this.#disposed || !this.#api) {
      this.#modelPending = false;
      this.#userPending.clear();
      return;
    }
    if (this.#modelPending) {
      this.#modelPending = false;
      // an echo of apply() or restore(): reported with origin 'model' and dropped by the workbench
      this.#changes.fire({ origin: 'model', revision: this.#revision, reasons: new Set<'geometry' | 'structure' | 'active'>(['geometry']), projection: undefined, active: this.#activeId() });
    }
    const pending = new Set(this.#userPending);
    this.#userPending.clear();
    if (pending.size === 0) return;
    const reasons = new Set<UserReason>();
    let projection: Slots | undefined;
    if (pending.has('structure')) {
      const slots = this.#slots();
      if (slotsEqual(slots, this.#acceptedSlots)) pending.add('geometry'); // a reorder inside a group: geometry only
      else {
        reasons.add('structure');
        projection = slots;
      }
    }
    if (pending.has('geometry')) {
      reasons.add('geometry');
      if (!projection) this.#acceptedBlob = this.#api.toJSON(); // the accepted layout follows tab order and sizes
    }
    if (pending.has('active') && this.#activeId() !== this.#desired?.active) reasons.add('active');
    if (reasons.size === 0) return;
    this.#changes.fire({ origin: 'user', revision: this.#revision, reasons, projection, active: this.#activeId() });
  }

  #activeId(): PlacementId | undefined {
    return this.#api?.activePanel?.id as PlacementId | undefined;
  }
}

function emptyBlob(): SerializedDockview {
  return { grid: { root: { type: 'branch', data: [], size: 0 }, height: 0, width: 0, orientation: 'HORIZONTAL' }, panels: {} } as unknown as SerializedDockview;
}

export type { IDockviewPanel };

import { Emitter, type Event } from '@tessera/base';
import type {
  DockArrangement,
  DockChange,
  DockDesired,
  DockPosition,
  DockRestoreReport,
  DockSlot,
  DockSurface,
  DockSurfaceFactory,
  PlacementId,
  ViewMounter,
  WorkbenchAdapterApi,
} from '@tessera/contracts';

/** The most entries a test double keeps in its history log. A long run (the B15 heap bench) must measure the framework, not the double. */
export const MAX_HISTORY: number = 1000;

interface Group {
  readonly id: string;
  panels: PlacementId[];
  active: PlacementId | undefined;
  where: 'grid' | 'floating' | 'popout';
}

/**
 * A DockSurface without any DOM, for the core's tests (poc-plan claim C21). It behaves like a small docking library:
 * groups with tabs, the active tab of a group is the visible one, new panels join the active group or open a new group by
 * position. It adds test helpers that simulate what a user does in a real surface: `userMoveToNewGroup`, `userMoveToGroup`,
 * `userActivate`, `userClose`, `userGeometry`.
 *
 * Revision rule of apply(): a call with a higher revision than the last one *adopts* the current panel slots (the model accepted
 * them). A call with the same revision *restores* the slots the model last accepted (the model refused a gesture).
 */
export interface FakeDockSurface extends DockSurface<unknown> {
  panelIds(): readonly PlacementId[];
  groups(): ReadonlyArray<{ readonly id: string; readonly panels: readonly PlacementId[]; readonly active: PlacementId | undefined; readonly where: string }>;
  readonly appliedRevision: number;
  readonly applyCount: number;
  /** The panels the surface reported as visible. */
  visiblePanels(): readonly PlacementId[];
  /** A drag of a tab into a group that exists. Reports a `structure` change. */
  userMoveToGroup(id: PlacementId, groupId: string): void;
  /** A drag of a tab to an edge: opens a new group. Reports a `structure` change. */
  userMoveToNewGroup(id: PlacementId, direction?: 'left' | 'right' | 'above' | 'below'): void;
  /** A click on a tab. Reports an `active` change. */
  userActivate(id: PlacementId): void;
  /** The tab close button: routed to WorkbenchAdapterApi.requestClose, never closes by itself (15.6). */
  userClose(id: PlacementId): void;
  /** Resizing a splitter. Reports a `geometry` change. */
  userGeometry(): void;
  /** Reports a change built against a given (possibly old) revision. */
  reportAtRevision(revision: number, reasons: ReadonlyArray<'geometry' | 'structure' | 'active'>): void;
  /** Every DockChange the surface emitted. */
  readonly emitted: readonly DockChange[];
}

class FakeSurface implements FakeDockSurface {
  readonly engine: { readonly id: string; readonly version: string } = { id: 'fake', version: '1.0' };
  readonly onDidChange: Event<DockChange>;
  readonly emitted: DockChange[] = [];
  appliedRevision = 0;
  applyCount = 0;

  readonly #workspaceId: string;
  readonly #changes = new Emitter<DockChange>({ name: 'fakeDock.change', deferInTransaction: false });
  #groups: Group[] = [];
  #accepted = new Map<PlacementId, { group: string; index: number }>();
  #reported = new Map<PlacementId, boolean>();
  #adapter: WorkbenchAdapterApi | undefined;
  #nextGroup = 1;
  #disposed = false;

  constructor(workspaceId: string) {
    this.#workspaceId = workspaceId;
    this.onDidChange = this.#changes.event;
  }

  mount(_host: unknown, deps: { readonly mounter: ViewMounter<unknown>; readonly adapter: WorkbenchAdapterApi; readonly workspaceId: string }): void {
    this.#adapter = deps.adapter;
  }

  // ----- model to surface ----------------------------------------------------------------------

  async apply(desired: DockDesired): Promise<void> {
    if (this.#disposed) return;
    this.applyCount++;
    const adopt = desired.revision > this.appliedRevision;
    if (!adopt) this.#restoreAccepted();
    const wanted = new Set(desired.members.map((m) => m.id));
    // closed panels leave
    for (const g of this.#groups) {
      g.panels = g.panels.filter((p) => wanted.has(p));
      if (g.active !== undefined && !wanted.has(g.active)) g.active = g.panels[g.panels.length - 1];
    }
    this.#groups = this.#groups.filter((g) => g.panels.length > 0);
    for (const member of desired.members) {
      const where = this.#groupOf(member.id);
      if (where === undefined) {
        const group = this.#targetGroup(member.position, member.where);
        group.panels.push(member.id);
        group.active = member.id; // a new tab becomes active in its group, like a real docking library
      } else if (member.position) {
        this.#moveTo(member.id, this.#targetGroup(member.position, member.where, member.id));
      }
    }
    if (desired.active !== undefined) {
      const g = this.#groupOf(desired.active);
      if (g) g.active = desired.active;
    }
    if (adopt) {
      this.appliedRevision = desired.revision;
      this.#accept();
    }
    this.#reportVisibility();
    // an echo of apply(), tagged origin 'model': the workbench must drop it (15.9 rule 1)
    this.#emit({ origin: 'model', revision: this.appliedRevision, reasons: new Set(['structure']), projection: this.#projection(), active: this.#globalActive() });
  }

  // ----- surface to model ----------------------------------------------------------------------

  snapshot(): DockArrangement {
    return {
      engine: this.engine.id,
      engineVersion: this.engine.version,
      data: { groups: this.#groups.map((g) => ({ id: g.id, panels: [...g.panels], active: g.active, where: g.where })), next: this.#nextGroup },
    };
  }

  async restore(arrangement: DockArrangement, known: ReadonlySet<PlacementId>): Promise<DockRestoreReport> {
    const data = arrangement.data as { groups?: Array<{ id?: unknown; panels?: unknown; active?: unknown; where?: unknown }>; next?: unknown } | undefined;
    const valid = arrangement.engine === this.engine.id && Array.isArray(data?.groups) && data.groups.every((g) => typeof g.id === 'string' && Array.isArray(g.panels));
    this.#groups = [];
    const restored: PlacementId[] = [];
    const dropped: PlacementId[] = [];
    if (!valid) {
      const group: Group = { id: this.#newGroupId(), panels: [...known], active: [...known][0], where: 'grid' };
      if (group.panels.length > 0) this.#groups.push(group);
      this.#accept();
      this.#reportVisibility();
      return { restored: [...known], dropped: [], rebuilt: true };
    }
    for (const saved of data?.groups ?? []) {
      const panels = (saved.panels as PlacementId[]).filter((id) => {
        if (known.has(id)) return true;
        dropped.push(id);
        return false;
      });
      if (panels.length === 0) continue;
      const active = panels.includes(saved.active as PlacementId) ? (saved.active as PlacementId) : panels[panels.length - 1];
      this.#groups.push({ id: saved.id as string, panels, active, where: saved.where === 'floating' || saved.where === 'popout' ? saved.where : 'grid' });
      restored.push(...panels);
    }
    if (typeof data?.next === 'number') this.#nextGroup = Math.max(this.#nextGroup, data.next);
    // known placements that the blob does not mention join the first group: membership is the core's
    const missing = [...known].filter((id) => !restored.includes(id));
    if (missing.length > 0) {
      const group = this.#groups[0] ?? this.#pushGroup('grid');
      group.panels.push(...missing);
      group.active ??= missing[0];
      restored.push(...missing);
    }
    this.#accept();
    this.#reportVisibility();
    return { restored, dropped, rebuilt: false };
  }

  // ----- helpers for tests ---------------------------------------------------------------------

  panelIds(): readonly PlacementId[] {
    return this.#groups.flatMap((g) => g.panels);
  }
  groups(): ReadonlyArray<{ readonly id: string; readonly panels: readonly PlacementId[]; readonly active: PlacementId | undefined; readonly where: string }> {
    return this.#groups.map((g) => ({ id: g.id, panels: [...g.panels], active: g.active, where: g.where }));
  }
  visiblePanels(): readonly PlacementId[] {
    return this.#groups.flatMap((g) => (g.active !== undefined ? [g.active] : []));
  }

  userMoveToGroup(id: PlacementId, groupId: string): void {
    const target = this.#groups.find((g) => g.id === groupId);
    if (!target) throw new Error(`fakeDockSurface: no group "${groupId}"`);
    this.#moveTo(id, target);
    target.active = id;
    this.#reportVisibility();
    this.#emit({ origin: 'user', revision: this.appliedRevision, reasons: new Set(['structure']), projection: this.#projection(), active: id });
  }

  userMoveToNewGroup(id: PlacementId, direction: 'left' | 'right' | 'above' | 'below' = 'right'): void {
    const reference = this.#groupOf(id);
    this.#detach(id);
    const group = this.#pushGroup('grid', direction === 'left' || direction === 'above' ? reference : undefined);
    group.panels.push(id);
    group.active = id;
    this.#groups = this.#groups.filter((g) => g.panels.length > 0);
    this.#reportVisibility();
    this.#emit({ origin: 'user', revision: this.appliedRevision, reasons: new Set(['structure']), projection: this.#projection(), active: id });
  }

  userActivate(id: PlacementId): void {
    const g = this.#groupOf(id);
    if (!g) return;
    g.active = id;
    this.#reportVisibility();
    this.#emit({ origin: 'user', revision: this.appliedRevision, reasons: new Set(['active']), projection: undefined, active: id });
  }

  userClose(id: PlacementId): void {
    this.#adapter?.requestClose(id);
  }

  userGeometry(): void {
    this.#emit({ origin: 'user', revision: this.appliedRevision, reasons: new Set(['geometry']), projection: undefined, active: this.#globalActive() });
  }

  reportAtRevision(revision: number, reasons: ReadonlyArray<'geometry' | 'structure' | 'active'>): void {
    this.#emit({ origin: 'user', revision, reasons: new Set(reasons), projection: reasons.includes('structure') ? this.#projection() : undefined, active: this.#globalActive() });
  }

  // ----- internals -----------------------------------------------------------------------------

  #newGroupId(): string {
    return `g${this.#nextGroup++}`;
  }

  #pushGroup(where: Group['where'], before?: Group): Group {
    const group: Group = { id: this.#newGroupId(), panels: [], active: undefined, where };
    const index = before ? this.#groups.indexOf(before) : this.#groups.length;
    this.#groups.splice(index < 0 ? this.#groups.length : index, 0, group);
    return group;
  }

  #groupOf(id: PlacementId): Group | undefined {
    return this.#groups.find((g) => g.panels.includes(id));
  }

  #globalActive(): PlacementId | undefined {
    return this.#groups.find((g) => g.active !== undefined)?.active;
  }

  #detach(id: PlacementId): void {
    const g = this.#groupOf(id);
    if (!g) return;
    g.panels = g.panels.filter((p) => p !== id);
    if (g.active === id) g.active = g.panels[g.panels.length - 1];
  }

  #moveTo(id: PlacementId, target: Group): void {
    if (target.panels.includes(id)) return;
    this.#detach(id);
    target.panels.push(id);
    this.#groups = this.#groups.filter((g) => g.panels.length > 0 || g === target);
  }

  #targetGroup(position: DockPosition | undefined, where: 'grid' | 'floating' | 'popout', moving?: PlacementId): Group {
    if (where !== 'grid') return this.#pushGroup(where);
    if (!position || position.direction === 'within') {
      const reference = position?.reference ? this.#groupOf(position.reference) : undefined;
      const g = reference ?? this.#groups.find((x) => x.active !== undefined && x.panels.includes(x.active) && x.where === 'grid' && !(moving && x.panels.length === 1 && x.panels[0] === moving)) ?? this.#groups[0];
      return g ?? this.#pushGroup('grid');
    }
    const reference = position.reference ? this.#groupOf(position.reference) : this.#groups[0];
    return this.#pushGroup('grid', position.direction === 'left' || position.direction === 'above' ? reference : undefined);
  }

  #projection(): ReadonlyMap<PlacementId, DockSlot> {
    const map = new Map<PlacementId, DockSlot>();
    for (const g of this.#groups) for (const id of g.panels) map.set(id, { group: g.id, where: g.where, popoutId: undefined });
    return map;
  }

  #accept(): void {
    this.#accepted = new Map();
    for (const g of this.#groups) g.panels.forEach((id, index) => this.#accepted.set(id, { group: g.id, index }));
  }

  /** The model refused what the user did: every panel goes back to the group the model last accepted. */
  #restoreAccepted(): void {
    for (const [id, slot] of this.#accepted) {
      const current = this.#groupOf(id);
      if (current?.id === slot.group) continue;
      let target = this.#groups.find((g) => g.id === slot.group);
      if (!target) {
        target = { id: slot.group, panels: [], active: undefined, where: 'grid' };
        this.#groups.push(target);
      }
      if (current) this.#detach(id);
      target.panels.splice(Math.min(slot.index, target.panels.length), 0, id);
      target.active ??= id;
    }
    this.#groups = this.#groups.filter((g) => g.panels.length > 0);
  }

  #reportVisibility(): void {
    const visible = new Set(this.visiblePanels());
    for (const id of this.panelIds()) {
      const now = visible.has(id);
      if (this.#reported.get(id) === now) continue;
      this.#reported.set(id, now);
      this.#adapter?.reportVisible(id, now);
    }
    for (const id of [...this.#reported.keys()]) if (!this.panelIds().includes(id)) this.#reported.delete(id);
  }

  #emit(change: DockChange): void {
    if (this.#disposed) return;
    this.emitted.push(change);
    if (this.emitted.length > MAX_HISTORY) this.emitted.splice(0, this.emitted.length - MAX_HISTORY); // bounded: a long bench must not measure the double's log
    this.#changes.fire(change);
  }

  dispose(): void {
    this.#disposed = true;
    this.#changes.dispose();
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }
}

export function fakeDockSurface(workspaceId = 'workbench.editorArea'): FakeDockSurface {
  return new FakeSurface(workspaceId);
}

export interface FakeDockSurfaceFactory extends DockSurfaceFactory {
  readonly surfaces: ReadonlyMap<string, FakeDockSurface>;
}

/** A DockSurfaceFactory that creates fake surfaces and remembers them by workspace id. */
export function fakeDockSurfaceFactory(): FakeDockSurfaceFactory {
  const surfaces = new Map<string, FakeDockSurface>();
  return {
    surfaces,
    create(workspaceId) {
      const surface = fakeDockSurface(workspaceId);
      surfaces.set(workspaceId, surface);
      return surface;
    },
  };
}

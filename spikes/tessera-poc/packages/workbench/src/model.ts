import {
  EDITOR_AREA_WORKSPACE,
  PartId,
  WorkspaceKind,
  emptyOverrides,
  type PartRecord,
  type PlacementId,
  type PlacementRecord,
  type ViewInstanceRecord,
  type WindowId,
  type WindowRecord,
  type WorkbenchState,
  type WorkspaceRecord,
} from '@tessera/contracts';

// Pure functions over the immutable WorkbenchState (contracts.md 15.1). No DOM, no services, no time.
// `revision` counts changes of membership, order, active member and dock slot. It does not count status, visibility, focus
// or dock geometry: the dock surface reports against the revision it applied, and those changes must not make its reports stale.

const ALL_PARTS: readonly PartId[] = [
  PartId.TitleBar,
  PartId.ActivityBar,
  PartId.PrimarySideBar,
  PartId.SecondarySideBar,
  PartId.EditorArea,
  PartId.Panel,
  PartId.StatusBar,
];

export function initialState(windowId: WindowId): WorkbenchState {
  const parts: Partial<Record<PartId, PartRecord>> = {};
  for (const id of ALL_PARTS) {
    parts[id] = { id, visible: true, size: undefined, workspaces: id === PartId.EditorArea ? [EDITOR_AREA_WORKSPACE] : [], active: id === PartId.EditorArea ? EDITOR_AREA_WORKSPACE : undefined };
  }
  const window: WindowRecord = { id: windowId, kind: 'main', bounds: undefined, parts };
  const editor: WorkspaceRecord = {
    id: EDITOR_AREA_WORKSPACE,
    kind: WorkspaceKind.Dock,
    windowId,
    partId: PartId.EditorArea,
    title: 'Editor',
    icon: undefined,
    owner: 'core',
    members: [],
    active: undefined,
    collapsed: [],
    arrangement: undefined,
  };
  return { revision: 0, windows: { [windowId]: window }, workspaces: { [EDITOR_AREA_WORKSPACE]: editor }, placements: {}, instances: {}, focus: undefined, overrides: emptyOverrides() };
}

export function bump(s: WorkbenchState): WorkbenchState {
  return { ...s, revision: s.revision + 1 };
}

export function withWorkspace(s: WorkbenchState, ws: WorkspaceRecord, bumpRevision = true): WorkbenchState {
  const next = { ...s, workspaces: { ...s.workspaces, [ws.id]: ws } };
  return bumpRevision ? bump(next) : next;
}

export function removeWorkspace(s: WorkbenchState, id: string): WorkbenchState {
  const { [id]: removed, ...rest } = s.workspaces;
  void removed;
  const windows: Record<string, WindowRecord> = {};
  for (const [wid, w] of Object.entries(s.windows)) {
    const parts: Partial<Record<PartId, PartRecord>> = {};
    for (const [pid, part] of Object.entries(w.parts) as Array<[PartId, PartRecord]>) {
      parts[pid] = part.workspaces.includes(id)
        ? { ...part, workspaces: part.workspaces.filter((x) => x !== id), active: part.active === id ? part.workspaces.find((x) => x !== id) : part.active }
        : part;
    }
    windows[wid] = { ...w, parts };
  }
  return bump({ ...s, workspaces: rest, windows });
}

export function withPart(s: WorkbenchState, windowId: string, part: PartRecord, bumpRevision = false): WorkbenchState {
  const w = s.windows[windowId];
  if (!w) return s;
  const next = { ...s, windows: { ...s.windows, [windowId]: { ...w, parts: { ...w.parts, [part.id]: part } } } };
  return bumpRevision ? bump(next) : next;
}

/** Adds the placement record, the instance link and the workspace membership. `index` places it in the member order. */
export function addPlacement(s: WorkbenchState, record: PlacementRecord, instance: Omit<ViewInstanceRecord, 'placements'>, index?: number): WorkbenchState {
  const ws = s.workspaces[record.workspaceId];
  if (!ws) throw new Error(`addPlacement: unknown workspace "${record.workspaceId}"`);
  const members = [...ws.members.filter((m) => m !== record.id)];
  members.splice(index === undefined ? members.length : Math.max(0, Math.min(index, members.length)), 0, record.id);
  const previous = s.instances[instance.id];
  const placements = [...(previous?.placements ?? []).filter((p) => p !== record.id), record.id];
  return bump({
    ...s,
    placements: { ...s.placements, [record.id]: record },
    instances: { ...s.instances, [instance.id]: { ...instance, placements } },
    workspaces: { ...s.workspaces, [ws.id]: { ...ws, members } },
  });
}

/** Removes the record, the membership and the instance link. The active member and the focus move to a neighbour. */
export function removePlacement(s: WorkbenchState, id: PlacementId): WorkbenchState {
  const record = s.placements[id];
  if (!record) return s;
  const { [id]: gone, ...placements } = s.placements;
  void gone;
  const ws = s.workspaces[record.workspaceId];
  let workspaces = s.workspaces;
  if (ws) {
    const index = ws.members.indexOf(id);
    const members = ws.members.filter((m) => m !== id);
    const active = ws.active === id ? (members[Math.min(index, members.length - 1)] ?? undefined) : ws.active;
    workspaces = { ...s.workspaces, [ws.id]: { ...ws, members, active, collapsed: ws.collapsed.filter((c) => c !== id) } };
  }
  const instance = s.instances[record.instanceId];
  let instances = s.instances;
  if (instance) {
    const left = instance.placements.filter((p) => p !== id);
    if (left.length === 0) {
      const { [instance.id]: dropped, ...rest } = s.instances;
      void dropped;
      instances = rest;
    } else instances = { ...s.instances, [instance.id]: { ...instance, placements: left } };
  }
  return bump({ ...s, placements, workspaces, instances, focus: s.focus === id ? undefined : s.focus });
}

export function setActive(s: WorkbenchState, workspaceId: string, id: PlacementId | undefined): WorkbenchState {
  const ws = s.workspaces[workspaceId];
  if (!ws || ws.active === id) return s;
  return bump({ ...s, workspaces: { ...s.workspaces, [ws.id]: { ...ws, active: id } } });
}

export function setStatus(s: WorkbenchState, id: PlacementId, status: PlacementRecord['status']): WorkbenchState {
  const record = s.placements[id];
  if (!record || record.status === status) return s;
  return { ...s, placements: { ...s.placements, [id]: { ...record, status } } };
}

export function setFocus(s: WorkbenchState, id: PlacementId | undefined): WorkbenchState {
  return s.focus === id ? s : { ...s, focus: id };
}

export function setDockSlot(s: WorkbenchState, id: PlacementId, dock: PlacementRecord['dock'], bumpRevision: boolean): WorkbenchState {
  const record = s.placements[id];
  if (!record) return s;
  const next = { ...s, placements: { ...s.placements, [id]: { ...record, dock } } };
  return bumpRevision ? bump(next) : next;
}

export function setArrangement(s: WorkbenchState, workspaceId: string, arrangement: WorkspaceRecord['arrangement']): WorkbenchState {
  const ws = s.workspaces[workspaceId];
  if (!ws) return s;
  return { ...s, workspaces: { ...s.workspaces, [ws.id]: { ...ws, arrangement } } };
}

/** Moves a placement into another workspace (record only). */
export function movePlacementRecord(s: WorkbenchState, id: PlacementId, workspaceId: string, index?: number): WorkbenchState {
  const record = s.placements[id];
  const target = s.workspaces[workspaceId];
  if (!record || !target) return s;
  const without = removePlacement(s, id);
  const instance = s.instances[record.instanceId];
  if (!instance) return s;
  const { placements: ignored, ...rest } = instance;
  void ignored;
  return addPlacement(without, { ...record, workspaceId, dock: undefined }, rest, index);
}

export function setCollapsed(s: WorkbenchState, workspaceId: string, id: PlacementId, collapsed: boolean): WorkbenchState {
  const ws = s.workspaces[workspaceId];
  if (!ws) return s;
  const has = ws.collapsed.includes(id);
  if (has === collapsed) return s;
  return bump({ ...s, workspaces: { ...s.workspaces, [ws.id]: { ...ws, collapsed: collapsed ? [...ws.collapsed, id] : ws.collapsed.filter((c) => c !== id) } } });
}

export function withOverrides(s: WorkbenchState, overrides: WorkbenchState['overrides']): WorkbenchState {
  return bump({ ...s, overrides });
}

import { describe, expect, it } from 'vitest';
import type { Migration, StateSchema, StoredValue } from '@tessera/base';
import type { Scope } from '@tessera/di';
import {
  CoreTopics,
  EventNode,
  LAYOUT_STORAGE_KEY,
  LayoutMigration,
  LayoutStore,
  LifecyclePhase,
  LifecycleService,
  PlacementStatus,
  emptyOverrides,
  type PluginModule,
  type PlacementId,
  type ViewProvider,
  type WorkbenchSnapshot,
} from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin, type TestApp } from '@tessera/testing';
import { computed } from '@tessera/reactive';
import { listLocal, listManifest, listModule, listProvider, type ListIntents, type ListState } from './kit.ts';

const EDITOR = 'workbench.editorArea';
const sv = (v: number, data: unknown): StoredValue => ({ v, data });

function snapshot(partial: Partial<WorkbenchSnapshot>): WorkbenchSnapshot {
  return { savedAt: '2026-11-06T10:00:00.000Z', appVersion: '0.0.0-test', windows: [], workspaces: {}, placements: {}, instances: {}, closedInstances: [], overrides: emptyOverrides(), focus: undefined, ...partial };
}

/** Two dock tabs of one keyed view type, p2 active. */
function twoTabs(extra?: Partial<WorkbenchSnapshot>): WorkbenchSnapshot {
  return snapshot({
    workspaces: {
      [EDITOR]: {
        active: 'p2',
        collapsed: [],
        members: ['p1', 'p2'],
        arrangement: { engine: 'fake', engineVersion: '1.0', data: { groups: [{ id: 'g1', panels: ['p1', 'p2'], active: 'p2', where: 'grid' }], next: 2 } },
      },
    },
    placements: {
      p1: { viewType: 'fixture.list', instanceId: 'i1', workspaceId: EDITOR, local: sv(1, { scrollTop: 40 }), dock: { group: 'g1', where: 'grid', popoutId: undefined } },
      p2: { viewType: 'fixture.list', instanceId: 'i1', workspaceId: EDITOR, local: sv(1, { scrollTop: 5 }), dock: { group: 'g1', where: 'grid', popoutId: undefined } },
    },
    instances: { i1: { viewType: 'fixture.list', key: '', workItemPath: 'root', shared: sv(1, { selectedId: 'b' }) } },
    focus: 'p2',
    ...extra,
  });
}

function seed(snap: unknown, version = 1): { project: Record<string, unknown> } {
  return { project: { [LAYOUT_STORAGE_KEY]: { v: version, data: snap } } };
}

async function boot(options: { snapshot?: unknown; version?: number; log?: string[]; manifest?: ReturnType<typeof listManifest>; start?: boolean; module?: PluginModule; appModules?: Parameters<typeof createTestApp>[0] extends infer O ? (O extends { appModules?: infer M } ? M : never) : never }): Promise<TestApp> {
  const description = describePlugin(options.manifest ?? listManifest());
  return createTestApp({
    plugins: [description],
    modules: { [description.location]: options.module ?? listModule(options.log) },
    ...(options.snapshot !== undefined ? { storage: seed(options.snapshot, options.version) } : {}),
    ...(options.appModules ? { appModules: options.appModules } : {}),
    ...(options.start === false ? { start: false } : {}),
  });
}

const storedLayout = (app: TestApp): { v: number; data: WorkbenchSnapshot } => app.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { v: number; data: WorkbenchSnapshot };

describe('C22: restore order (contracts.md 16.5)', () => {
  it('C22: steps 2 to 6 run before the window mounts: placements exist with their ids, nothing is created, no plugin code ran', async () => {
    const log: string[] = [];
    const app = await boot({ snapshot: twoTabs(), log, start: false });
    let atMount: { ids: string[]; statuses: string[]; presenters: number; logAtMount: string[]; phase: number } | undefined;
    await app.app.start({
      mount: () => {
        const ids = Object.keys(app.workbench.state.peek().placements);
        atMount = {
          ids: ids.sort(),
          statuses: ids.map((id) => app.workbench.state.peek().placements[id]!.status),
          presenters: ids.filter((id) => app.workbench.placement(id as PlacementId)?.presenter !== undefined).length,
          logAtMount: [...log],
          phase: app.application.get(LifecycleService).phase.peek(),
        };
      },
    });
    expect(atMount).toEqual({ ids: ['p1', 'p2'], statuses: ['pending', 'pending'], presenters: 0, logAtMount: [], phase: LifecyclePhase.Ready });
    await app.settle();
    // steps 7 to 10: the surface restores, only the visible tab gets view model and presenter
    expect(app.workbench.placement('p2' as PlacementId)?.presenter).toBeDefined();
    expect(app.workbench.placement('p1' as PlacementId)?.presenter).toBeUndefined(); // hidden: costs no plugin code
    expect(app.workbench.placement('p1' as PlacementId)?.status.peek()).toBe(PlacementStatus.Pending);
    expect(log.filter((l) => l === 'activate')).toHaveLength(1);
    expect(log.filter((l) => l === 'viewModel')).toHaveLength(1);
    expect(app.application.get(LifecycleService).phase.peek()).toBe(LifecyclePhase.Restored);
    expect(app.workbench.focused.peek()?.id).toBe('p2'); // step 10: focus restored
  });

  it('C22: the dock surface gets restore(arrangement, knownIds) and keeps the stored group layout', async () => {
    const app = await boot({ snapshot: twoTabs() });
    const fake = app.dock!.surfaces.get(EDITOR)!;
    expect(fake.groups()).toEqual([{ id: 'g1', panels: ['p1', 'p2'], active: 'p2', where: 'grid' }]);
    expect(fake.visiblePanels()).toEqual(['p2']);
  });

  it('C22: stored shared state is attached to the instance and stored local state to the placement, and both are migrated when the presenter is created', async () => {
    const app = await boot({ snapshot: twoTabs() });
    const p2 = app.workbench.placement('p2' as PlacementId)!;
    const state = p2.presenter!.viewState.peek() as ListState;
    expect(state.selectedId).toBe('b'); // shared
    expect(state.scrollTop).toBe(5); // local of p2
    expect(app.workbench.instance(p2.instanceId)?.id).toBe('i1'); // instance id kept from the snapshot
    // p1 was not visible: its stored local value is untouched until it becomes visible
    await app.workbench.activate('p1' as PlacementId);
    await app.settle();
    expect((app.workbench.placement('p1' as PlacementId)!.presenter!.viewState.peek() as ListState).scrollTop).toBe(40);
  });

  it('C22: a container default placement has a deterministic id and gets its stored local state back after a restart', async () => {
    const manifest = listManifest({ contributes: { workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }], views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.side' }] } });
    const app = await boot({ manifest, snapshot: snapshot({ placements: { 'p:fixture.side:fixture.list': { viewType: 'fixture.list', instanceId: 'i9', workspaceId: 'fixture.side', local: sv(1, { scrollTop: 99 }), dock: undefined } } }) });
    const placement = app.workbench.placement('p:fixture.side:fixture.list' as PlacementId)!;
    expect(placement).toBeDefined();
    expect((placement.presenter!.viewState.peek() as ListState).scrollTop).toBe(99);
  });
});

describe('C22: failure policy and unknown ids', () => {
  it('C22: an unknown view type restores as a placeholder with its state untouched, and the next save keeps it unchanged', async () => {
    const stored = snapshot({
      workspaces: { [EDITOR]: { active: 'px', collapsed: [], members: ['px'], arrangement: undefined } },
      placements: { px: { viewType: 'gone.view', instanceId: 'ix', workspaceId: EDITOR, local: sv(3, { weird: true }), dock: undefined } },
      instances: { ix: { viewType: 'gone.view', key: 'k', workItemPath: 'root/gone', shared: sv(2, { shared: [1, 2] }) } },
      overrides: { views: { 'gone.view': { workspace: 'gone.workspace', hidden: true } }, workspaces: { 'gone.workspace': { part: 'panel' } } },
    });
    const app = await boot({ snapshot: stored });
    const px = app.workbench.placement('px' as PlacementId)!;
    expect(px.status.peek()).toBe(PlacementStatus.Placeholder);
    expect(px.problem).toContain('Unknown view type "gone.view"');
    await app.get(LayoutStore).flush();
    const saved = storedLayout(app).data;
    expect(saved.placements['px']).toEqual(stored.placements['px']);
    expect(saved.instances['ix']).toEqual(stored.instances['ix']);
    expect(saved.overrides).toEqual(stored.overrides); // overrides naming unknown ids survive
    expect(saved.workspaces[EDITOR]?.members).toEqual(['px']);
  });

  it('C22: placements and workspaces that name an unknown workspace are kept untouched in the snapshot', async () => {
    const stored = snapshot({
      workspaces: { 'gone.workspace': { active: undefined, collapsed: ['q'], members: ['q'], arrangement: undefined } },
      placements: { q: { viewType: 'fixture.list', instanceId: 'iq', workspaceId: 'gone.workspace', local: sv(1, { scrollTop: 1 }), dock: undefined } },
    });
    const app = await boot({ snapshot: stored });
    await app.get(LayoutStore).flush();
    const saved = storedLayout(app).data;
    expect(saved.placements['q']).toEqual(stored.placements['q']);
    expect(saved.workspaces['gone.workspace']).toEqual(stored.workspaces['gone.workspace']);
  });

  it('C22: bad stored local state falls back to initial() and is reported (source view, plugin id)', async () => {
    const stored = twoTabs();
    (stored.placements['p2'] as { local: StoredValue }).local = sv(1, { scrollTop: 'not a number' });
    const errors = captureErrors();
    const app = await boot({ snapshot: stored });
    expect((app.workbench.placement('p2' as PlacementId)!.presenter!.viewState.peek() as ListState).scrollTop).toBe(0);
    expect(errors.drain().map((e) => e.context)).toEqual([expect.objectContaining({ source: 'view', pluginId: 'fixture.view' })]);
    errors.dispose();
  });

  it('C22: an unreadable snapshot gives the default layout, keeps a backup, and the app starts', async () => {
    const app = await boot({ snapshot: 'this is not a snapshot', version: 1 });
    expect(Object.keys(app.workbench.state.peek().placements)).toEqual([]);
    expect(app.application.get(LifecycleService).phase.peek()).toBe(LifecyclePhase.Restored);
    const stored = app.storage.snapshot('project');
    await app.storageService.flush();
    expect(Object.keys(app.storage.snapshot('project')).some((k) => k.startsWith(`${LAYOUT_STORAGE_KEY}.bak.`))).toBe(true);
    void stored;
  });

  it('C22: a snapshot newer than the app is backed up as <key>.bak.v<n> and the default layout applies', async () => {
    const app = await boot({ snapshot: twoTabs(), version: 9 });
    expect(Object.keys(app.workbench.state.peek().placements)).toEqual([]);
    await app.storageService.flush();
    expect(app.storage.snapshot('project')[`${LAYOUT_STORAGE_KEY}.bak.v9`]).toEqual({ v: 9, data: twoTabs() });
  });
});

describe('C22: migrations', () => {
  const rename: Migration = {
    from: 1,
    migrate: (d) => {
      const s = d as WorkbenchSnapshot;
      const placements = Object.fromEntries(Object.entries(s.placements).map(([id, p]) => [id, { ...p, viewType: p.viewType === 'old.list' ? 'fixture.list' : p.viewType }]));
      const instances = Object.fromEntries(Object.entries(s.instances).map(([id, i]) => [id, { ...i, viewType: i.viewType === 'old.list' ? 'fixture.list' : i.viewType }]));
      return { ...s, placements, instances };
    },
  };
  const withStep = [{ id: 'test.layoutMigration', install: ({ application }: { application: Scope }) => void application.provideMany(LayoutMigration, () => rename) }];

  it('C22: a test-only LayoutMigration step runs on an older snapshot fixture (v1 to v2), and the next save writes v2', async () => {
    const old = twoTabs();
    for (const p of Object.values(old.placements)) (p as { viewType: string }).viewType = 'old.list';
    (old.instances['i1'] as { viewType: string }).viewType = 'old.list';
    const app = await boot({ snapshot: old, version: 1, appModules: withStep });
    const p2 = app.workbench.placement('p2' as PlacementId)!;
    expect(p2.viewType).toBe('fixture.list'); // not a placeholder: the step renamed the type
    expect(p2.status.peek()).toBe(PlacementStatus.Attached);
    await app.get(LayoutStore).flush();
    expect(storedLayout(app).v).toBe(2);
    expect(storedLayout(app).data.placements['p2']?.viewType).toBe('fixture.list');
  });

  it('C22: without the step the same fixture is read as v1 and the old type is a placeholder', async () => {
    const old = twoTabs();
    for (const p of Object.values(old.placements)) (p as { viewType: string }).viewType = 'old.list';
    const app = await boot({ snapshot: old, version: 1 });
    expect(app.workbench.placement('p2' as PlacementId)!.status.peek()).toBe(PlacementStatus.Placeholder);
    await app.get(LayoutStore).flush();
    expect(storedLayout(app).v).toBe(1);
  });

  it('C22: view local state migrates lazily, on first presenter creation, with the schema of the provider (code lives in the plugin)', async () => {
    let migrations = 0;
    const v2: StateSchema<{ scrollTop: number; expanded: readonly string[] }> = {
      version: 2,
      schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null && Array.isArray((i as { expanded?: unknown }).expanded) ? { success: true as const, data: i as never } : { success: false as const, error: { issues: [] } }) },
      initial: () => ({ scrollTop: 0, expanded: [] }),
      migrations: [{ from: 1, migrate: (d) => (migrations++, { ...(d as object), expanded: ['root'] }) }],
    };
    const base = listProvider();
    const provider: ViewProvider = {
      ...base,
      localState: v2 as unknown as StateSchema<never>,
      createPresenter: (ctx) => {
        const viewState = computed(() => ({ local: ctx.local.get() }), { name: 'v2.state' });
        return { viewState, intents: {}, dispose() {} };
      },
    } as ViewProvider;
    const module: PluginModule = { activate: (ctx) => void ctx.views.registerProvider(provider) };
    const app = await boot({ snapshot: twoTabs(), module, start: false });
    let migratedAtMount = -1;
    await app.app.start({ mount: () => void (migratedAtMount = migrations) });
    await app.settle();
    expect(migratedAtMount).toBe(0); // nothing migrated while restoring the model
    expect(migrations).toBe(1); // p2 became visible, p1 did not
    expect((app.workbench.placement('p2' as PlacementId)!.presenter!.viewState.peek() as { local: unknown }).local).toEqual({ scrollTop: 5, expanded: ['root'] });
    void listLocal;
  });
});

describe('C22: round trip', () => {
  it('C22: layout, shared state and local state survive a restart: same placement ids, scroll, selection, dock groups and focus', async () => {
    const app = await boot({});
    const a = await app.workbench.showView('fixture.list', { workspace: EDITOR });
    const b = await app.workbench.showView('fixture.list', { workspace: EDITOR, reuse: 'new' });
    (app.workbench.placement(a.id)!.presenter!.intents as ListIntents).select('c');
    (app.workbench.placement(a.id)!.presenter!.intents as ListIntents).scrolled(77);
    (app.workbench.placement(b.id)!.presenter!.intents as ListIntents).scrolled(3);
    const fake = app.dock!.surfaces.get(EDITOR)!;
    fake.userMoveToNewGroup(b.id, 'right');
    await app.settle();
    const groupsBefore = fake.groups();
    const again = await app.restart();
    const fake2 = again.dock!.surfaces.get(EDITOR)!;
    expect(Object.keys(again.workbench.state.peek().placements).sort()).toEqual([a.id, b.id].sort());
    expect(fake2.groups()).toEqual(groupsBefore);
    const stateA = (again.workbench.placement(a.id)!.presenter?.viewState.peek() ?? (await again.workbench.activate(a.id).then(() => again.settle()).then(() => again.workbench.placement(a.id)!.presenter!.viewState.peek()))) as ListState;
    expect(stateA.selectedId).toBe('c');
    expect(stateA.scrollTop).toBe(77);
    await again.workbench.activate(b.id);
    await again.settle();
    expect((again.workbench.placement(b.id)!.presenter!.viewState.peek() as ListState).scrollTop).toBe(3);
  });

  it('C22: the layout is saved 500 ms after a change (LayoutStore), then written to the backend by the storage write-behind', async () => {
    const app = await boot({});
    await app.advance(5_000);
    const writesBefore = app.storage.writes.length;
    const p = await app.workbench.showView('fixture.list', { workspace: EDITOR });
    const inMemory = (): Record<string, unknown> => ((app.storageService.get('project', LAYOUT_STORAGE_KEY) as { data: WorkbenchSnapshot } | undefined)?.data.placements ?? {});
    await app.advance(499);
    expect(Object.keys(inMemory())).not.toContain(p.id);
    await app.advance(1);
    expect(Object.keys(inMemory())).toContain(p.id); // in memory after the layout debounce
    expect(app.storage.writes.length).toBe(writesBefore); // not yet on the backend
    await app.advance(500);
    expect(app.storage.writes.length).toBeGreaterThan(writesBefore);
  });

  it('C22: shutdown joins layout.save and storage.flush, so the last change reaches the backend without waiting for any timer', async () => {
    const app = await boot({});
    const p = await app.workbench.showView('fixture.list', { workspace: EDITOR });
    const result = await app.app.shutdown('close');
    expect(result.timedOut).toEqual([]);
    expect(storedLayout(app).data.placements[p.id]).toBeDefined();
  });

  it('C22: workbench.restored is published once the visible placements are ready', async () => {
    const app = await boot({ snapshot: twoTabs() });
    const seen: number[] = [];
    app.application.get(EventNode).subscribe(CoreTopics.workbenchRestored, (e) => seen.push(e.placements)); // sticky: replayed through the scheduler microtask
    app.scheduler.flushMicrotasks();
    expect(seen).toEqual([2]);
  });

  it('C22: resetLayout drops placements and overrides and rebuilds the defaults', async () => {
    const app = await boot({});
    await app.workbench.showView('fixture.list', { workspace: EDITOR });
    await app.workbench.resetLayout();
    expect(Object.keys(app.workbench.state.peek().placements)).toEqual([]);
    expect(app.workbench.state.peek().overrides).toEqual(emptyOverrides());
  });

  it('C22: resetLayout clears the stored snapshot and the closed-instance cache: a view hidden by default does not come back, and its old local state is gone (workbench row 6)', async () => {
    const stored = snapshot({
      placements: { 'p:fixture.side:fixture.list': { viewType: 'fixture.list', instanceId: 'i9', workspaceId: 'fixture.side', local: sv(1, { scrollTop: 99 }), dock: undefined } },
      closedInstances: [{ viewType: 'fixture.list', key: '', shared: sv(1, { selectedId: 'c' }), closedAt: '2026-11-01T00:00:00.000Z' }],
    });
    const app = await boot({ snapshot: stored }); // visibleByDefault is false: only the stored snapshot brings the placement back
    expect(app.workbench.placement('p:fixture.side:fixture.list' as PlacementId)).toBeDefined();
    await app.workbench.resetLayout();
    expect(app.workbench.placement('p:fixture.side:fixture.list' as PlacementId)).toBeUndefined();
    expect(Object.keys(app.workbench.state.peek().placements)).toEqual([]);
    await app.get(LayoutStore).flush();
    expect(storedLayout(app).data.closedInstances).toEqual([]);
    // showing the view again starts from the initial local and shared state
    const again = await app.workbench.showView('fixture.list', { workspace: 'fixture.side' });
    const view = app.workbench.placement(again.id)!.presenter!.viewState.peek() as ListState;
    expect(view.scrollTop).toBe(0);
    expect(view.selectedId).toBeUndefined();
  });

  it('C22: a placement moved between container workspaces keeps its local state across a restart (workbench row 5)', async () => {
    // the stored layout has the view under its old workspace; an override moved it to fixture.side
    const manifest = listManifest({ contributes: { workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }, { id: 'fixture.old', title: 'Old', kind: 'tabs', part: 'panel' }], views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.old' }] } });
    const stored = snapshot({
      placements: { 'p:fixture.old:fixture.list': { viewType: 'fixture.list', instanceId: 'i9', workspaceId: 'fixture.old', local: sv(1, { scrollTop: 77 }), dock: undefined } },
      overrides: { views: { 'fixture.list': { workspace: 'fixture.side' } }, workspaces: {} },
    });
    const app = await boot({ manifest, snapshot: stored });
    const moved = app.workbench.placement('p:fixture.side:fixture.list' as PlacementId)!;
    expect(moved).toBeDefined();
    expect((moved.presenter!.viewState.peek() as ListState).scrollTop).toBe(77);
  });

  it('C22: a move at run time and a restart keep the local state of a container placement', async () => {
    const manifest = listManifest({ contributes: { workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }, { id: 'fixture.other', title: 'Other', kind: 'tabs', part: 'panel' }], views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.side' }] } });
    const app = await boot({ manifest });
    const first = app.workbench.placement('p:fixture.side:fixture.list' as PlacementId)!;
    (first.presenter!.intents as ListIntents).scrolled(55);
    await app.workbench.move(first.id, { kind: 'workspace', workspace: 'fixture.other' });
    await app.get(LayoutStore).flush();
    const again = await app.restart();
    const placement = Object.values(again.workbench.state.peek().placements).find((p) => p.viewType === 'fixture.list');
    expect(placement?.workspaceId).toBe('fixture.other');
    expect((again.workbench.placement(placement!.id)!.presenter!.viewState.peek() as ListState).scrollTop).toBe(55);
  });

  it('C22: a lazily reset view state (reset-newer or reset-invalid) leaves a .bak copy of the stored value (persistence P2)', async () => {
    const stored = snapshot({
      workspaces: { [EDITOR]: { active: 'p1', collapsed: [], members: ['p1'], arrangement: undefined } },
      placements: { p1: { viewType: 'fixture.list', instanceId: 'i1', workspaceId: EDITOR, local: sv(9, { scrollTop: 1 }), dock: { group: 'g1', where: 'grid', popoutId: undefined } } },
      instances: { i1: { viewType: 'fixture.list', key: '', workItemPath: 'root', shared: sv(9, { selectedId: 'x' }) } },
    });
    const errors = captureErrors();
    const app = await boot({ snapshot: stored });
    await app.workbench.activate('p1' as PlacementId);
    await app.settle();
    errors.drain();
    errors.dispose();
    await app.storageService.flush();
    const project = app.storage.snapshot('project');
    expect(project[`${LAYOUT_STORAGE_KEY}.bak.local.p1.v9`]).toEqual(sv(9, { scrollTop: 1 }));
    expect(project[`${LAYOUT_STORAGE_KEY}.bak.shared.i1.v9`]).toEqual(sv(9, { selectedId: 'x' }));
  });
});

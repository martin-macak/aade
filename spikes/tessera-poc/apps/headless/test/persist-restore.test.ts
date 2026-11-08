import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, LayoutStore, PlacementStatus, type PlacementId, type WorkbenchSnapshot } from '@tessera/contracts';
import { TaskStore } from '@tessera-poc/plugin-tasks';
import { createDemoApp } from '@tessera-poc/headless';
import layoutV1 from '../fixtures/layout-v1.json' with { type: 'json' };
import { EDITOR, openTwice, presenterOf } from './kit.ts';

const SIDE_ID = 'p:tasks.sidebar:tasks.list' as PlacementId;
const stored = (app: Awaited<ReturnType<typeof createDemoApp>>) => app.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { v: number; data: WorkbenchSnapshot };

describe('C22: layout and view state with a schema migration (fixture layout-v1.json)', () => {
  it('C22: the tasks.list local state v1 of the fixture migrates to v2 lazily, on the first presenter creation', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'], storage: { project: { [LAYOUT_STORAGE_KEY]: layoutV1 } } });
    // visible placements: the side bar tab and the active dock tab pd1
    const side = presenterOf(app, { id: SIDE_ID } as never);
    expect(side.state()).toMatchObject({ scrollTop: 55, localFilter: '', pinned: false }); // v2 fields filled by the migration
    expect(side.state().groups.every((g) => g.expanded === (g.project === 'project-a'))).toBe(true); // expandedGroups survived
    const pd1 = presenterOf(app, { id: 'pd1' } as never);
    expect(pd1.state()).toMatchObject({ scrollTop: 12, localFilter: '', pinned: false });
    expect(side.state().selectedId).toBe('t2'); // shared state, also stored v1 and current
  });

  it('C22: a hidden dock tab keeps its stored v1 value untouched until it becomes visible, and the next save writes it back unchanged', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'], storage: { project: { [LAYOUT_STORAGE_KEY]: layoutV1 } } });
    expect(app.workbench.placement('pd2' as PlacementId)?.presenter).toBeUndefined();
    await app.get(LayoutStore).flush();
    const saved = stored(app).data;
    expect(saved.placements['pd2']?.local).toEqual({ v: 1, data: { scrollTop: 3, expandedGroups: [] } }); // untouched
    expect(saved.placements['pd1']?.local).toMatchObject({ v: 2 }); // visible: migrated and saved as v2
    await app.workbench.activate('pd2' as PlacementId);
    await app.settle();
    expect(presenterOf(app, { id: 'pd2' } as never).state()).toMatchObject({ scrollTop: 3, localFilter: '', pinned: false });
    await app.get(LayoutStore).flush();
    expect(stored(app).data.placements['pd2']?.local).toMatchObject({ v: 2 });
  });

  it('C22: the restore follows the normative order: ids kept, focus restored, dock groups restored from the arrangement', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'], storage: { project: { [LAYOUT_STORAGE_KEY]: layoutV1 } } });
    expect(Object.keys(app.workbench.state.peek().placements).sort()).toEqual(['p:tasks.sidebar:tasks.list', 'pd1', 'pd2']);
    expect(app.workbench.focused.peek()?.id).toBe('pd1');
    expect(app.dock!.surfaces.get(EDITOR)!.groups()).toEqual([{ id: 'g1', panels: ['pd1', 'pd2'], active: 'pd1', where: 'grid' }]);
    expect(app.workbench.state.peek().workspaces['tasks.sidebar']).toMatchObject({ members: [SIDE_ID], active: SIDE_ID });
  });

  it('C22: when the plugin is gone at restore, its views are placeholders with state untouched, and they survive the next save', async () => {
    const app = await createDemoApp({ only: ['sample.audit'], storage: { project: { [LAYOUT_STORAGE_KEY]: layoutV1 } } });
    for (const id of ['pd1', 'pd2']) {
      expect(app.workbench.placement(id as PlacementId)?.status.peek()).toBe(PlacementStatus.Placeholder);
      expect(app.workbench.placement(id as PlacementId)?.problem).toContain('Unknown view type "tasks.list"');
    }
    await app.get(LayoutStore).flush();
    const saved = stored(app).data;
    expect(saved.placements['pd1']).toEqual(layoutV1.data.placements.pd1);
    expect(saved.placements['p:tasks.sidebar:tasks.list']?.local).toEqual(layoutV1.data.placements['p:tasks.sidebar:tasks.list'].local);
    expect(saved.instances['inst1']?.shared).toEqual(layoutV1.data.instances.inst1.shared);
  });
});

describe('C22: round trip over a restart', () => {
  it('C22: tasks, layout, shared state and every local state come back after a restart', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'Write tests', project: 'project-a' });
    await app.commands.execute('tasks.add', { title: 'Ship it', project: 'project-b' });
    const { side, dock } = await openTwice(app);
    presenterOf(app, side).intents.select('t2');
    presenterOf(app, side).intents.scrolled(42);
    presenterOf(app, side).intents.toggleGroup('project-a');
    presenterOf(app, dock).intents.setLocalFilter('ship');
    presenterOf(app, dock).intents.setPinned(true);
    presenterOf(app, dock).intents.setSharedFilter('');
    await app.commands.execute('tasks.complete', { id: 't1' });

    const again = await app.restart();
    expect(again.window.get(TaskStore).tasks.peek().map((t) => [t.id, t.done])).toEqual([['t1', true], ['t2', false]]);
    const s = presenterOf(again, side);
    const d = presenterOf(again, dock);
    expect(s.state()).toMatchObject({ selectedId: 't2', scrollTop: 42, remaining: 1 });
    expect(s.state().groups.find((g) => g.project === 'project-a')?.expanded).toBe(false);
    expect(d.state()).toMatchObject({ scrollTop: 0, localFilter: 'ship', pinned: true });
    expect(again.workbench.placement(dock.id)?.workspaceId).toBe(EDITOR);
    expect(again.workbench.focused.peek()?.id).toBe(dock.id);
  });

  it('C22: the layout reaches the storage 500 ms after a change (LayoutStore) and the backend after another 500 ms (write-behind)', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.advance(10_000);
    const writes = app.storage.writes.length;
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
    await app.advance(500);
    expect((app.storageService.get('project', LAYOUT_STORAGE_KEY) as { data: WorkbenchSnapshot }).data.placements[dock.id]).toBeDefined();
    expect(app.storage.writes.length).toBe(writes);
    await app.advance(500);
    expect(app.storage.writes.length).toBeGreaterThan(writes);
  });

  it('C22: a shutdown joins layout.save and storage.flush: the last change is on the backend without any timer', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'last words' });
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
    const result = await app.app.shutdown('close');
    expect(result).toMatchObject({ vetoed: false, timedOut: [] });
    expect(stored(app).data.placements[dock.id]).toBeDefined();
    expect(app.storage.snapshot('project')['plugin:sample.tasks:tasks']).toBeDefined();
  });
});

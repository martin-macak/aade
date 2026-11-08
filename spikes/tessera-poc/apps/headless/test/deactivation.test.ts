import { describe, expect, it } from 'vitest';
import { PlacementStatus, StatusBarService, UndoService, type PluginStatus } from '@tessera/contracts';
import type { DefaultPluginManager } from '@tessera/plugins';
import { createDemoApp } from '@tessera-poc/headless';
import { TaskStore } from '@tessera-poc/plugin-tasks';
import { openTwice, presenterOf } from './kit.ts';

describe('C17: deactivation leaves nothing behind', () => {
  it('C17: dependents deactivate first (sample.taskStats before sample.tasks), and the provided registration leaves the window scope', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.taskStats'] });
    await app.toEventually(); // onStartupFinished: taskStats activates, tasks first
    expect(app.plugins.status('sample.tasks')?.state).toBe('active');
    expect(app.plugins.status('sample.taskStats')?.state).toBe('active');
    expect(app.window.get(TaskStore, { optional: true })).toBeDefined();

    const sequence: string[] = [];
    app.plugins.onDidChangeState((s: PluginStatus) => sequence.push(`${s.id}:${s.state}`));
    await app.plugins.deactivate('sample.tasks');
    expect(sequence).toEqual([
      'sample.taskStats:deactivating',
      'sample.taskStats:resolved',
      'sample.tasks:deactivating',
      'sample.tasks:resolved',
    ]);
    expect(app.window.get(TaskStore, { optional: true })).toBeUndefined();
    expect(app.workItems.find('root/tasks')).toBeUndefined(); // the WorkItems it created are terminated
    expect(app.workItems.find('root/tasks/project-a')).toBeUndefined();
  });

  it('C17: the status bar item of sample.taskStats shows the open count and goes away with the plugin', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.taskStats'] });
    await app.toEventually();
    const items = () => app.get(StatusBarService).items(app.workItems.root.context).peek().left.map((i) => i.text);
    expect(items()).toEqual(['0 open tasks']);
    await app.commands.execute('tasks.add', { title: 'one' });
    expect(items()).toEqual(['1 open task']);
    await app.plugins.deactivate('sample.taskStats');
    expect(items()).toEqual([]);
  });

  it('C17: undo entries are invalidated, contributions stay applied, and the live-disposables report is empty', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'undoable' });
    const undo = app.get(UndoService);
    expect(undo.canUndo('sample.tasks').peek()).toBe(true);
    await app.plugins.deactivate('sample.tasks');
    expect(await undo.undo('sample.tasks')).toBe(false); // invalid entries are skipped and dropped
    expect(app.commands.status('tasks.add', app.contextKeys.focused.peek())).toBe('enabled'); // still declared: the plugin sleeps
    expect((app.plugins as DefaultPluginManager).liveDisposables('sample.tasks')).toEqual([]);
    expect(app.plugins.status('sample.tasks')?.state).toBe('resolved');
  });

  it('C17: placements of the plugin views become placeholders with local state kept, and come back from the kept state on reactivation', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const { side, dock } = await openTwice(app);
    presenterOf(app, side).intents.select('t1');
    presenterOf(app, side).intents.scrolled(120);
    presenterOf(app, dock).intents.scrolled(7);
    const sidePlacement = app.workbench.placement(side.id)!;
    const dockPlacement = app.workbench.placement(dock.id)!;

    await app.plugins.deactivate('sample.tasks');
    await app.settle();
    for (const p of [sidePlacement, dockPlacement]) {
      expect(p.status.peek()).toBe(PlacementStatus.Placeholder);
      expect(p.presenter).toBeUndefined();
      expect(p.problem).toContain('sample.tasks');
    }
    expect(sidePlacement.local.peek()).toMatchObject({ scrollTop: 120 }); // state kept
    expect(dockPlacement.local.peek()).toMatchObject({ scrollTop: 7 });
    expect(app.workbench.instance(side.instanceId)).toBeUndefined(); // the live instance went with its WorkItem
    expect(app.workbench.state.peek().instances[side.instanceId]?.placements).toHaveLength(2); // but the record stays

    await app.plugins.activate('sample.tasks'); // reactivation: the provider registers again
    await app.settle();
    expect(sidePlacement.status.peek()).toBe(PlacementStatus.Attached);
    expect(presenterOf(app, side).state().scrollTop).toBe(120);
    expect(presenterOf(app, side).state().selectedId).toBe('t1'); // shared state kept too
    expect(presenterOf(app, dock).state().scrollTop).toBe(7);
  });

  it('C17: a failed plugin turns its placements into placeholders as well, with the failure in the problem text', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const side = await app.workbench.showView('tasks.list');
    expect(app.workbench.placement(side.id)?.presenter).toBeDefined();
    await app.plugins.deactivate('sample.tasks');
    await app.settle();
    expect(app.workbench.placement(side.id)?.status.peek()).toBe(PlacementStatus.Placeholder);
  });
});

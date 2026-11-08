import { describe, expect, it } from 'vitest';
import { PlacementStatus } from '@tessera/contracts';
import type { DefaultPluginManager } from '@tessera/plugins';
import { createDemoApp } from '@tessera-poc/headless';
import { openTwice, presenterOf } from './kit.ts';

describe('C17: dev hot reload', () => {
  it('C17: reload deactivates the plugin with its dependents, imports it again and reactivates both; nothing is left behind', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.taskStats'], onLoad: (id) => loads.push(id) });
    await app.toEventually();
    expect(loads).toEqual(['sample.tasks', 'sample.taskStats']);
    await app.commands.execute('tasks.add', { title: 'survives reload' });
    const sequence: string[] = [];
    const leftBehind: string[] = [];
    app.plugins.onDidChangeState((s) => {
      sequence.push(`${s.id}:${s.state}`);
      // the dev-mode report right after a deactivation must be empty
      if (s.state === 'resolved') leftBehind.push(...(app.plugins as DefaultPluginManager).liveDisposables(s.id));
    });

    await app.plugins.reload('sample.tasks');

    expect(loads).toEqual(['sample.tasks', 'sample.taskStats', 'sample.tasks', 'sample.taskStats']); // imported again
    expect(sequence.filter((s) => s.endsWith('deactivating'))).toEqual(['sample.taskStats:deactivating', 'sample.tasks:deactivating']);
    expect(sequence.filter((s) => s.endsWith(':active'))).toEqual(['sample.tasks:active', 'sample.taskStats:active']); // provider first
    expect(app.plugins.status('sample.tasks')?.state).toBe('active');
    expect(app.plugins.status('sample.taskStats')?.state).toBe('active');
    expect(leftBehind).toEqual([]);
    // the data is not lost: tasks live in the project storage, the new store reads them
    const side = await app.workbench.showView('tasks.list');
    expect(presenterOf(app, side).state().total).toBe(1);
  });

  it('C17: open views survive a reload: placeholders while the plugin is away, then presenters again from the kept state', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const { side, dock } = await openTwice(app);
    presenterOf(app, dock).intents.scrolled(55);
    presenterOf(app, side).intents.select('t9');
    await app.plugins.reload('sample.tasks');
    await app.settle();
    expect(app.workbench.placement(side.id)?.status.peek()).toBe(PlacementStatus.Attached);
    expect(app.workbench.placement(dock.id)?.status.peek()).toBe(PlacementStatus.Attached);
    expect(presenterOf(app, dock).state().scrollTop).toBe(55);
    expect(presenterOf(app, side).state().selectedId).toBe('t9');
  });

  it('C17: reload re-reads the manifest from the catalog: a changed contribution is applied again', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.plugins.activate('sample.tasks');
    const { tasksManifest } = await import('@tessera-poc/headless');
    const changed = { ...tasksManifest, contributes: { ...tasksManifest.contributes, commands: [...(tasksManifest.contributes?.['commands'] ?? []), { id: 'tasks.extra', title: 'Extra' }] } };
    const { describePlugin } = await import('@tessera/testing');
    app.catalog.replace(describePlugin(changed, 'builtin')); // the manifest was edited on disk
    await app.plugins.reload('sample.tasks');
    const { CommandRegistry } = await import('@tessera/contracts');
    expect(app.window.get(CommandRegistry).metadata('tasks.extra')?.owner).toBe('sample.tasks');
  });
});

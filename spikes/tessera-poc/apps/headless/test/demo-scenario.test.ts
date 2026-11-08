import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, MenuId, defineTopic, type WorkbenchSnapshot } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { AuditLogToken } from '@tessera-poc/plugin-audit';
import { createDemoApp } from '@tessera-poc/headless';
import { EDITOR, menuItems, presenterOf, statusOf, titles } from './kit.ts';

// Claim C23: the whole demo scenario (brief section 7, items 1 to 6) runs in Node with no DOM: createTestApp boots @tessera/shell
// with an in-memory host and the four sample plugins, and everything below goes through commands and presenter intents.

const TasksChanged = defineTopic<{ open: number; published: string }>('tasks.changed');

describe('C23: the demo scenario, headless', () => {
  it('C23: demo items 1 to 6 in one run', async () => {
    const errors = captureErrors();
    const app = await createDemoApp(); // all four sample plugins; sample.audit activates at startup, the others are asleep
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined'); // no DOM in this test
    expect(app.plugins.status('sample.tasks')?.state).toBe('resolved');
    expect(app.plugins.status('sample.audit')?.state).toBe('active');

    // item 2: a plugin command is in the palette before the plugin runs; running it activates the plugin
    const palette = menuItems(app, MenuId.CommandPalette, app.contextKeys.focused.peek());
    expect(titles(palette)).toContain('Add Task');
    await app.commands.execute('tasks.add', { title: 'Write the framework', project: 'project-a' }, { source: 'palette' });
    await app.commands.execute('tasks.add', { title: 'Test the framework', project: 'project-b' }, { source: 'palette' });
    expect(app.plugins.status('sample.tasks')).toMatchObject({ state: 'active', activationReason: 'onCommand:tasks.add' });

    // item 1: one view type in two places, one shared state, separate local state
    const side = await app.workbench.showView('tasks.list');
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
    expect(side.instanceId).toBe(dock.instanceId);
    const a = presenterOf(app, side);
    const b = presenterOf(app, dock);
    a.intents.select('t2');
    expect(b.state().selectedId).toBe('t2');
    b.intents.scrolled(250);
    expect(a.state().scrollTop).toBe(0);

    // item 2 again: enablement through a context key, in the view/title menu and the palette of the focused placement
    const placement = app.workbench.placement(dock.id)!;
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('enabled');
    await a.intents.complete(); // intent -> command tasks.complete with the typed selection
    expect(a.state().remaining).toBe(1);
    a.intents.select(undefined);
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('disabled');

    // item 6: events scoped to WorkItems (global, WorkItem, descendants)
    const seen = new Map<string, string[]>();
    const listen = (name: string, node: { subscribe: typeof app.application extends never ? never : (topic: typeof TasksChanged, h: (e: { published: string }) => void) => unknown }) =>
      node.subscribe(TasksChanged, (e) => seen.set(name, [...(seen.get(name) ?? []), e.published]));
    listen('root', app.workItems.root.events as never);
    listen('tasks', app.workItems.find('root/tasks')!.events as never);
    listen('project-a', app.workItems.find('root/tasks/project-a')!.events as never);
    listen('project-b', app.workItems.find('root/tasks/project-b')!.events as never);
    await app.commands.execute('tasks.add', { title: 'Scoped', project: 'project-a' });
    expect(seen.get('root')).toEqual(['global']); // the root hears the global publication only
    expect(seen.get('tasks')).toEqual(['global', 'descendants']);
    expect([...(seen.get('project-a') ?? [])].sort()).toEqual(['descendants', 'global', 'workItem']);
    expect(seen.get('project-b')).toEqual(['global', 'descendants']); // a sibling hears no workItem-scoped event

    // item 3: the plugin interceptor saw the commands and the events
    const log = app.window.get(AuditLogToken).entries.peek();
    expect(log.filter((e) => e.kind === 'command' && e.target === 'tasks.add')).toHaveLength(3);
    expect(log.some((e) => e.kind === 'event' && e.target === 'tasks.changed' && e.source === 'workItem')).toBe(true);
    a.intents.setPinned(true);
    expect(await app.workbench.close(side.id)).toBe(false); // the audit guard vetoes closing a pinned placement
    a.intents.setPinned(false);

    // item 4: lazy activation, failure isolation, deactivation and disposal
    await app.commands.execute('faulty.boom').catch(() => undefined); // sample.faulty fails in activate
    expect(app.plugins.status('sample.faulty')).toMatchObject({ state: 'failed', failure: { cause: 'activateThrew' } });
    expect(await app.commands.execute('tasks.add', { title: 'after the failure' })).toBeDefined(); // everything else runs
    await app.toEventually(); // onStartupFinished: sample.taskStats
    expect(app.plugins.status('sample.taskStats')?.state).toBe('active');
    await app.plugins.deactivate('sample.tasks'); // taskStats goes first (it requires the TaskStore)
    expect(app.plugins.status('sample.taskStats')?.state).toBe('resolved');
    await app.settle();
    expect(app.workbench.placement(side.id)?.status.peek()).toBe('placeholder');
    await app.plugins.activate('sample.tasks'); // and comes back from kept state
    await app.settle();
    expect(presenterOf(app, dock).state().scrollTop).toBe(250);

    // item 5: persistence and restore
    const stateBefore = presenterOf(app, dock).state();
    const again = await app.restart();
    const restored = presenterOf(again, dock);
    expect(restored.state().scrollTop).toBe(250);
    expect(restored.state().total).toBe(stateBefore.total);
    expect((again.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: WorkbenchSnapshot }).data.placements[dock.id]).toBeDefined();

    errors.drain(); // sample.faulty's failure is expected here; its details are asserted in failure-isolation.test.ts
    errors.dispose();
  });

  it('C23: the scenario needs no DOM: the shell, the host, the plugins and the presenters use no document, window or React', async () => {
    const app = await createDemoApp();
    const globals = globalThis as unknown as Record<string, unknown>;
    expect(globals['document']).toBeUndefined();
    expect(globals['window']).toBeUndefined();
    expect(app.get((await import('@tessera/contracts')).HostEnvironment).kind).toBe('test');
  });
});

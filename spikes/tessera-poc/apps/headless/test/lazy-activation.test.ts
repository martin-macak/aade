import { describe, expect, it } from 'vitest';
import { CommandRegistry, MenuId, ViewRegistry } from '@tessera/contracts';
import { createDemoApp } from '@tessera-poc/headless';
import { menuItems, statusOf, titles, viewContext } from './kit.ts';

describe('C15: contributions apply before plugin code loads', () => {
  it('C15: with sample.tasks resolved but not active, the palette and view/title menus already list its commands and tasks.list is a known view type', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks'], onLoad: (id) => loads.push(id) });
    expect(app.plugins.status('sample.tasks')).toMatchObject({ state: 'resolved', activationReason: undefined });
    expect(loads).toEqual([]); // no plugin code has been loaded
    expect(app.get(CommandRegistry).metadata('tasks.add')?.owner).toBe('sample.tasks');
    expect(app.get(ViewRegistry).descriptor('tasks.list')).toMatchObject({ id: 'tasks.list', owner: 'sample.tasks', workspace: 'tasks.sidebar' });

    const palette = menuItems(app, MenuId.CommandPalette, app.contextKeys.focused.peek());
    expect(titles(palette)).toContain('Add Task');
    expect(titles(palette)).toContain('Clear Completed Tasks');
    expect(statusOf(palette, 'tasks.add')).toBe('enabled');

    const viewTitle = menuItems(app, MenuId.ViewTitle, viewContext(app, 'tasks.list'));
    expect(statusOf(viewTitle, 'tasks.add')).toBe('enabled');
    expect(statusOf(viewTitle, 'tasks.complete')).toBe('disabled'); // greyed: tasks.hasSelection is not true
    expect(loads).toEqual([]);
  });

  it('C15: the view/title items follow the when-clause: another view type does not show them', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    expect(menuItems(app, MenuId.ViewTitle, viewContext(app, 'audit.log'))).toEqual([]);
  });

  it('C15: the command declares its keybinding before activation too', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const bindings = app.get((await import('@tessera/contracts')).KeybindingService).lookup('tasks.add');
    expect(bindings.map((b) => b.rule.source)).toEqual(['plugin']);
    expect(bindings[0]?.rule.owner).toBe('sample.tasks');
  });

  it('C15: executing tasks.add activates sample.tasks (onCommand) exactly once, even for concurrent calls, then runs the handler', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks'], onLoad: (id) => loads.push(id) });
    const [a, b] = await Promise.all([app.commands.execute<{ id: string }>('tasks.add', { title: 'first' }, { source: 'palette' }), app.commands.execute<{ id: string }>('tasks.add', { title: 'second' }, { source: 'palette' })]);
    expect([a.id, b.id].sort()).toEqual(['t1', 't2']);
    expect(loads).toEqual(['sample.tasks']);
    expect(app.plugins.status('sample.tasks')).toMatchObject({ state: 'active', activationReason: 'onCommand:tasks.add' });
    await app.commands.execute('tasks.add', { title: 'third' });
    expect(loads).toEqual(['sample.tasks']); // not again
  });

  it('C15: showing tasks.list activates sample.tasks (onView) exactly once, even when two placements are requested at once', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks'], onLoad: (id) => loads.push(id) });
    expect(app.workbench.state.peek().workspaces['tasks.sidebar']).toMatchObject({ kind: 'tabs', owner: 'sample.tasks', partId: 'primarySideBar' });
    await Promise.all([app.workbench.showView('tasks.list'), app.workbench.showView('tasks.list', { workspace: 'workbench.editorArea' })]);
    expect(loads).toEqual(['sample.tasks']);
    expect(app.plugins.status('sample.tasks')?.activationReason).toBe('onView:tasks.list');
  });

  it('C15: nothing activates at startup or at Eventually for a plugin that only declares commands and views', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks'], onLoad: (id) => loads.push(id) });
    await app.toEventually();
    expect(loads).toEqual([]);
  });
});

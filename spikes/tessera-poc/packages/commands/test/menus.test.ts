import { describe, expect, it } from 'vitest';
import { MenuId, type MenuGroup } from '@tessera/contracts';
import { effect } from '@tessera/reactive';
import { declare, kit, type Kit } from './kit.ts';

const titles = (groups: readonly MenuGroup[]): string[][] => groups.map((g) => g.items.map((i) => i.presentation.title));

function setupTasks(k: Kit): void {
  declare(k, 'tasks.add', { title: 'Add Task', owner: 'sample.tasks' });
  declare(k, 'tasks.complete', { title: 'Complete Task', owner: 'sample.tasks', enablement: 'tasks.hasSelection' });
  declare(k, 'tasks.clearCompleted', { title: 'Clear Completed', owner: 'sample.tasks' });
  for (const id of ['tasks.add', 'tasks.complete', 'tasks.clearCompleted']) k.registry.registerHandler(id, { run: () => id }, 'sample.tasks');
}

describe('C12: menus show items by when and grey them by enablement', () => {
  it('C12: `when` is visibility: items appear and disappear with the context keys', () => {
    const k = kit();
    setupTasks(k);
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.add', when: 'view == tasks.list', group: 'navigation' });
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.clearCompleted', when: 'view == audit.log', group: 'navigation', order: 2 });
    const placement = k.win.createChild('placement:p1');
    const menu = k.menus.createMenu(MenuId.ViewTitle, placement);
    expect(titles(menu.groups.peek())).toEqual([]);
    placement.set('view', 'tasks.list');
    expect(titles(menu.groups.peek())).toEqual([['Add Task']]);
    placement.set('view', 'audit.log');
    expect(titles(menu.groups.peek())).toEqual([['Clear Completed']]);
    menu.dispose();
  });

  it('C12: enablement greys an item (status disabled) and the item stays visible; enabling updates it', () => {
    const k = kit();
    setupTasks(k);
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.complete' });
    const placement = k.win.createChild('placement:p1');
    const menu = k.menus.createMenu(MenuId.ViewTitle, placement);
    const statuses: string[] = [];
    const fx = effect(() => void statuses.push(menu.groups.get()[0]?.items[0]?.presentation.status ?? 'hidden'));
    placement.set('tasks.hasSelection', true);
    placement.set('tasks.hasSelection', false);
    expect(statuses).toEqual(['disabled', 'enabled', 'disabled']);
    fx.dispose();
    menu.dispose();
  });

  it('C12: unavailable commands (no handler) are hidden in toolbars and context menus', () => {
    const k = kit();
    declare(k, 'a.nohandler', { title: 'No Handler' });
    declare(k, 'a.handler', { title: 'Has Handler' });
    k.registry.registerHandler('a.handler', { run: () => 1 });
    for (const menu of [MenuId.ViewTitle, MenuId.ViewContext]) {
      k.menuRegistry.addItem({ menu, command: 'a.nohandler' });
      k.menuRegistry.addItem({ menu, command: 'a.handler' });
    }
    for (const id of [MenuId.ViewTitle, MenuId.ViewContext]) {
      expect(titles(k.menus.createMenu(id, k.win).groups.peek())).toEqual([['Has Handler']]);
    }
  });

  it('C12: items update when a handler appears or goes away', () => {
    const k = kit();
    declare(k, 'a.late', { title: 'Late' });
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'a.late' });
    const menu = k.menus.createMenu(MenuId.ViewTitle, k.win);
    expect(titles(menu.groups.peek())).toEqual([]);
    const handle = k.registry.registerHandler('a.late', { run: () => 1 });
    expect(titles(menu.groups.peek())).toEqual([['Late']]);
    handle.dispose();
    expect(titles(menu.groups.peek())).toEqual([]);
  });

  it('C12: groups: navigation first, then by name; inside a group by order, then title', () => {
    const k = kit();
    for (const [id, title] of [['c1', 'Charlie'], ['c2', 'Alpha'], ['c3', 'Bravo'], ['c4', 'Zulu'], ['c5', 'Yankee']] as const) {
      declare(k, id, { title });
      k.registry.registerHandler(id, { run: () => 1 });
    }
    k.menuRegistry.addItem({ menu: MenuId.ViewContext, command: 'c1', group: '9_other' });
    k.menuRegistry.addItem({ menu: MenuId.ViewContext, command: 'c2', group: '1_modification', order: 5 });
    k.menuRegistry.addItem({ menu: MenuId.ViewContext, command: 'c3', group: '1_modification', order: 5 });
    k.menuRegistry.addItem({ menu: MenuId.ViewContext, command: 'c4', group: 'navigation' });
    k.menuRegistry.addItem({ menu: MenuId.ViewContext, command: 'c5', group: '1_modification', order: 1 });
    const menu = k.menus.createMenu(MenuId.ViewContext, k.win);
    expect(menu.groups.peek().map((g) => g.id)).toEqual(['navigation', '1_modification', '9_other']);
    expect(titles(menu.groups.peek())).toEqual([['Zulu'], ['Yankee', 'Alpha', 'Bravo'], ['Charlie']]);
  });

  it('C12: an item title override and args come from the menu rule; the keybinding label comes from the command', () => {
    const k = kit();
    setupTasks(k);
    k.keybindings.register({ key: 'ctrl+shift+a', command: 'tasks.add', source: 'plugin' });
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.add', title: 'New', args: { title: 'from menu' } });
    const item = k.menus.createMenu(MenuId.ViewTitle, k.win).groups.peek()[0]?.items[0];
    expect(item?.presentation.title).toBe('New');
    expect(item?.presentation.keybinding).toBe('Ctrl+Shift+A');
    expect(item?.args).toEqual({ title: 'from menu' });
    expect(item?.command).toBe('tasks.add');
  });

  it('C12: a submenu item is shown when its when holds and is not a command', () => {
    const k = kit();
    k.menuRegistry.addItem({ menu: MenuId.MenuBar, command: '', submenu: 'menuBar/tasks', title: 'Tasks', when: 'windowFocused' });
    const menu = k.menus.createMenu(MenuId.MenuBar, k.win);
    expect(menu.groups.peek()).toEqual([]);
    k.win.set('windowFocused', true);
    const item = menu.groups.peek()[0]?.items[0];
    expect(item).toMatchObject({ command: undefined, submenu: 'menuBar/tasks' });
    expect(item?.presentation.title).toBe('Tasks');
  });

  it('C12: Menu.run executes the command with the menu context and source menu, and passes the rule args', async () => {
    const k = kit();
    declare(k, 'tasks.add', { title: 'Add' });
    const calls: Array<{ args: unknown; source: string; placement: string | number | boolean | null | undefined | readonly string[] }> = [];
    k.registry.registerHandler('tasks.add', {
      run: (args: unknown, ctx) => {
        calls.push({ args, source: ctx.source, placement: ctx.context.getValue('view') });
        return 'ran';
      },
    });
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.add', args: { title: 'X' } });
    const placement = k.win.createChild('placement:p1');
    placement.set('view', 'tasks.list');
    const menu = k.menus.createMenu(MenuId.ViewTitle, placement);
    await expect(menu.run(menu.groups.peek()[0]!.items[0]!)).resolves.toBe('ran');
    expect(calls).toEqual([{ args: { title: 'X' }, source: 'menu', placement: 'tasks.list' }]);
  });

  it('C12: running a greyed item is refused by the command (command.disabled)', async () => {
    const k = kit();
    setupTasks(k);
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.complete' });
    const placement = k.win.createChild('placement:p1');
    const menu = k.menus.createMenu(MenuId.ViewTitle, placement);
    await expect(menu.run(menu.groups.peek()[0]!.items[0]!)).rejects.toMatchObject({ code: 'command.disabled' });
  });

  it('C12: removing a menu item rule removes the item', () => {
    const k = kit();
    setupTasks(k);
    const handle = k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'tasks.add' });
    const menu = k.menus.createMenu(MenuId.ViewTitle, k.win);
    expect(menu.groups.peek()).toHaveLength(1);
    handle.dispose();
    expect(menu.groups.peek()).toHaveLength(0);
  });

  it('C12: presentation overrides of the active handler (title, toggled) show in the menu', () => {
    const k = kit();
    declare(k, 'view.toggle', { title: 'Toggle' });
    k.registry.registerHandler('view.toggle', { presentation: (c) => ({ title: c.getValue('on') ? 'Hide' : 'Show', toggled: c.getValue('on') === true }), run: () => 1 });
    k.menuRegistry.addItem({ menu: MenuId.ViewTitle, command: 'view.toggle' });
    const menu = k.menus.createMenu(MenuId.ViewTitle, k.win);
    expect(menu.groups.peek()[0]?.items[0]?.presentation).toMatchObject({ title: 'Show', toggled: false });
    k.win.set('on', true);
    expect(menu.groups.peek()[0]?.items[0]?.presentation).toMatchObject({ title: 'Hide', toggled: true });
  });
});

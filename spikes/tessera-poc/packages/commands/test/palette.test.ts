import { describe, expect, it } from 'vitest';
import { MenuId, PluginManager, type PluginManager as PluginManagerType } from '@tessera/contracts';
import { state } from '@tessera/reactive';
import { captureErrors } from '@tessera/testing';
import { declare, kit } from './kit.ts';

const titles = (k: ReturnType<typeof kit>, context = k.win): string[] =>
  k.menus
    .createMenu(MenuId.CommandPalette, context)
    .groups.peek()
    .flatMap((g) => g.items.map((i) => i.presentation.title));

describe('C12: the command palette lists declared commands and hides the ones you cannot run', () => {
  it('C12: lists every declared command with palette !== false, and hides disabled and unavailable ones', () => {
    const k = kit();
    declare(k, 'tasks.add', { title: 'Add Task' });
    declare(k, 'tasks.complete', { title: 'Complete Task', enablement: 'tasks.hasSelection' });
    declare(k, 'tasks.nohandler', { title: 'No Handler' });
    declare(k, 'tasks.hidden', { title: 'Hidden', palette: false });
    for (const id of ['tasks.add', 'tasks.complete', 'tasks.hidden']) k.registry.registerHandler(id, { run: () => 1 });
    expect(titles(k)).toEqual(['Add Task']);
    k.win.set('tasks.hasSelection', true);
    expect(titles(k).toSorted()).toEqual(['Add Task', 'Complete Task']);
  });

  it('C12: a command of a plugin that has not run yet is listed (its contribution is declarative) when enablement holds', () => {
    const k = kit({ activation: { isActive: () => false, activateByEvent: async () => {} } });
    declare(k, 'tasks.add', { title: 'Add Task', owner: 'sample.tasks' });
    declare(k, 'tasks.complete', { title: 'Complete Task', owner: 'sample.tasks', enablement: 'tasks.hasSelection' });
    expect(titles(k)).toEqual(['Add Task']);
    k.win.set('tasks.hasSelection', true);
    expect(titles(k).toSorted()).toEqual(['Add Task', 'Complete Task']);
  });

  it('C12: a core command without handler is not listed even with an activation service', () => {
    const k = kit({ activation: { isActive: () => false, activateByEvent: async () => {} } });
    declare(k, 'core.thing', { title: 'Core Thing', owner: 'core' });
    expect(titles(k)).toEqual([]);
  });

  it('C12: palette menu items with a `when` restrict where the command appears', () => {
    const k = kit();
    declare(k, 'tasks.add', { title: 'Add Task' });
    k.registry.registerHandler('tasks.add', { run: () => 1 });
    k.menuRegistry.addItem({ menu: MenuId.CommandPalette, command: 'tasks.add', when: 'view == tasks.list' });
    const other = k.win.createChild('placement:other');
    const list = k.win.createChild('placement:list');
    list.set('view', 'tasks.list');
    expect(titles(k, other)).toEqual([]);
    expect(titles(k, list)).toEqual(['Add Task']);
  });

  it('C12: evaluated against the context-key scope given: the focused placement', () => {
    const k = kit();
    declare(k, 'tasks.complete', { title: 'Complete Task', enablement: 'tasks.hasSelection' });
    k.registry.registerHandler('tasks.complete', { run: () => 1 });
    const placement = k.win.createChild('placement:p1');
    const menu = k.menus.createMenu(MenuId.CommandPalette, placement);
    expect(menu.groups.peek()).toEqual([]);
    placement.set('tasks.hasSelection', true);
    expect(menu.groups.peek()[0]?.items[0]?.command).toBe('tasks.complete');
  });

  it('C12: running a palette item uses source palette', async () => {
    const k = kit();
    declare(k, 'tasks.add', { title: 'Add Task' });
    const sources: string[] = [];
    k.registry.registerHandler('tasks.add', { run: (_a, ctx) => sources.push(ctx.source) });
    const menu = k.menus.createMenu(MenuId.CommandPalette, k.win);
    await menu.run(menu.groups.peek()[0]!.items[0]!);
    expect(sources).toEqual(['palette']);
  });

  it('C12: a palette rule can rename the command and group it; commands are grouped by category by default', () => {
    const k = kit();
    declare(k, 'a', { title: 'Alpha', category: 'Tasks' });
    declare(k, 'b', { title: 'Bravo' });
    k.registry.registerHandler('a', { run: () => 1 });
    k.registry.registerHandler('b', { run: () => 1 });
    const menu = k.menus.createMenu(MenuId.CommandPalette, k.win);
    expect(menu.groups.peek().map((g) => g.id).toSorted()).toEqual(['Tasks', 'default']);
    k.menuRegistry.addItem({ menu: MenuId.CommandPalette, command: 'b', title: 'Renamed', group: 'navigation' });
    expect(menu.groups.peek()[0]).toMatchObject({ id: 'navigation' });
    expect(menu.groups.peek()[0]?.items[0]?.presentation.title).toBe('Renamed');
  });

  it('C12: the palette updates when commands are declared or undeclared', () => {
    const k = kit();
    const menu = k.menus.createMenu(MenuId.CommandPalette, k.win);
    expect(menu.groups.peek()).toEqual([]);
    const declared = k.registry.declare({ id: 'late', title: 'Late', owner: 'core' });
    const handler = k.registry.registerHandler('late', { run: () => 1 });
    expect(menu.groups.peek()[0]?.items[0]?.presentation.title).toBe('Late');
    declared.dispose();
    handler.dispose();
    expect(menu.groups.peek()).toEqual([]);
  });
});

describe('C12: plugin hooks that throw do not break the palette (throwing-handler-hook-breaks-palette)', () => {
  it('C12: one throwing isEnabled leaves the other commands in the palette and is reported once with the plugin id', () => {
    const k = kit();
    const errors = captureErrors();
    declare(k, 'good.one', { title: 'Good One' });
    declare(k, 'bad.one', { title: 'Bad One', owner: 'acme.bad' });
    declare(k, 'good.two', { title: 'Good Two' });
    for (const id of ['good.one', 'good.two']) k.registry.registerHandler(id, { run: () => 1 });
    k.registry.registerHandler('bad.one', {
      isEnabled: () => {
        throw new Error('isEnabled broke');
      },
      run: () => 1,
    }, 'acme.bad');
    expect(titles(k).toSorted()).toEqual(['Good One', 'Good Two']);
    k.win.set('anything', 1); // a second evaluation
    expect(titles(k).toSorted()).toEqual(['Good One', 'Good Two']);
    const reported = errors.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'command', target: 'bad.one', pluginId: 'acme.bad' });
    errors.dispose();
  });

  it('C12: a throwing presentation() falls back to the base presentation', () => {
    const k = kit();
    const errors = captureErrors();
    declare(k, 'bad.title', { title: 'Base Title', owner: 'acme.bad' });
    k.registry.registerHandler('bad.title', {
      presentation: () => {
        throw new Error('presentation broke');
      },
      run: () => 1,
    }, 'acme.bad');
    expect(titles(k)).toEqual(['Base Title']);
    expect(errors.drain()).toHaveLength(1);
    errors.dispose();
  });

  it('C12: a handler `when` that cannot be parsed does not match, and the command is unavailable', () => {
    const k = kit();
    const errors = captureErrors();
    declare(k, 'bad.when', { title: 'Bad When', owner: 'acme.bad' });
    k.registry.registerHandler('bad.when', { when: '((', run: () => 1 }, 'acme.bad');
    expect(k.commands.status('bad.when', k.win)).toBe('unavailable');
    expect(titles(k)).toEqual([]);
    expect(errors.drain().length).toBeGreaterThanOrEqual(1);
    errors.dispose();
  });

  it('C12: a throwing isEnabled makes execute() reject with command.disabled instead of an unhandled throw', async () => {
    const k = kit();
    const errors = captureErrors();
    declare(k, 'bad.run', { owner: 'acme.bad' });
    k.registry.registerHandler('bad.run', {
      isEnabled: () => {
        throw new Error('isEnabled broke');
      },
      run: () => 1,
    }, 'acme.bad');
    await expect(k.commands.execute('bad.run')).rejects.toMatchObject({ code: 'command.disabled' });
    errors.drain();
    errors.dispose();
  });

  it('C12: a menu rule that throws is dropped and the other rows stay (menu rows are guarded)', () => {
    const k = kit();
    const errors = captureErrors();
    declare(k, 'a.ok', { title: 'Ok' });
    k.registry.registerHandler('a.ok', { run: () => 1 });
    k.menuRegistry.addItem({ menu: 'view/title', command: 'a.ok' });
    k.menuRegistry.addItem({ menu: 'view/title', command: 'a.ok', when: '((', owner: 'acme.bad' });
    const groups = k.menus.createMenu('view/title', k.win).groups.peek();
    expect(groups.flatMap((g) => g.items.map((i) => i.presentation.title))).toEqual(['Ok']);
    expect(errors.drain().some((e) => e.context.pluginId === 'acme.bad')).toBe(true);
    errors.dispose();
  });
});

describe('C12: a command of a Failed plugin is unavailable (gap-tables-orphaned, commands)', () => {
  it('C12: a declared command whose owner plugin is Failed has status unavailable and is not in the palette', () => {
    const k = kit({ activation: { isActive: () => false, activateByEvent: async () => {} } });
    const plugins = state<ReadonlyMap<string, { state: string }>>(new Map([['sample.tasks', { state: 'resolved' }]]));
    k.t.window.provideValue(PluginManager, { plugins: plugins.asReadonly() } as unknown as PluginManagerType);
    declare(k, 'tasks.add', { title: 'Add Task', owner: 'sample.tasks' });
    expect(k.commands.status('tasks.add', k.win)).toBe('enabled');
    expect(titles(k)).toEqual(['Add Task']);
    const palette = k.menus.createMenu(MenuId.CommandPalette, k.win);
    plugins.set(new Map([['sample.tasks', { state: 'failed' }]]));
    expect(k.commands.status('tasks.add', k.win)).toBe('unavailable');
    expect(palette.groups.peek().flatMap((g) => g.items)).toEqual([]);
  });
});

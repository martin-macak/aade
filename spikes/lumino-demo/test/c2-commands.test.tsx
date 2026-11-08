import { Menu } from '@lumino/widgets';
import { MessageLoop } from '@lumino/messaging';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ITasks } from '../src/plugins/task-store.ts';
import { boot, settle, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
});

const labels = (menu: Menu): string[] => menu.items.map((i) => i.label);

describe('C2 command in menu and palette, enabled through context state', () => {
  it('C2: a plugin command is in the menu and in the palette before the plugin ran', async () => {
    h = await boot();
    const { win } = h;
    expect(win.app.isPluginActivated('sample.tasks')).toBe(false);
    expect(labels(win.menuBar.menus[0]!)).toEqual(['Add Task', 'Complete Task']);
    expect(win.menuBar.menus[0]!.title.label).toBe('Tasks');
    expect(win.palette.items.map((i) => `${i.category}/${i.label}`)).toEqual(['Tasks/Add Task', 'Tasks/Complete Task']);
  });

  it('C2: enablement follows context state; the menu and the palette are told to re-evaluate', async () => {
    h = await boot();
    const { win } = h;
    await win.app.commands.execute('tasks.add', { title: 'one' });
    const { store } = win.windowScope.get(ITasks);
    const changes: string[] = [];
    win.app.commands.commandChanged.connect((_, args) => void changes.push(`${args.type}:${args.id}`));
    expect(win.app.commands.isEnabled('tasks.complete')).toBe(false);
    expect(win.keys.get('tasks.hasSelection')).toBe(false);
    store.select(1);
    expect(win.keys.get('tasks.hasSelection')).toBe(true);
    expect(win.app.commands.isEnabled('tasks.complete')).toBe(true);
    expect(changes).toContain('changed:tasks.complete');
    expect(changes).not.toContain('changed:tasks.add'); // an unconditional command is not re-evaluated
    store.select(null);
    expect(win.app.commands.isEnabled('tasks.complete')).toBe(false);
  });

  it('C2: the rendered menu item and palette item carry the disabled state (Menu re-reads isEnabled on open, the palette on commandChanged)', async () => {
    h = await boot();
    const { win } = h;
    await win.app.commands.execute('tasks.add', { title: 'one' });
    const { store } = win.windowScope.get(ITasks);
    const menu = win.menuBar.menus[0]!;
    const rendered = (): boolean[] => [...menu.node.querySelectorAll('.lm-Menu-item')].map((n) => n.classList.contains('lm-mod-disabled'));
    await act(async () => {
      menu.open(0, 0);
      MessageLoop.flush();
    });
    expect(rendered()).toEqual([false, true]);
    // GAP: Menu does not listen to commandChanged. An open menu keeps what it rendered until it is opened again.
    store.select(1);
    await act(async () => MessageLoop.flush());
    expect(rendered()).toEqual([false, true]);
    menu.close();
    await act(async () => {
      menu.open(0, 0);
      MessageLoop.flush();
    });
    expect(rendered()).toEqual([false, false]);
    menu.close();
    // The palette DOES re-render on commandChanged.
    const paletteDisabled = (): boolean[] => [...win.palette.node.querySelectorAll('.lm-CommandPalette-item')].map((n) => n.classList.contains('lm-mod-disabled'));
    await settle();
    expect(paletteDisabled()).toEqual([false, false]);
    store.select(null);
    await settle();
    expect(paletteDisabled()).toEqual([false, true]);
  });

  it('C2: running a menu item executes the command through the registry', async () => {
    h = await boot();
    const { win } = h;
    const menu = win.menuBar.menus[0]!;
    await act(async () => {
      menu.open(0, 0); // triggerActiveItem is a no-op unless the menu is attached
      MessageLoop.flush();
    });
    menu.activeIndex = 0; // Add Task
    menu.triggerActiveItem();
    await settle();
    expect(win.windowScope.get(ITasks).store.tasks).toHaveLength(1); // lazily activated by the menu click
  });

  it('C2: a key binding runs the command (document keydown handled by Application)', async () => {
    h = await boot();
    const { win } = h;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 84, key: 't', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(win.windowScope.get(ITasks).store.tasks).toHaveLength(1);
  });

  it('C2: deactivating the plugin leaves its declaration, but a contribution that is disposed leaves no trace', async () => {
    h = await boot();
    const { win } = h;
    const keyed = win.windowScope.get((await import('../src/tokens.ts')).IContributions).declare({ id: 'temp.cmd', label: 'Temp', execute: () => 1, menu: 'Temp', palette: 'Temp', enabledWhen: (k) => k.get('x') === true, keys: ['Ctrl Shift Y'] });
    expect(win.app.commands.hasCommand('temp.cmd')).toBe(true);
    expect(win.app.commands.keyBindings.some((b) => b.command === 'temp.cmd')).toBe(true);
    keyed.dispose();
    expect(win.app.commands.hasCommand('temp.cmd')).toBe(false);
    expect(win.app.commands.keyBindings.some((b) => b.command === 'temp.cmd')).toBe(false);
    expect(win.palette.items.some((i) => i.command === 'temp.cmd')).toBe(false);
    expect(win.menuBar.menus.find((m) => m.title.label === 'Temp')!.items).toHaveLength(0);
  });
});

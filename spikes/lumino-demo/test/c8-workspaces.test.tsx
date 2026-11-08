import { Widget } from '@lumino/widgets';
import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, settle, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
});

describe('C8 workspaces', () => {
  it('C8: views are shown in named containers; the registry knows where each one is', async () => {
    h = await boot();
    const { win } = h;
    expect(win.workspaces.names()).toEqual(['side', 'editor']);
    const a = await win.open('tasks.list', 'side');
    const b = await win.open('tasks.list', 'editor');
    expect(win.workspaces.get('side').widgets()).toEqual([a.widget]);
    expect(win.workspaces.get('editor').widgets()).toEqual([b.widget]);
    expect(win.workspaces.whereIs(new Widget())).toBeUndefined();
  });

  it('C8: moving a placement to another workspace keeps its widget, its React state and its local state', async () => {
    h = await boot();
    const { win } = h;
    const p = await win.open('tasks.list', 'side');
    await settle();
    p.local.patch({ query: 'kept' });
    await settle();
    win.workspaces.show(p.widget, 'editor'); // Lumino re-parents the same widget
    await settle();
    expect(win.workspaces.whereIs(p.widget)).toBe('editor');
    expect(win.workspaces.get('side').widgets()).toEqual([]);
    expect((within(p.widget.node).getByLabelText('Filter') as HTMLInputElement).value).toBe('kept');
  });

  it('C8: an unknown or a duplicate workspace name is an error', async () => {
    h = await boot();
    const { win } = h;
    expect(() => win.workspaces.get('nope')).toThrow(/Unknown workspace/);
    expect(() => win.workspaces.register({ name: 'side', container: new Widget(), add() {}, widgets: () => [], activate() {} })).toThrow(/already exists/);
  });

  it('C8: a workspace registration can be removed again (a plugin can contribute one)', async () => {
    h = await boot();
    const { win } = h;
    const sub = win.workspaces.register({ name: 'extra', container: new Widget(), add() {}, widgets: () => [], activate() {} });
    expect(win.workspaces.names()).toContain('extra');
    sub.dispose();
    expect(win.workspaces.names()).not.toContain('extra');
  });

  it('C8: CHARACTERIZATION (Lumino 2.10.0): DockPanel.dispose() leaves its widgets undisposed, TabPanel.dispose() disposes them', async () => {
    h = await boot();
    const { win } = h;
    const inSide = await win.open('tasks.list', 'side');
    const inDock = await win.open('tasks.list', 'editor');
    await settle();
    win.dock.dispose();
    win.side.dispose();
    expect(inSide.widget.isDisposed).toBe(true);
    expect(inDock.widget.isDisposed).toBe(false); // so the owner of the widgets (our ViewHost) has to close them
    inDock.widget.dispose();
  });
});

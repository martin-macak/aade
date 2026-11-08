import { fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ITasks } from '../src/plugins/task-store.ts';
import { type TaskListLocal } from '../src/plugins/tasks.ts';
import { boot, settle, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
});

async function twoPlacements() {
  h = await boot();
  const { win } = h;
  const side = await win.open('tasks.list', 'side');
  const dock = await win.open('tasks.list', 'editor');
  await settle();
  return { win, side, dock, store: win.windowScope.get(ITasks).store };
}

describe('C1 one view type in two places', () => {
  it('C1: the same view type is shown in a side panel and a dock tab as two widgets, in two workspaces', async () => {
    const { win, side, dock } = await twoPlacements();
    expect(side.widget).not.toBe(dock.widget);
    expect(win.workspaces.whereIs(side.widget)).toBe('side');
    expect(win.workspaces.whereIs(dock.widget)).toBe('editor');
    expect(side.type).toBe(dock.type);
    expect(side.id).not.toBe(dock.id);
    expect(side.scope).not.toBe(dock.scope);
    expect(win.dock.node.contains(dock.widget.node)).toBe(true);
    expect(win.side.node.contains(side.widget.node)).toBe(true);
    expect(within(side.widget.node).getByLabelText('Filter')).toBeTruthy(); // React rendered inside the Lumino widget
    expect(within(dock.widget.node).getByLabelText('Filter')).toBeTruthy();
  });

  it('C1: both placements render one shared state', async () => {
    const { win, side, dock, store } = await twoPlacements();
    await win.app.commands.execute('tasks.add', { title: 'buy milk' });
    await win.app.commands.execute('tasks.add', { title: 'write report' });
    await settle();
    for (const p of [side, dock]) expect(within(p.widget.node).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['buy milk tasks', 'write report tasks']);
    // a selection made in one view is highlighted in the other
    fireEvent.click(within(side.widget.node).getByText('write report'));
    await settle();
    expect(store.selectedId).toBe(2);
    expect(within(dock.widget.node).getByText('write report').closest('li')!.className).toContain('selected');
  });

  it('C1: local state is separated per placement (filter text, pinned)', async () => {
    const { side, dock, win } = await twoPlacements();
    await win.app.commands.execute('tasks.add', { title: 'buy milk' });
    await win.app.commands.execute('tasks.add', { title: 'write report' });
    await settle();
    fireEvent.change(within(dock.widget.node).getByLabelText('Filter'), { target: { value: 'milk' } });
    await settle();
    expect((dock.local.value as TaskListLocal).query).toBe('milk');
    expect((side.local.value as TaskListLocal).query).toBe('');
    expect(within(dock.widget.node).getAllByRole('listitem')).toHaveLength(1);
    expect(within(side.widget.node).getAllByRole('listitem')).toHaveLength(2);
    // The Radix checkbox changes only its own placement, and reaches the Lumino tab (closable flag)
    fireEvent.click(within(side.widget.node).getByRole('checkbox', { name: 'Pinned' }));
    await settle();
    expect((side.local.value as TaskListLocal).pinned).toBe(true);
    expect(side.widget.title.closable).toBe(false);
    expect((dock.local.value as TaskListLocal).pinned).toBe(false);
    expect(dock.widget.title.closable).toBe(true);
  });

  it('C1: closing one placement disposes its widget, scope and React tree, and leaves the other and the shared store alone', async () => {
    const { win, side, dock, store } = await twoPlacements();
    await win.app.commands.execute('tasks.add', { title: 'keep' });
    await settle();
    dock.widget.close(); // the tab close button does this
    await settle();
    expect(dock.widget.isDisposed).toBe(true);
    expect(dock.scope.isDisposed).toBe(true);
    expect(win.views.all().map((p) => p.id)).toEqual([side.id]);
    expect(store.tasks).toHaveLength(1);
    await win.app.commands.execute('tasks.add', { title: 'second' });
    await settle();
    expect(within(side.widget.node).getAllByRole('listitem')).toHaveLength(2);
  });

  it('C1: the view component is loaded lazily, once, on the first placement', async () => {
    h = await boot();
    expect(h.win.app.isPluginActivated('sample.tasks')).toBe(false);
    await h.win.open('tasks.list', 'side'); // creating the placement activates the owning plugin
    expect(h.win.app.isPluginActivated('sample.tasks')).toBe(true);
  });
});

import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type LayoutDoc } from '../src/cap5-persistence.ts';
import { boot, MemoryStorage, settle, type Harness } from './kit.tsx';

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.stop();
});
const track = async (storage?: MemoryStorage): Promise<Harness> => {
  const h = await boot(storage ? { storage } : {});
  open.push(h);
  return h;
};
const filterValue = (node: HTMLElement): string => (within(node).getByLabelText('Filter') as HTMLInputElement).value;

describe('C5 persistence of layout and view state', () => {
  it('C5: the native layout is not serializable: saveLayout() holds live Widget instances', async () => {
    const { win } = await track();
    const p = await win.open('tasks.list', 'editor');
    const main = win.dock.saveLayout().main!;
    expect(main.type).toBe('tab-area');
    expect(main.type === 'tab-area' && main.widgets[0]).toBe(p.widget); // an instance, so JSON.stringify of it is not a layout
    expect(win.layout.snapshot().dock).toEqual({ type: 'tab-area', ids: [p.id], currentIndex: 0 }); // our JSON form
  });

  it('C5: save then restore in a new window brings back placements, workspaces, tab order and per-placement state', async () => {
    const first = await track();
    const side = await first.win.open('tasks.list', 'side');
    const dock = await first.win.open('tasks.list', 'editor');
    const second = await first.win.open('audit.log', 'editor');
    side.local.patch({ query: 'milk' });
    dock.local.patch({ pinned: true, query: 'report' });
    first.win.dock.activateWidget(dock.widget);
    first.win.layout.save();
    const saved = JSON.parse(first.storage.getItem('layout')!) as LayoutDoc;
    expect(saved.format).toBe(1);
    expect(saved.placements.map((p) => [p.id, p.workspace, p.stateVersion])).toEqual([[side.id, 'side', 2], [dock.id, 'editor', 2], [second.id, 'editor', 1]]);

    const next = await track(first.storage);
    expect(await next.win.layout.load()).toEqual({ skipped: [] });
    await settle();
    const restored = Object.fromEntries(next.win.views.all().map((p) => [p.id, p]));
    expect(Object.keys(restored)).toEqual([side.id, dock.id, second.id]); // same ids
    expect(next.win.workspaces.whereIs(restored[side.id]!.widget)).toBe('side');
    expect(next.win.workspaces.whereIs(restored[dock.id]!.widget)).toBe('editor');
    expect(restored[side.id]!.local.value).toEqual({ query: 'milk', pinned: false });
    expect(restored[dock.id]!.local.value).toEqual({ query: 'report', pinned: true });
    expect(filterValue(restored[side.id]!.widget.node)).toBe('milk'); // and the React tree shows it
    expect(restored[dock.id]!.widget.title.closable).toBe(false);
    expect(next.win.layout.snapshot().dock).toEqual(first.win.layout.snapshot().dock);
  });

  it('C5: a split layout (tab areas side by side) round-trips with its orientation and sizes', async () => {
    const first = await track();
    const a = await first.win.open('tasks.list', 'editor');
    const b = await first.win.open('tasks.list', 'editor');
    const c = await first.win.open('audit.log', 'editor');
    first.win.dock.addWidget(b.widget, { mode: 'split-right', ref: a.widget });
    first.win.dock.addWidget(c.widget, { mode: 'split-bottom', ref: b.widget });
    const before = first.win.layout.snapshot().dock!;
    expect(before.type).toBe('split-area');
    first.win.layout.save();
    const next = await track(first.storage);
    await next.win.layout.load();
    expect(next.win.layout.snapshot().dock).toEqual(before);
  });

  it('C5: MIGRATION v1 to v2: state saved by an older view schema is migrated on restore and saved back as v2', async () => {
    const storage = new MemoryStorage();
    const v1: LayoutDoc = {
      format: 1,
      dock: { type: 'tab-area', ids: ['tasks.list#dock'], currentIndex: 0 },
      side: { ids: ['tasks.list#side'], current: 0 },
      placements: [
        { id: 'tasks.list#side', type: 'tasks.list', workspace: 'side', stateVersion: 1, local: { filter: 'milk' } },
        { id: 'tasks.list#dock', type: 'tasks.list', workspace: 'editor', stateVersion: 1, local: { filter: 'report' } },
      ],
    };
    storage.setItem('layout', JSON.stringify(v1));
    const { win } = await track(storage);
    await win.layout.load();
    await settle();
    const [side, dock] = win.views.all();
    expect(side!.local.value).toEqual({ query: 'milk', pinned: false }); // `filter` became `query`, `pinned` got its default
    expect(dock!.local.value).toEqual({ query: 'report', pinned: false });
    expect(filterValue(dock!.widget.node)).toBe('report');
    win.layout.save();
    const resaved = JSON.parse(storage.getItem('layout')!) as LayoutDoc;
    expect(resaved.placements.map((p) => [p.stateVersion, p.local])).toEqual([[2, { query: 'milk', pinned: false }], [2, { query: 'report', pinned: false }]]);
  });

  it('C5: an unknown view type is skipped, the rest is restored, and an empty area is dropped from the layout', async () => {
    const storage = new MemoryStorage();
    storage.setItem('layout', JSON.stringify({
      format: 1,
      dock: { type: 'split-area', orientation: 'horizontal', sizes: [1, 1], children: [{ type: 'tab-area', ids: ['gone#1'], currentIndex: 0 }, { type: 'tab-area', ids: ['tasks.list#1'], currentIndex: 0 }] },
      side: { ids: [], current: 0 },
      placements: [
        { id: 'gone#1', type: 'removed.plugin.view', workspace: 'editor', stateVersion: 1, local: {} },
        { id: 'tasks.list#1', type: 'tasks.list', workspace: 'editor', stateVersion: 2, local: { query: 'x', pinned: false } },
      ],
    } satisfies LayoutDoc));
    const { win } = await track(storage);
    expect(await win.layout.load()).toEqual({ skipped: ['gone#1'] });
    expect(win.layout.snapshot().dock).toEqual({ type: 'tab-area', ids: ['tasks.list#1'], currentIndex: 0 });
  });

  it('C5: a document written by a NEWER build is refused instead of being misread', async () => {
    const storage = new MemoryStorage();
    storage.setItem('layout', JSON.stringify({ format: 99, dock: null, side: { ids: [], current: 0 }, placements: [] }));
    const { win } = await track(storage);
    await expect(win.layout.load()).rejects.toThrow(/newer than this build/);
  });

  it('C5: autosave writes once per burst of changes (layout, placement, local state)', async () => {
    const { win, storage } = await track();
    let writes = 0;
    const set = storage.setItem.bind(storage);
    storage.setItem = (k, v) => (writes++, set(k, v));
    const sub = win.layout.autosave();
    const p = await win.open('tasks.list', 'editor');
    p.local.patch({ query: 'a' });
    p.local.patch({ query: 'ab' });
    await Promise.resolve();
    await settle();
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(3);
    const doc = JSON.parse(storage.getItem('layout')!) as LayoutDoc;
    expect(doc.placements[0]!.local).toEqual({ query: 'ab', pinned: false });
    sub.dispose();
    const count = writes;
    p.local.patch({ query: 'abc' });
    await settle();
    expect(writes).toBe(count);
  });
});

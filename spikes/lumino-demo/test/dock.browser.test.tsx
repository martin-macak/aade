// Runs in real Chromium (Vitest Browser Mode + Playwright). It checks what jsdom cannot: real layout of a DockPanel, React views with
// Radix UI inside docked panels, portals, focus, stacking, a real mouse drag of a tab, and a layout restored with real sizes.
// Capability numbers in the titles say which capability each check supports.
import '@lumino/default-theme/style/index.css';
import '../src/demo.css';
import { MessageLoop } from '@lumino/messaging';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindow, type DemoWindow } from '../src/app.ts';
import { type LayoutDoc, type StorageLike } from '../src/cap5-persistence.ts';
import { auditPlugin } from '../src/plugins/audit.ts';
import { tasksPlugin, type TaskListLocal } from '../src/plugins/tasks.ts';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem = (k: string): string | null => this.map.get(k) ?? null;
  setItem = (k: string, v: string): void => void this.map.set(k, v);
}

const wins: DemoWindow[] = [];
let counter = 0;
async function boot(storage: StorageLike = new MemoryStorage()): Promise<DemoWindow> {
  const host = document.createElement('div');
  host.id = 'app'; // the css in demo.css positions #app and #shell
  host.dataset['n'] = String(++counter);
  document.body.append(host);
  const win = createWindow({ storage });
  win.plugins.register(auditPlugin);
  win.plugins.register(tasksPlugin);
  wins.push(win);
  await win.start('app');
  return win;
}
const flush = async (): Promise<void> => {
  MessageLoop.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  MessageLoop.flush();
};
afterEach(() => {
  while (wins.length) wins.pop()!.dispose();
  document.querySelectorAll('#app').forEach((n) => n.remove());
  document.body.removeAttribute('style');
});
beforeEach(() => void (document.body.innerHTML = ''));

const visibleBox = (el: Element): DOMRect => {
  const r = el.getBoundingClientRect();
  expect(r.width, 'width').toBeGreaterThan(20);
  expect(r.height, 'height').toBeGreaterThan(20);
  return r;
};

describe('browser: React 19 + Radix views inside a real Lumino DockPanel', () => {
  it('C1/C8: the same view type renders in a TabPanel and in a DockPanel tab with real, non-zero layout', async () => {
    const win = await boot();
    const side = await win.open('tasks.list', 'side');
    const dock = await win.open('tasks.list', 'editor');
    await vi.waitFor(() => {
      expect(side.widget.node.querySelector('section.tasks')).not.toBeNull();
      expect(dock.widget.node.querySelector('section.tasks')).not.toBeNull();
    });
    await flush();
    const dockRect = visibleBox(win.dock.node);
    const sideRect = visibleBox(win.side.node);
    expect(sideRect.right).toBeLessThanOrEqual(dockRect.left + 1); // the side panel sits left of the dock
    const inDock = visibleBox(dock.widget.node.querySelector('section.tasks')!);
    expect(inDock.left).toBeGreaterThanOrEqual(dockRect.left);
    expect(inDock.right).toBeLessThanOrEqual(dockRect.right + 1);
    // the dock tab bar shows the tab title
    expect(win.dock.node.querySelector('.lm-DockPanel-tabBar .lm-TabBar-tabLabel')?.textContent).toBe('Tasks');
    // one shared store, rendered by both
    await win.app.commands.execute('tasks.add', { title: 'buy milk' });
    await vi.waitFor(() => {
      expect(side.widget.node.querySelectorAll('li')).toHaveLength(1);
      expect(dock.widget.node.querySelectorAll('li')).toHaveLength(1);
    });
  });

  it('C1: real keyboard input in one placement filters only that placement (local state)', async () => {
    const win = await boot();
    const side = await win.open('tasks.list', 'side');
    const dock = await win.open('tasks.list', 'editor');
    await win.app.commands.execute('tasks.add', { title: 'buy milk' });
    await win.app.commands.execute('tasks.add', { title: 'write report' });
    await vi.waitFor(() => expect(dock.widget.node.querySelectorAll('li')).toHaveLength(2));
    const input = dock.widget.node.querySelector('input')!;
    await userEvent.click(input);
    await userEvent.keyboard('milk');
    await vi.waitFor(() => expect(dock.widget.node.querySelectorAll('li')).toHaveLength(1));
    expect(side.widget.node.querySelectorAll('li')).toHaveLength(2);
    expect((dock.local.value as TaskListLocal).query).toBe('milk');
    expect((side.local.value as TaskListLocal).query).toBe('');
  });

  it('Radix Popover (portal) opened inside a docked tab: renders on top, is not clipped, takes focus, closes on Escape and gives focus back', async () => {
    const win = await boot();
    const dock = await win.open('tasks.list', 'editor');
    await vi.waitFor(() => expect(dock.widget.node.querySelector('button.details')).not.toBeNull());
    await flush();
    const trigger = dock.widget.node.querySelector<HTMLButtonElement>('button.details')!;
    await userEvent.click(trigger);
    const popover = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="popover"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // 1. The portal puts the content outside every Lumino widget, directly under body.
    expect(popover.closest('.lm-Widget')).toBeNull();
    expect(popover.parentElement?.parentElement).toBe(document.body); // Radix wrapper div > body
    // 2. It has real geometry inside the viewport and nothing from Lumino covers it (z-index 0 to 3 inside the dock panel).
    const r = visibleBox(popover);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(popover.contains(hit), `elementFromPoint hit ${hit?.className}`).toBe(true);
    // 3. It is placed next to its trigger (Floating UI measured the trigger in the Lumino layout).
    const t = trigger.getBoundingClientRect();
    expect(Math.abs(r.top - t.bottom)).toBeLessThan(40);
    // 4. Focus moved into the popover.
    await vi.waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));
    // 5. Escape closes it (Application's keydown capture handler did not swallow it) and focus returns to the trigger.
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="popover"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    // 6. Lumino's own state was not disturbed: the tab is still current and the widget is attached.
    expect([...win.dock.tabBars()][0]?.currentTitle?.owner === dock.widget).toBe(true);
    expect(dock.widget.isAttached).toBe(true);
  });

  it('Radix Popover opened in the side TabPanel also shows on top of the neighbouring DockPanel', async () => {
    const win = await boot();
    const side = await win.open('tasks.list', 'side');
    await win.open('tasks.list', 'editor');
    await vi.waitFor(() => expect(side.widget.node.querySelector('button.details')).not.toBeNull());
    await flush();
    await userEvent.click(side.widget.node.querySelector('button.details')!);
    const popover = await vi.waitFor(() => document.querySelector<HTMLElement>('[data-testid="popover"]')!);
    expect(popover).not.toBeNull();
    const r = visibleBox(popover);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(popover.contains(hit)).toBe(true);
    expect(popover.textContent).toContain('Workspace side');
    await userEvent.keyboard('{Escape}');
  });

  it('Radix Checkbox in a docked view changes local state, and the Lumino tab reacts (closable class)', async () => {
    const win = await boot();
    const dock = await win.open('tasks.list', 'editor');
    await vi.waitFor(() => expect(dock.widget.node.querySelector('button[role="checkbox"]')).not.toBeNull());
    await flush();
    const tab = (): Element => win.dock.node.querySelector('.lm-TabBar-tab')!;
    expect(tab().classList.contains('lm-mod-closable')).toBe(true);
    await userEvent.click(dock.widget.node.querySelector('button[role="checkbox"]')!);
    await vi.waitFor(() => expect((dock.local.value as TaskListLocal).pinned).toBe(true));
    await vi.waitFor(() => expect(tab().classList.contains('lm-mod-closable')).toBe(false));
  });

  it('C8: a split gives each tab area its own real rectangle, and both render the shared state', async () => {
    const win = await boot();
    const a = await win.open('tasks.list', 'editor');
    const b = await win.open('tasks.list', 'editor');
    win.dock.addWidget(b.widget, { mode: 'split-right', ref: a.widget });
    await flush();
    await vi.waitFor(() => expect(b.widget.node.querySelector('section.tasks')).not.toBeNull());
    const ra = visibleBox(a.widget.node);
    const rb = visibleBox(b.widget.node);
    expect(ra.right).toBeLessThanOrEqual(rb.left + 8); // side by side, not overlapping
    await win.app.commands.execute('tasks.add', { title: 'shared' });
    await vi.waitFor(() => {
      expect(a.widget.node.querySelectorAll('li')).toHaveLength(1);
      expect(b.widget.node.querySelectorAll('li')).toHaveLength(1);
    });
  });

  it('C5: a split layout with changed sizes and view state is restored by a new window with the same real geometry', async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    const a = await first.open('tasks.list', 'editor');
    const b = await first.open('tasks.list', 'editor');
    first.dock.addWidget(b.widget, { mode: 'split-right', ref: a.widget });
    await flush();
    a.local.patch({ query: 'left' });
    b.local.patch({ query: 'right', pinned: true });
    // Move the splitter: ask Lumino for the current sizes, change them, and let it settle.
    const saved = first.dock.saveLayout().main;
    expect(saved?.type).toBe('split-area');
    first.dock.restoreLayout({ main: saved!.type === 'split-area' ? { ...saved!, sizes: [0.25, 0.75] } : saved! });
    await flush();
    const widths = [a, b].map((p) => p.widget.node.getBoundingClientRect().width);
    expect(widths[1]! / widths[0]!).toBeGreaterThan(2); // roughly 1 : 3
    first.layout.save();
    first.dispose();
    wins.length = 0;
    document.body.innerHTML = '';
    const second = await boot(storage);
    wins.length = 0;
    wins.push(second);
    expect(await second.layout.load()).toEqual({ skipped: [] });
    await vi.waitFor(() => expect(second.views.all().every((p) => p.widget.node.querySelector('section.tasks'))).toBe(true));
    await flush();
    const [ra, rb] = second.views.all().map((p) => p.widget.node.getBoundingClientRect().width);
    expect(rb! / ra!).toBeGreaterThan(2); // the sizes came back, not just the tree
    expect(second.views.all().map((p) => p.local.value)).toEqual([{ query: 'left', pinned: false }, { query: 'right', pinned: true }]);
    const doc = JSON.parse(storage.getItem('layout')!) as LayoutDoc;
    expect(doc.dock?.type).toBe('split-area');
  });

  it('C8: a drag of a tab to the right edge of the dock splits it (native Lumino drag and drop; synthetic pointer events in real Chromium)', async () => {
    const win = await boot();
    const a = await win.open('tasks.list', 'editor');
    const b = await win.open('tasks.list', 'editor');
    await flush();
    expect(win.dock.saveLayout().main?.type).toBe('tab-area'); // two tabs in one area
    const tabs = [...win.dock.node.querySelectorAll('.lm-TabBar-tab')];
    expect(tabs).toHaveLength(2);
    const from = tabs[1]!.getBoundingClientRect();
    const to = win.dock.node.getBoundingClientRect();
    // Lumino 2 listens to pointer events, not mouse events. Playwright's userEvent.dragAndDrop can only aim at element centres, so
    // the events are dispatched directly (still in a real browser with real layout and hit testing).
    const mouse = async (name: string, x: number, y: number): Promise<void> => {
      const type = name.replace('mouse', 'pointer');
      const target = type === 'pointerdown' ? tabs[1]! : document.elementFromPoint(x, y) ?? document.body;
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse', view: window }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    await mouse('mousedown', startX, startY);
    // drag well beyond the detach threshold, then to the right quarter of the dock content
    for (const [x, y] of [[startX + 5, startY + 40], [startX + 30, startY + 120], [to.right - 40, to.top + to.height / 2], [to.right - 30, to.top + to.height / 2]] as const) {
      await mouse('mousemove', x, y);
    }
    await mouse('mouseup', to.right - 30, to.top + to.height / 2);
    await flush();
    const after = win.dock.saveLayout().main;
    expect(after?.type, 'after the drop').toBe('split-area');
    expect([a, b].map((p) => win.workspaces.whereIs(p.widget))).toEqual(['editor', 'editor']);
  });
});

import { describe, expect, it } from 'vitest';
import { computed, state } from '@tessera/reactive';
import { captureErrors } from '@tessera/testing';
import { kit } from './kit.ts';

const ids = (items: { readonly left: readonly { id: string }[]; readonly right: readonly { id: string }[] }): string[] => [...items.left, ...items.right].map((i) => i.id);

describe('status bar items', () => {
  it('shows items by when, sorted: left by priority (higher further left), right by priority (higher further right)', () => {
    const k = kit();
    k.statusBar.add({ id: 'l-low', alignment: 'left', priority: 1, text: 'L low' });
    k.statusBar.add({ id: 'l-high', alignment: 'left', priority: 10, text: 'L high' });
    k.statusBar.add({ id: 'r-low', alignment: 'right', priority: 1, text: 'R low' });
    k.statusBar.add({ id: 'r-high', alignment: 'right', priority: 10, text: 'R high' });
    k.statusBar.add({ id: 'hidden', alignment: 'left', text: 'Hidden', when: 'showHidden' });
    const items = k.statusBar.items(k.win);
    expect(ids(items.peek())).toEqual(['l-high', 'l-low', 'r-low', 'r-high']);
    k.win.set('showHidden', true);
    expect(ids(items.peek())).toContain('hidden');
  });

  it('text and tooltip can be observables; the item updates when they change', () => {
    const k = kit();
    const count = state('3 open');
    k.statusBar.add({ id: 'tasks.count', alignment: 'left', text: count, tooltip: 'Open tasks', command: 'tasks.show' });
    const items = k.statusBar.items(k.win);
    expect(items.peek().left[0]).toMatchObject({ id: 'tasks.count', alignment: 'left', text: '3 open', tooltip: 'Open tasks', command: 'tasks.show', status: 'disabled' });
    count.set('4 open');
    expect(items.peek().left[0]?.text).toBe('4 open');
  });

  it('disposing the registration removes the item', () => {
    const k = kit();
    const handle = k.statusBar.add({ id: 'x', alignment: 'right', text: 'x' });
    const items = k.statusBar.items(k.win);
    expect(ids(items.peek())).toHaveLength(1);
    handle.dispose();
    expect(ids(items.peek())).toHaveLength(0);
  });
});

describe('round 2: one bad rule cannot blank the status bar', () => {
  it('C17: a rule with an invalid `when` is reported once and skipped; the other items stay, and reading never throws', () => {
    const k = kit();
    const errors = captureErrors();
    k.statusBar.add({ id: 'good', alignment: 'left', text: 'Good' });
    k.statusBar.add({ id: 'bad-when', alignment: 'left', text: 'Bad', when: 'a &&', owner: 'evil.plugin' });
    const items = k.statusBar.items(k.win);
    expect(() => items.get()).not.toThrow();
    expect(() => items.peek()).not.toThrow();
    expect(ids(items.peek())).toEqual(['good']);
    k.win.set('anything', 1); // recompute: still one report
    items.peek();
    const reported = errors.drain();
    errors.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ target: 'bad-when', pluginId: 'evil.plugin' });
  });

  it('C17: a text observable that throws drops its item only, and the item returns when the observable recovers', () => {
    const k = kit();
    const errors = captureErrors();
    const flag = state(true);
    const text = computed(() => {
      if (flag.get()) throw new Error('text failed');
      return 'back';
    });
    k.statusBar.add({ id: 'fragile', alignment: 'right', text });
    k.statusBar.add({ id: 'steady', alignment: 'right', text: 'steady' });
    const items = k.statusBar.items(k.win);
    expect(ids(items.peek())).toEqual(['steady']);
    flag.set(false);
    expect(items.peek().right.map((i) => i.text).toSorted()).toEqual(['back', 'steady']);
    errors.drain();
    errors.dispose();
  });

  it('C17: the service owns enablement and run: a disabled command gives status disabled, run() executes with source statusBar', async () => {
    const k = kit();
    const seen: string[] = [];
    k.registry.declare({ id: 'sb.run', title: 'Run', enablement: 'sbEnabled', owner: 'test' });
    k.registry.registerHandler('sb.run', { run: (_args, c) => void seen.push(c.source) });
    k.statusBar.add({ id: 'runner', alignment: 'left', text: 'Run', command: 'sb.run' });
    const items = k.statusBar.items(k.win);
    expect(items.peek().left[0]?.status).toBe('disabled');
    k.win.set('sbEnabled', true);
    const item = items.peek().left[0];
    expect(item?.status).toBe('enabled');
    await item?.run();
    expect(seen).toEqual(['statusBar']);
  });
});

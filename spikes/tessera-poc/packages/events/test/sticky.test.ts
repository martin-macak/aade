import { describe, expect, it } from 'vitest';
import { defineTopic } from '@tessera/contracts';
import { tree } from './kit.ts';

describe('C7: sticky topics replay the last publication to late subscribers', () => {
  const sticky = defineTopic<string>('sticky.topic', { sticky: true });

  it('C7: a sync subscriber gets the retained value at subscribe time, with meta.replayed true', () => {
    const t = tree();
    t.tasks.publish(sticky, 'first');
    t.tasks.publish(sticky, 'last');
    const seen: Array<[string, boolean]> = [];
    t.win.subscribe(sticky, (p, meta) => seen.push([p, meta.replayed]));
    expect(seen).toEqual([['last', true]]);
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([['last', true]]); // not delivered twice
  });

  it('C7: a microtask subscriber gets the replay in a microtask, never inside subscribe', () => {
    const t = tree();
    t.tasks.publish(sticky, 'last');
    const seen: Array<[string, boolean]> = [];
    t.win.subscribe(sticky, (p, meta) => seen.push([p, meta.replayed]), { delivery: 'microtask' });
    expect(seen).toEqual([]);
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([['last', true]]);
  });

  it('C7: a live publication cannot be overtaken by a replay: the last value delivered is the live one (sticky-replay-after-live)', () => {
    for (const delivery of ['sync', 'microtask'] as const) {
      const t = tree();
      const topic = defineTopic<string>(`sticky.live.${delivery}`, { sticky: true });
      t.tasks.publish(topic, 'old');
      const seen: string[] = [];
      t.win.subscribe(topic, (p) => seen.push(p), { delivery });
      t.tasks.publish(topic, 'live'); // published right after subscribe, before the microtask
      t.t.scheduler.flushMicrotasks();
      expect(seen.at(-1)).toBe('live');
      expect(seen).not.toContain(delivery === 'microtask' ? 'old' : 'never');
    }
  });

  it('C7: replay: false skips the replay, and a non sticky topic never replays', () => {
    const t = tree();
    t.tasks.publish(sticky, 'x');
    const plain = defineTopic<string>('not.sticky');
    t.tasks.publish(plain, 'x');
    const seen: string[] = [];
    t.win.subscribe(sticky, (p) => seen.push(`sticky ${p}`), { replay: false });
    t.win.subscribe(plain, (p) => seen.push(`plain ${p}`));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([]);
  });

  it('C7: the retained publication with the highest seq wins across source nodes', () => {
    const t = tree();
    t.a.publish(sticky, 'from a');
    t.b.publish(sticky, 'from b');
    const seen: string[] = [];
    t.win.subscribe(sticky, (p) => seen.push(p));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual(['from b']);
  });

  it('C7: replay respects publish scope: a workItem-scoped publication is replayed only to its own node', () => {
    const t = tree();
    t.tasks.publish(sticky, 'private to tasks', { scope: 'workItem' });
    const seen: string[] = [];
    t.tasks.subscribe(sticky, (p) => seen.push(`tasks ${p}`));
    t.win.subscribe(sticky, (p) => seen.push(`win ${p}`));
    t.a.subscribe(sticky, (p) => seen.push(`a ${p}`));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual(['tasks private to tasks']);
  });

  it('C7: a descendants-scoped publication is replayed to descendants only; global to everybody', () => {
    const t = tree();
    t.tasks.publish(sticky, 'below tasks', { scope: 'descendants' });
    const seen: string[] = [];
    t.a.subscribe(sticky, (p) => seen.push(`a ${p}`));
    t.other.subscribe(sticky, (p) => seen.push(`other ${p}`));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual(['a below tasks']);
    t.tasks.publish(sticky, 'everywhere');
    seen.length = 0;
    t.other.subscribe(sticky, (p) => seen.push(`other2 ${p}`));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual(['other2 everywhere']);
  });

  it('C7: a newer local publication on a closer scope beats an older one', () => {
    const t = tree();
    t.tasks.publish(sticky, 'older global');
    t.tasks.publish(sticky, 'newer descendants', { scope: 'descendants' });
    const seen: string[] = [];
    t.a.subscribe(sticky, (p) => seen.push(p));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual(['newer descendants']);
  });

  it('C7: idle subscribers get the replay in an idle callback', () => {
    const t = tree();
    t.tasks.publish(sticky, 'x');
    const seen: string[] = [];
    t.win.subscribe(sticky, (p) => seen.push(p), { delivery: 'idle' });
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([]);
    t.t.scheduler.runIdle();
    expect(seen).toEqual(['x']);
  });

  it('C7: disposing a node drops its retained publications', () => {
    const t = tree();
    t.a.publish(sticky, 'from a');
    (t.a as unknown as { dispose(): void }).dispose();
    const seen: string[] = [];
    t.win.subscribe(sticky, (p) => seen.push(p));
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([]);
  });

  it('C7: a live subscriber also gets the normal delivery of a new publication (not replayed)', () => {
    const t = tree();
    const seen: Array<[string, boolean]> = [];
    t.win.subscribe(sticky, (p, meta) => seen.push([p, meta.replayed]));
    t.tasks.publish(sticky, 'live');
    expect(seen).toEqual([['live', false]]);
  });
});

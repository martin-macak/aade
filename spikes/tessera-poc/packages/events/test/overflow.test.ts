import { describe, expect, it } from 'vitest';
import { defineTopic } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { tree } from './kit.ts';

describe('C7: bounded queues apply their overflow policy', () => {
  it('C7: dropOldest (default) keeps the newest items, counts drops, reports bus.overflow once per burst', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('overflow.oldest');
    const seen: number[] = [];
    t.win.subscribe(topic, (n) => seen.push(n), { delivery: 'microtask', maxQueue: 3, owner: 'slow.plugin' });
    for (let i = 1; i <= 7; i++) t.tasks.publish(topic, i);
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([5, 6, 7]);
    expect(t.bus.stats.peek().dropped).toBe(4);
    const reported = capture.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'bus.overflow' });
    expect(reported[0]?.context).toMatchObject({ source: 'subscriber', target: 'overflow.oldest', pluginId: 'slow.plugin' });
    // a new burst reports again
    for (let i = 8; i <= 12; i++) t.tasks.publish(topic, i);
    t.t.scheduler.flushMicrotasks();
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
  });

  it('C7: dropNewest keeps the oldest items', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('overflow.newest');
    const seen: number[] = [];
    t.win.subscribe(topic, (n) => seen.push(n), { delivery: 'idle', maxQueue: 2, overflow: 'dropNewest' });
    for (let i = 1; i <= 5; i++) t.tasks.publish(topic, i);
    t.t.scheduler.runIdle();
    expect(seen).toEqual([1, 2]);
    expect(t.bus.stats.peek().dropped).toBe(3);
    capture.drain();
    capture.dispose();
  });

  it('C7: sync subscribers have no queue and never drop; the default queue limit is 1000', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('overflow.default');
    let syncCount = 0;
    const queued: number[] = [];
    t.win.subscribe(topic, () => syncCount++);
    t.win.subscribe(topic, (n) => queued.push(n), { delivery: 'microtask' });
    for (let i = 0; i < 1200; i++) t.tasks.publish(topic, i);
    t.t.scheduler.flushMicrotasks();
    expect(syncCount).toBe(1200);
    expect(queued).toHaveLength(1000);
    expect(queued[0]).toBe(200);
    capture.drain();
    capture.dispose();
  });
});

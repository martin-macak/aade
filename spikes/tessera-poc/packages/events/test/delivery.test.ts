import { describe, expect, it } from 'vitest';
import { transact, state } from '@tessera/reactive';
import { defineTopic } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { tree } from './kit.ts';

describe('C7: delivery modes are chosen per subscriber through the Scheduler', () => {
  it('C7: sync runs inside publish; microtask runs on the scheduler microtask queue; idle runs on idle', () => {
    const t = tree();
    const topic = defineTopic<number>('modes');
    const log: string[] = [];
    t.tasks.subscribe(topic, (n) => log.push(`sync ${n}`), { delivery: 'sync' });
    t.tasks.subscribe(topic, (n) => log.push(`micro ${n}`), { delivery: 'microtask' });
    t.tasks.subscribe(topic, (n) => log.push(`idle ${n}`), { delivery: 'idle' });
    t.tasks.publish(topic, 1);
    expect(log).toEqual(['sync 1']);
    t.t.scheduler.flushMicrotasks();
    expect(log).toEqual(['sync 1', 'micro 1']);
    t.t.scheduler.runIdle();
    expect(log).toEqual(['sync 1', 'micro 1', 'idle 1']);
  });

  it('C7: the topic default delivery applies to subscribers that do not choose; a subscriber choice wins', () => {
    const t = tree();
    const topic = defineTopic<number>('default.delivery', { delivery: 'microtask' });
    const log: string[] = [];
    t.tasks.subscribe(topic, () => log.push('default'));
    t.tasks.subscribe(topic, () => log.push('chosen sync'), { delivery: 'sync' });
    t.tasks.publish(topic, 1);
    expect(log).toEqual(['chosen sync']);
    t.t.scheduler.flushMicrotasks();
    expect(log).toEqual(['chosen sync', 'default']);
  });

  it('C7: a queued subscriber keeps publication order and gets meta with a stamped seq and the source node', () => {
    const t = tree();
    const topic = defineTopic<string>('queue');
    const seen: Array<[string, number, string, string]> = [];
    t.win.subscribe(topic, (payload, meta) => seen.push([payload, meta.seq, meta.sourceNodeId, meta.origin]), { delivery: 'microtask' });
    t.a.publish(topic, 'one');
    t.b.publish(topic, 'two');
    t.t.scheduler.flushMicrotasks();
    expect(seen.map((s) => s[0])).toEqual(['one', 'two']);
    expect(seen[0]![1]).toBeLessThan(seen[1]![1]);
    expect(seen[0]!.slice(2)).toEqual(['root/tasks/project-a', 'local']);
    expect(seen[1]![2]).toBe('root/tasks/project-b');
  });

  it('C7: idle delivery stops when the deadline has less than 1 ms left and continues in the next idle callback', () => {
    const t = tree();
    const topic = defineTopic<number>('idle.budget');
    const seen: number[] = [];
    t.tasks.subscribe(topic, (n) => seen.push(n), { delivery: 'idle' });
    for (let i = 1; i <= 5; i++) t.tasks.publish(topic, i);
    let budget = 3.5;
    t.t.scheduler.runIdle({ timeRemaining: () => (budget -= 1) });
    expect(seen).toEqual([1, 2]); // 2.5 and 1.5 ms remaining: two items run; at 0.5 ms the drain stops
    expect(t.t.scheduler.pendingIdle).toBe(1);
    t.t.scheduler.runIdle();
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('C7: idle delivery has a starvation timeout of 1000 ms', () => {
    const t = tree();
    const topic = defineTopic<number>('idle.timeout');
    const seen: number[] = [];
    t.tasks.subscribe(topic, (n) => seen.push(n), { delivery: 'idle' });
    t.tasks.publish(topic, 1);
    t.t.scheduler.advance(999);
    expect(seen).toEqual([]);
    t.t.scheduler.advance(1);
    expect(seen).toEqual([1]);
  });

  it('C7: a publish during a sync delivery is queued and every subscriber sees the same order', () => {
    const t = tree();
    const topic = defineTopic<number>('reentrant');
    const first: number[] = [];
    const second: number[] = [];
    t.tasks.subscribe(topic, (n) => {
      first.push(n);
      if (n === 1) t.tasks.publish(topic, 2);
    });
    t.tasks.subscribe(topic, (n) => second.push(n));
    t.tasks.publish(topic, 1);
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
  });

  it('C7: the filter option decides per subscriber', () => {
    const t = tree();
    const topic = defineTopic<{ readonly project: string }>('filter');
    const seen: string[] = [];
    t.win.subscribe(topic, (p) => seen.push(p.project), { filter: (p) => p.project === 'a' });
    t.tasks.publish(topic, { project: 'a' });
    t.tasks.publish(topic, { project: 'b' });
    expect(seen).toEqual(['a']);
  });

  it('C7: the abort signal ends a subscription, and on() adapts a topic to an Event with once', () => {
    const t = tree();
    const topic = defineTopic<number>('signal');
    const controller = new AbortController();
    const seen: string[] = [];
    t.win.subscribe(topic, (n) => seen.push(`sub ${n}`), { signal: controller.signal });
    t.win.on(topic)((n) => seen.push(`once ${n}`), { once: true });
    t.tasks.publish(topic, 1);
    controller.abort();
    t.tasks.publish(topic, 2);
    expect(seen).toEqual(['sub 1', 'once 1']);
    t.win.subscribe(topic, () => seen.push('late'), { signal: AbortSignal.abort() });
    t.tasks.publish(topic, 3);
    expect(seen).toEqual(['sub 1', 'once 1']);
  });

  it('C7: disposing a subscription drops its queued deliveries', () => {
    const t = tree();
    const topic = defineTopic<number>('dispose.queue');
    const seen: number[] = [];
    const sub = t.win.subscribe(topic, (n) => seen.push(n), { delivery: 'microtask' });
    t.tasks.publish(topic, 1);
    sub.dispose();
    t.t.scheduler.tick();
    expect(seen).toEqual([]);
  });

  it('C6: bus delivery waits for the outermost transaction commit and is dropped if the transaction fails', () => {
    const t = tree();
    const topic = defineTopic<string>('txn');
    const count = state(0);
    const log: string[] = [];
    t.win.subscribe(topic, (p) => log.push(`${p} sees count=${count.peek()}`));
    transact(() => {
      count.set(1);
      t.tasks.publish(topic, 'committed');
      expect(log).toEqual([]);
    });
    expect(log).toEqual(['committed sees count=1']);
    expect(() =>
      transact(() => {
        t.tasks.publish(topic, 'lost');
        throw new Error('transaction failed');
      }),
    ).toThrow();
    expect(log).toEqual(['committed sees count=1']);
    transact(() => {
      t.tasks.publish(topic, 'before');
      try {
        transact(() => {
          t.tasks.publish(topic, 'inner lost');
          throw new Error('inner');
        });
      } catch {
        // the outer transaction continues
      }
      t.tasks.publish(topic, 'after');
    });
    expect(log.slice(1)).toEqual(['before sees count=1', 'after sees count=1']);
  });

  it('C7: stats count publications, deliveries and handler errors', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('stats');
    t.win.subscribe(topic, () => {});
    t.win.subscribe(topic, () => {
      throw new Error('x');
    });
    t.tasks.publish(topic, 1);
    t.tasks.publish(topic, 2);
    expect(t.bus.stats.peek()).toEqual({ published: 2, delivered: 4, dropped: 0, handlerErrors: 2 });
    capture.drain();
    capture.dispose();
  });

  it('dev mode validates payloads with the topic schema and throws to the publisher', () => {
    const t = tree();
    const topic = defineTopic<number>('schema', {
      schema: { safeParse: (input) => (typeof input === 'number' ? { success: true, data: input } : { success: false, error: { issues: [{ path: [], message: 'not a number' }] } }) },
    });
    const seen: number[] = [];
    t.win.subscribe(topic, (n) => seen.push(n));
    expect(() => t.tasks.publish(topic, 'oops' as unknown as number)).toThrow(expect.objectContaining({ code: 'validation' }));
    t.tasks.publish(topic, 1);
    expect(seen).toEqual([1]);
  });
});

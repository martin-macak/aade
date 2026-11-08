import { describe, expect, it } from 'vitest';
import { defineTopic } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { tree } from './kit.ts';

describe('C7: subscriber errors are isolated and attributed', () => {
  it('C7: a throwing subscriber does not stop others and never reaches the publisher; the error names topic and owner', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('tasks.changed');
    const seen: number[] = [];
    t.tasks.subscribe(
      topic,
      () => {
        throw new Error('subscriber failed');
      },
      { owner: 'sample.faulty' },
    );
    t.win.subscribe(topic, (n) => seen.push(n));
    expect(() => t.tasks.publish(topic, 1)).not.toThrow();
    expect(seen).toEqual([1]);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toEqual({ source: 'subscriber', target: 'tasks.changed', pluginId: 'sample.faulty' });
  });

  it('C7: errors in queued deliveries are isolated and attributed too', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('queued.fails');
    const seen: number[] = [];
    t.win.subscribe(topic, () => {
      throw new Error('queued failure');
    }, { delivery: 'microtask', owner: 'p1' });
    t.win.subscribe(topic, (n) => seen.push(n), { delivery: 'microtask' });
    t.tasks.publish(topic, 5);
    t.t.scheduler.flushMicrotasks();
    expect(seen).toEqual([5]);
    expect(capture.drain().map((e) => e.context.pluginId)).toEqual(['p1']);
    capture.dispose();
  });

  it('C7: a throwing filter counts as a handler error for that subscriber only', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('filter.fails');
    const seen: number[] = [];
    t.win.subscribe(topic, () => seen.push(-1), { filter: () => { throw new Error('bad filter'); } });
    t.win.subscribe(topic, (n) => seen.push(n));
    t.tasks.publish(topic, 1);
    expect(seen).toEqual([1]);
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
  });

  it('C7: a subscriber that publishes and throws still lets the queued publication through', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('publish.then.throw');
    const seen: number[] = [];
    t.win.subscribe(topic, (n) => {
      if (n === 1) {
        t.tasks.publish(topic, 2);
        throw new Error('after publishing');
      }
    });
    t.win.subscribe(topic, (n) => seen.push(n));
    t.tasks.publish(topic, 1);
    expect(seen).toEqual([1, 2]);
    capture.drain();
    capture.dispose();
  });
});

describe('C7: async subscribers and feedback loops (async-subscriber-rejection-unhandled, event-bus-feedback-loop-hang)', () => {
  it('C7: a rejected promise from an async subscriber is reported with its owner, and no unhandled rejection escapes', async () => {
    const t = tree();
    const capture = captureErrors();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const topic = defineTopic<number>('async.fails');
    t.win.subscribe(
      topic,
      async () => {
        await Promise.resolve();
        throw new Error('async subscriber failed');
      },
      { owner: 'sample.async' },
    );
    t.tasks.publish(topic, 1);
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection and the process-level check run
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toEqual({ source: 'subscriber', target: 'async.fails', pluginId: 'sample.async' });
  });

  it('C7: a once listener that throws is not called again', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('once.throws');
    let calls = 0;
    t.win.on(topic)(
      () => {
        calls++;
        throw new Error('listener failed');
      },
      { once: true },
    );
    t.tasks.publish(topic, 1);
    t.tasks.publish(topic, 2);
    expect(calls).toBe(1);
    capture.drain();
    capture.dispose();
  });

  it('C7: a subscriber that republishes forever is cut off at the cascade limit with bus.cascade and the publisher of the loop', () => {
    const t = tree();
    const capture = captureErrors();
    const topic = defineTopic<number>('loop.forever');
    let calls = 0;
    t.win.subscribe(topic, (n) => {
      calls++;
      t.win.publishAs?.('sample.loop', topic, n + 1); // the plugin facade stamps the publisher
    }, { owner: 'sample.loop' });
    t.tasks.publish(topic, 0);
    expect(calls).toBeLessThanOrEqual(10_001);
    expect(calls).toBeGreaterThan(9_000);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'bus.cascade' });
    expect(reported[0]?.context.pluginId).toBe('sample.loop');
    // the bus works again afterwards
    const seen: number[] = [];
    const ok = defineTopic<number>('after.cascade');
    t.win.subscribe(ok, (n) => seen.push(n));
    t.tasks.publish(ok, 1);
    expect(seen).toEqual([1]);
  });
});

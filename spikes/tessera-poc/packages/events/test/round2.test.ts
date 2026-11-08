import { describe, expect, it } from 'vitest';
import { Emitter } from '@tessera/base';
import { defineTopic, type EventRelay } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { tree } from './kit.ts';

describe('round 2: once on a sticky topic', () => {
  for (const delivery of ['sync', 'microtask', 'idle'] as const) {
    it(`C7: on(topic)(listener, { once: true }) on a sticky ${delivery} topic fires once with the replay and not again (${delivery})`, () => {
      const t = tree();
      const topic = defineTopic<number>(`once.sticky.${delivery}`, { sticky: true });
      t.tasks.publish(topic, 1);
      const seen: Array<[number, boolean]> = [];
      const capture = captureErrors();
      t.win.on(topic, { delivery })((p) => void seen.push([p, true]), { once: true });
      t.t.scheduler.flushMicrotasks();
      t.t.scheduler.runIdle();
      t.tasks.publish(topic, 2);
      t.t.scheduler.flushMicrotasks();
      t.t.scheduler.runIdle();
      expect(capture.drain()).toEqual([]);
      capture.dispose();
      expect(seen).toEqual([[1, true]]);
    });
  }

  it('C7: once without a retained value still takes the first live value', () => {
    const t = tree();
    const topic = defineTopic<number>('once.sticky.empty', { sticky: true });
    const seen: number[] = [];
    t.win.on(topic)((p) => void seen.push(p), { once: true });
    t.tasks.publish(topic, 5);
    t.tasks.publish(topic, 6);
    expect(seen).toEqual([5]);
  });
});

describe('round 2: the cascade limit', () => {
  it('C7: a loop in one topic does not drop unrelated queued publications, and a sticky value that is dropped stays retained', () => {
    const t = tree();
    const capture = captureErrors();
    const loop = defineTopic<number>('cascade.loop');
    const phase = defineTopic<string>('cascade.phase', { sticky: true });
    const other = defineTopic<number>('cascade.other');
    const seenOther: number[] = [];
    t.win.subscribe(other, (n) => void seenOther.push(n));
    t.win.subscribe(loop, (n) => {
      if (n === 0) {
        t.win.publish(phase, 'ready');
        t.win.publish(other, 1);
      }
      t.win.publish(loop, n + 1);
    }, { owner: 'sample.loop' });
    t.tasks.publish(loop, 0);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'bus.cascade' });
    expect(seenOther).toEqual([1]);
    const late: string[] = [];
    t.win.subscribe(phase, (p) => void late.push(p));
    expect(late).toEqual(['ready']);
  });

  it('C7: a sticky value published and queued before a cut-off is retained (retention at enqueue)', () => {
    const t = tree();
    const capture = captureErrors();
    const loop = defineTopic<number>('cascade.retain.loop');
    const phase = defineTopic<string>('cascade.retain.phase', { sticky: true });
    t.win.subscribe(loop, (n) => void t.win.publish(loop, n + 1));
    t.tasks.publish(loop, 0);
    t.tasks.publish(phase, 'x');
    capture.drain();
    capture.dispose();
    const seen: string[] = [];
    t.win.subscribe(phase, (p) => void seen.push(p));
    expect(seen).toEqual(['x']);
  });

  it('C7: a topic that loops through microtask subscribers is cut off per task', () => {
    const t = tree();
    const capture = captureErrors();
    const loop = defineTopic<number>('cascade.async.loop');
    let calls = 0;
    t.win.subscribe(loop, (n) => {
      calls++;
      t.win.publishAs?.('sample.async-loop', loop, n + 1);
    }, { delivery: 'microtask', owner: 'sample.async-loop' });
    t.tasks.publish(loop, 0);
    t.t.scheduler.flushMicrotasks();
    const reported = capture.drain();
    capture.dispose();
    expect(calls).toBeGreaterThan(9_000);
    expect(calls).toBeLessThan(20_000);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'bus.cascade' });
    expect(reported[0]?.context.pluginId).toBe('sample.async-loop');
  });
});

describe('round 2: remote messages', () => {
  function relayFor(): EventRelay & { receive(topicId: string, payload: unknown): void; dispose(): void } {
    const remote = new Emitter<{ readonly topicId: string; readonly payload: unknown; readonly traceId: string | undefined }>();
    return { forward: () => {}, onRemote: remote.event, receive: (topicId, payload) => remote.fire({ topicId, payload, traceId: undefined }), dispose: () => remote.dispose() };
  }

  it('C7: a remote message for a topic that is not crossProcess is dropped and reported (bus.remoteRejected)', () => {
    const t = tree();
    const relay = relayFor();
    const handle = t.bus.setRelay(relay);
    const local = defineTopic<number>('relay.notcross');
    const seen: number[] = [];
    t.win.subscribe(local, (n) => void seen.push(n));
    const capture = captureErrors();
    relay.receive('relay.notcross', 1);
    const reported = capture.drain();
    capture.dispose();
    handle.dispose();
    relay.dispose();
    expect(seen).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'bus.remoteRejected' });
  });
});

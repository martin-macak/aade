import { describe, expect, it } from 'vitest';
import { Emitter } from '@tessera/base';
import { defineTopic } from '@tessera/contracts';
import { captureErrors, createTestScope } from '@tessera/testing';
import { DefaultEventBus } from '@tessera/events';
import { reactiveDebug, state, changes } from '@tessera/reactive';

/** Counts the abort listeners that a signal holds. */
function countingSignal(): { readonly signal: AbortSignal; listeners(): number } {
  const controller = new AbortController();
  let count = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => (type === 'abort' && count++, add(type, fn, opts as never))) as never;
  controller.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => (type === 'abort' && count--, remove(type, fn, opts as never))) as never;
  return { signal: controller.signal, listeners: () => count };
}

describe('subscription-handle-leaks: a disposed subscription removes its abort listener', () => {
  it('Emitter.event: 100 subscribe/dispose rounds on a long-lived signal leave no listener', () => {
    const emitter = new Emitter<number>({ name: 'test' });
    const { signal, listeners } = countingSignal();
    for (let i = 0; i < 100; i++) emitter.event(() => undefined, { signal }).dispose();
    expect(listeners()).toBe(0);
    emitter.dispose();
  });

  it('EventNode.subscribe with a signal: dispose removes the listener', () => {
    const bus = new DefaultEventBus();
    const topic = defineTopic<number>('test.leak');
    const { signal, listeners } = countingSignal();
    for (let i = 0; i < 50; i++) bus.root.subscribe(topic, () => undefined, { signal }).dispose();
    expect(listeners()).toBe(0);
  });

  it('EventNode.on with a signal: 100 subscribe/dispose rounds leave no listener, and an abort still ends the subscription', () => {
    const bus = new DefaultEventBus();
    const topic = defineTopic<number>('test.leak.on');
    const { signal, listeners } = countingSignal();
    for (let i = 0; i < 100; i++) bus.root.on(topic)(() => undefined, { signal }).dispose();
    expect(listeners()).toBe(0);
    const seen: number[] = [];
    const controller = new AbortController();
    bus.root.on(topic)((n) => void seen.push(n), { signal: controller.signal });
    bus.root.publish(topic, 1);
    controller.abort();
    bus.root.publish(topic, 2);
    expect(seen).toEqual([1]);
  });

  it('changes(once) uses one subscription and ends it after the first change', () => {
    const before = reactiveDebug.liveSubscriptions();
    const source = state(0);
    const seen: number[] = [];
    const sub = changes(source)((v) => void seen.push(v), { once: true });
    expect(reactiveDebug.liveSubscriptions() - before).toBe(1); // one, not two
    source.set(1);
    source.set(2);
    expect(seen).toEqual([1]);
    expect(reactiveDebug.liveSubscriptions() - before).toBe(0);
    sub.dispose();
  });
});

describe('bus-last-owner-stale: the cascade report names the publisher, not the last subscriber', () => {
  it('a core loop is not blamed on a plugin that subscribed earlier', () => {
    createTestScope({ flat: true });
    const errors = captureErrors();
    const bus = new DefaultEventBus({ maxCascade: 20 });
    const ping = defineTopic<number>('test.ping');
    const other = defineTopic<number>('test.other');
    bus.root.subscribe(other, () => undefined, { owner: 'acme.innocent' });
    bus.root.publish(other, 1); // the innocent plugin's handler is the last subscriber to have run
    bus.root.subscribe(ping, (n) => bus.root.publish(ping, n + 1)); // a core loop
    bus.root.publish(ping, 0);
    const reports = errors.drain();
    expect(reports.some((r) => (r.error as { code?: string }).code === 'bus.cascade')).toBe(true);
    expect(reports.every((r) => r.context.pluginId === undefined)).toBe(true);
    errors.dispose();
  });
});

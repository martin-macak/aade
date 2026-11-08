import { describe, expect, it } from 'vitest';
import { captureErrors, ManualScheduler } from '@tessera/testing';
import { DisposableStore, Emitter, Event, transactionGate } from '@tessera/base';

describe('C6: Emitter semantics', () => {
  it('delivers in subscription order', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event((n) => seen.push(`a${n}`));
    emitter.event((n) => seen.push(`b${n}`));
    emitter.fire(1);
    expect(seen).toEqual(['a1', 'b1']);
    emitter.dispose();
  });

  it('C6: a throwing listener does not stop later listeners and the error is reported with source listener', () => {
    const capture = captureErrors();
    const emitter = new Emitter<number>({ name: 'test.emitter' });
    const seen: number[] = [];
    emitter.event(() => {
      throw new Error('first listener fails');
    });
    emitter.event((n) => seen.push(n));
    emitter.fire(7);
    expect(seen).toEqual([7]);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'listener', target: 'test.emitter' });
    emitter.dispose();
  });

  it('onListenerError receives listener errors instead of the global reporter', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<number>({ onListenerError: (e) => errors.push(e) });
    emitter.event(() => {
      throw new Error('bad');
    });
    emitter.fire(1);
    expect(errors).toHaveLength(1);
    emitter.dispose();
  });

  it('C6: a re-entrant fire is queued and every listener sees the same order', () => {
    const emitter = new Emitter<number>();
    const first: number[] = [];
    const second: number[] = [];
    emitter.event((n) => {
      first.push(n);
      if (n === 1) emitter.fire(2);
    });
    emitter.event((n) => second.push(n));
    emitter.fire(1);
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    emitter.dispose();
  });

  it('a listener removed during delivery is not called again, even in the same delivery', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    const second = { sub: undefined as { dispose(): void } | undefined };
    emitter.event(() => {
      seen.push('first');
      second.sub?.dispose();
    });
    second.sub = emitter.event(() => seen.push('second'));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual(['first', 'first']);
    emitter.dispose();
  });

  it('options: once, store and signal end the subscription', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event((n) => seen.push(`once${n}`), { once: true });
    const store = new DisposableStore();
    emitter.event((n) => seen.push(`store${n}`), { store });
    const controller = new AbortController();
    emitter.event((n) => seen.push(`signal${n}`), { signal: controller.signal });
    emitter.fire(1);
    store.dispose();
    controller.abort();
    emitter.fire(2);
    expect(seen).toEqual(['once1', 'store1', 'signal1']);
    expect(emitter.hasListeners).toBe(false);
    emitter.dispose();
  });

  it('onFirstListenerAdd and onLastListenerRemove fire at the edges', () => {
    const log: string[] = [];
    const emitter = new Emitter<number>({ onFirstListenerAdd: () => log.push('first'), onLastListenerRemove: () => log.push('last') });
    const a = emitter.event(() => {});
    const b = emitter.event(() => {});
    a.dispose();
    b.dispose();
    expect(log).toEqual(['first', 'last']);
    emitter.dispose();
  });

  it('dispose() removes all listeners and later fire() does nothing', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((n) => seen.push(n));
    emitter.dispose();
    emitter.fire(1);
    expect(seen).toEqual([]);
    expect(emitter.hasListeners).toBe(false);
    const late = emitter.event(() => seen.push(2));
    late.dispose();
  });

  it('warns once when the listener count passes the threshold', () => {
    const capture = captureErrors();
    const emitter = new Emitter<number>({ name: 'leaky', leakWarningThreshold: 2 });
    const subs = [1, 2, 3, 4].map(() => emitter.event(() => {}));
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(String((reported[0]!.error as Error).message)).toContain('leaky');
    subs.forEach((s) => s.dispose());
    emitter.dispose();
  });
});

describe('C6: Emitter and the transaction gate', () => {
  it('C6: inside a transaction delivery waits for the outermost commit', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((n) => seen.push(n));
    transactionGate.begin();
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual([]);
    transactionGate.end(true);
    expect(seen).toEqual([1, 2]);
    emitter.dispose();
  });

  it('C6: a failed transaction drops the deferred events', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((n) => seen.push(n));
    transactionGate.begin();
    emitter.fire(1);
    transactionGate.end(false);
    expect(seen).toEqual([]);
    emitter.fire(2);
    expect(seen).toEqual([2]);
    emitter.dispose();
  });

  it('deferInTransaction: false delivers at once, even inside a transaction', () => {
    const emitter = new Emitter<number>({ deferInTransaction: false });
    const seen: number[] = [];
    emitter.event((n) => seen.push(n));
    transactionGate.begin();
    emitter.fire(1);
    expect(seen).toEqual([1]);
    transactionGate.end(true);
    emitter.dispose();
  });

  it('C6: a throwing listener in a deferred delivery does not stop later listeners', () => {
    const capture = captureErrors();
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event(() => {
      throw new Error('x');
    });
    emitter.event((n) => seen.push(n));
    transactionGate.begin();
    emitter.fire(5);
    transactionGate.end(true);
    expect(seen).toEqual([5]);
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
    emitter.dispose();
  });
});

describe('Event helpers', () => {
  it('map, filter, once, any', () => {
    const a = new Emitter<number>();
    const b = new Emitter<number>();
    const seen: string[] = [];
    const store = new DisposableStore();
    Event.map(a.event, (n) => n * 2)((n) => seen.push(`map${n}`), { store });
    Event.filter(a.event, (n) => n % 2 === 0)((n) => seen.push(`even${n}`), { store });
    Event.once(a.event)((n) => seen.push(`once${n}`), { store });
    Event.any(a.event, b.event)((n) => seen.push(`any${n}`), { store });
    a.fire(1);
    a.fire(2);
    b.fire(3);
    expect(seen).toEqual(['map2', 'once1', 'any1', 'map4', 'even2', 'any2', 'any3']);
    store.dispose();
    a.dispose();
    b.dispose();
  });

  it('debounce merges events inside the delay through the scheduler', () => {
    const scheduler = new ManualScheduler();
    const install = scheduler.install();
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const sub = Event.debounce(emitter.event, 100, (last, e) => (last ?? 0) + e)((n) => seen.push(n));
    emitter.fire(1);
    scheduler.advance(50);
    emitter.fire(2);
    scheduler.advance(99);
    expect(seen).toEqual([]);
    scheduler.advance(1);
    expect(seen).toEqual([3]);
    sub.dispose();
    emitter.dispose();
    install.dispose();
  });

  it('toPromise resolves on the first event and rejects on abort', async () => {
    const emitter = new Emitter<string>();
    const promise = Event.toPromise(emitter.event);
    emitter.fire('hello');
    await expect(promise).resolves.toBe('hello');
    const controller = new AbortController();
    const aborted = Event.toPromise(emitter.event, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });
    expect(emitter.hasListeners).toBe(false);
    emitter.dispose();
  });

  it('Event.None never fires and its subscription is disposable', () => {
    Event.None(() => {}).dispose();
  });
});

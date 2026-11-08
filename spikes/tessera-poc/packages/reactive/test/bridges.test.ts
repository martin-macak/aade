import { describe, expect, it } from 'vitest';
import { CancellationError, DisposableStore, Emitter } from '@tessera/base';
import { ManualScheduler } from '@tessera/testing';
import {
  changes,
  computed,
  constant,
  effect,
  fromEvent,
  installReactiveEngine,
  isObservable,
  preactEngine,
  reactiveDebug,
  resource,
  state,
  whenTrue,
} from '@tessera/reactive';

describe('reactive bridges', () => {
  it('fromEvent turns events into change signals for a read function', () => {
    const emitter = new Emitter<void>();
    let external = 1;
    const view = fromEvent(emitter.event, () => external, { name: 'external' });
    const seen: number[] = [];
    const fx = effect(() => {
      seen.push(view.get());
    });
    external = 2;
    expect(seen).toEqual([1]); // nothing happens until the event says so
    emitter.fire();
    expect(seen).toEqual([1, 2]);
    expect(emitter.hasListeners).toBe(true);
    fx.dispose();
    view.dispose();
    expect(emitter.hasListeners).toBe(false);
    emitter.dispose();
  });

  it('fromEvent subscribes lazily, on first access', () => {
    const emitter = new Emitter<void>();
    const view = fromEvent(emitter.event, () => 1);
    expect(emitter.hasListeners).toBe(false);
    view.peek();
    expect(emitter.hasListeners).toBe(true);
    view.dispose();
    view.dispose();
    emitter.dispose();
  });

  it('changes() exposes settled changes as an Event and ends with its subscription', () => {
    const source = state(1);
    const emitter = changes(source);
    const seen: number[] = [];
    const store = new DisposableStore();
    emitter((v) => seen.push(v), { store });
    source.set(2);
    source.set(3);
    expect(seen).toEqual([2, 3]);
    store.dispose();
    source.set(4);
    expect(seen).toEqual([2, 3]);
    const once: number[] = [];
    const sub = changes(source)((v) => once.push(v), { once: true });
    source.set(5);
    source.set(6);
    expect(once).toEqual([5]);
    sub.dispose();
  });

  it('whenTrue resolves when the observable turns true, immediately if it already is, and rejects on abort', async () => {
    const flag = state(false);
    const waiting = whenTrue(flag);
    flag.set(true);
    await expect(waiting).resolves.toBeUndefined();
    await expect(whenTrue(flag)).resolves.toBeUndefined();

    flag.set(false);
    const controller = new AbortController();
    const aborted = whenTrue(flag, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(CancellationError);
    await expect(whenTrue(flag, AbortSignal.abort())).rejects.toBeInstanceOf(CancellationError);
    expect(reactiveDebug.liveSubscriptions()).toBe(0);
  });

  it('constant() and isObservable()', () => {
    const c = constant(5);
    expect(c.get()).toBe(5);
    expect(isObservable(c)).toBe(true);
    expect(isObservable(state(1))).toBe(true);
    expect(isObservable(computed(() => 1))).toBe(true);
    expect(isObservable({ get: () => 1 })).toBe(false);
    const sub = c.subscribe(() => {});
    sub.dispose();
  });

  it('the engine cannot be replaced after the first node exists (reactive.engineLocked)', () => {
    state(1);
    expect(() => installReactiveEngine(preactEngine)).toThrow(expect.objectContaining({ code: 'reactive.engineLocked' }));
  });
});

describe('resource()', () => {
  it('goes from pending to ready with the loaded value', async () => {
    const handle = resource(async () => 'loaded', { name: 'r' });
    expect(handle.state.peek()).toEqual({ status: 'pending' });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.state.peek()).toEqual({ status: 'ready', value: 'loaded' });
    handle.dispose();
  });

  it('keeps the previous value while reloading, and reports an error with the previous value', async () => {
    let n = 0;
    let fail = false;
    const handle = resource(async () => {
      n++;
      if (fail) throw new Error('load failed');
      return n;
    });
    await settle();
    expect(handle.state.peek()).toEqual({ status: 'ready', value: 1 });
    handle.reload();
    expect(handle.state.peek()).toEqual({ status: 'pending', previous: 1 });
    await settle();
    expect(handle.state.peek()).toEqual({ status: 'ready', value: 2 });
    fail = true;
    handle.reload();
    await settle();
    const current = handle.state.peek();
    expect(current.status).toBe('error');
    expect(current).toMatchObject({ previous: 2 });
    handle.dispose();
  });

  it('a new load aborts the running one and ignores its late result', async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<(v: string) => void> = [];
    const handle = resource(
      (signal) => {
        signals.push(signal);
        return new Promise<string>((resolve) => releases.push(resolve));
      },
      { lazy: true },
    );
    expect(handle.state.peek().status).toBe('pending'); // first read starts a lazy resource
    handle.reload();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    releases[0]?.('stale');
    releases[1]?.('fresh');
    await settle();
    expect(handle.state.peek()).toEqual({ status: 'ready', value: 'fresh' });
    handle.dispose();
  });

  it('a lazy resource stays idle until first read or reload', () => {
    let loads = 0;
    const handle = resource(async () => ++loads, { lazy: true });
    expect(loads).toBe(0);
    handle.reload();
    expect(loads).toBe(1);
    handle.dispose();
  });

  it('reloads when the observables read by deps change, and dispose() aborts the running load', async () => {
    const id = state(1);
    const calls: Array<{ id: number; signal: AbortSignal }> = [];
    const handle = resource(
      (signal) => {
        calls.push({ id: id.peek(), signal });
        return new Promise<number>(() => {});
      },
      { deps: () => id.get() },
    );
    expect(calls.map((c) => c.id)).toEqual([1]);
    id.set(2);
    expect(calls.map((c) => c.id)).toEqual([1, 2]);
    expect(calls[0]?.signal.aborted).toBe(true);
    handle.dispose();
    expect(calls[1]?.signal.aborted).toBe(true);
    id.set(3);
    expect(calls).toHaveLength(2);
    expect(reactiveDebug.liveEffects()).toBe(0);
  });

  it('abort() cancels the running load and returns to idle or the last value', async () => {
    let signal: AbortSignal | undefined;
    const handle = resource((s) => {
      signal = s;
      return new Promise<number>(() => {});
    });
    handle.abort();
    expect(signal?.aborted).toBe(true);
    expect(handle.state.peek()).toEqual({ status: 'idle' });
    handle.dispose();
  });

  it('a synchronous throw in load becomes an error state', async () => {
    const handle = resource((): Promise<number> => {
      throw new Error('sync failure');
    });
    await settle();
    expect(handle.state.peek().status).toBe('error');
    handle.dispose();
  });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('scheduler independence', () => {
  it('the reactive core does not use the scheduler', () => {
    const scheduler = new ManualScheduler();
    const install = scheduler.install();
    const a = state(1);
    const seen: number[] = [];
    const sub = a.subscribe((v) => seen.push(v));
    a.set(2);
    expect(seen).toEqual([2]);
    expect(scheduler.pending).toBe(0);
    sub.dispose();
    install.dispose();
  });
});

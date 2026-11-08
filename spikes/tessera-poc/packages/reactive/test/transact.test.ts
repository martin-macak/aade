import { describe, expect, it } from 'vitest';
import { captureErrors } from '@tessera/testing';
import { Emitter, transactionGate } from '@tessera/base';
import { setDevMode } from '@tessera/base';
import { batch, computed, effect, reactiveDebug, resource, state, transact } from '@tessera/reactive';

describe('C6: transact batches state and delivers events after commit', () => {
  it('C6: state writes inside transact notify once, and events fired inside are delivered after commit', () => {
    const tasks = state<readonly string[]>([]);
    const selected = state<string | undefined>(undefined);
    const emitter = new Emitter<string>();
    const log: string[] = [];
    const sub = tasks.subscribe((t) => log.push(`tasks ${t.length}`));
    const sub2 = selected.subscribe((s) => log.push(`selected ${s}`));
    const event = emitter.event((id) => log.push(`event ${id} sees tasks=${tasks.peek().length} selected=${selected.peek()}`));

    transact(() => {
      tasks.update((t) => [...t, 'a']);
      selected.set('a');
      emitter.fire('a');
      log.push('end of transaction body');
    });

    expect(log).toEqual(['end of transaction body', 'tasks 1', 'selected a', 'event a sees tasks=1 selected=a']);
    sub.dispose();
    sub2.dispose();
    event.dispose();
    emitter.dispose();
  });

  it('C6: a failed transaction drops the events deferred inside and keeps the writes made so far (no rollback)', () => {
    const count = state(0);
    const emitter = new Emitter<string>();
    const events: string[] = [];
    const event = emitter.event((e) => events.push(e));
    expect(() =>
      transact(() => {
        count.set(1);
        emitter.fire('lost');
        throw new Error('transaction failed');
      }),
    ).toThrow('transaction failed');
    expect(count.peek()).toBe(1);
    expect(events).toEqual([]);
    event.dispose();
    emitter.dispose();
  });

  it('C6: a failed inner transaction drops its events even when the outer one commits', () => {
    const emitter = new Emitter<string>();
    const events: string[] = [];
    const event = emitter.event((e) => events.push(e));
    transact(() => {
      emitter.fire('outer before');
      try {
        transact(() => {
          emitter.fire('inner lost');
          throw new Error('inner failed');
        });
      } catch {
        // the outer transaction catches the error and goes on
      }
      emitter.fire('outer after');
    });
    expect(events).toEqual(['outer before', 'outer after']);
    event.dispose();
    emitter.dispose();
  });

  it('C6: nested transactions deliver once, at the outermost commit, in firing order', () => {
    const emitter = new Emitter<string>();
    const events: string[] = [];
    const event = emitter.event((e) => events.push(e));
    transact(() => {
      emitter.fire('1');
      transact(() => emitter.fire('2'));
      expect(events).toEqual([]);
      emitter.fire('3');
    });
    expect(events).toEqual(['1', '2', '3']);
    expect(transactionGate.depth).toBe(0);
    event.dispose();
    emitter.dispose();
  });

  it('C6: a throwing listener does not stop the later listeners of a committed transaction', () => {
    const capture = captureErrors();
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const first = emitter.event(() => {
      throw new Error('first listener');
    });
    const second = emitter.event((n) => seen.push(n));
    transact(() => emitter.fire(1));
    expect(seen).toEqual([1]);
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
    first.dispose();
    second.dispose();
    emitter.dispose();
  });

  it('transact returns the value of its body', () => {
    expect(transact(() => 42)).toBe(42);
  });

  it('effects triggered by a transaction run before the events are delivered', () => {
    const value = state(0);
    const emitter = new Emitter<void>();
    const log: string[] = [];
    const fx = effect(() => {
      log.push(`effect ${value.get()}`);
    });
    const event = emitter.event(() => log.push('event'));
    transact(() => {
      value.set(1);
      emitter.fire();
    });
    expect(log).toEqual(['effect 0', 'effect 1', 'event']);
    fx.dispose();
    event.dispose();
    emitter.dispose();
  });

  it('batch() alone does not defer events', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const event = emitter.event((n) => seen.push(n));
    batch(() => {
      emitter.fire(1);
      expect(seen).toEqual([1]);
    });
    event.dispose();
    emitter.dispose();
  });

  it('computed values read inside a transaction body see the writes made so far', () => {
    const a = state(1);
    const double = computed(() => a.get() * 2);
    transact(() => {
      a.set(5);
      expect(double.get()).toBe(10);
    });
  });
});

describe('C6: transact inside batch (transact-ordering-and-async-fn)', () => {
  it('C6: a transact() inside batch() delivers events after the state subscribers of the batch ran', () => {
    const count = state(0);
    const emitter = new Emitter<string>();
    const log: string[] = [];
    const sub = count.subscribe((n) => log.push(`state ${n}`));
    const event = emitter.event((id) => log.push(`event ${id}, state is ${count.peek()}`));
    batch(() => {
      transact(() => {
        count.set(1);
        emitter.fire('a');
      });
      log.push('batch body continues');
      count.set(2);
    });
    expect(log).toEqual(['batch body continues', 'state 2', 'event a, state is 2']);
    sub.dispose();
    event.dispose();
    emitter.dispose();
  });

  it('C6: a failing transact() inside a batch still drops its events', () => {
    const emitter = new Emitter<string>();
    const seen: string[] = [];
    const event = emitter.event((id) => seen.push(id));
    expect(() =>
      batch(() => {
        transact(() => {
          emitter.fire('lost');
          throw new Error('inner failed');
        });
      }),
    ).toThrow('inner failed');
    expect(seen).toEqual([]);
    event.dispose();
    emitter.dispose();
  });

  it('C6: in dev mode transact(async fn) throws reactive.asyncTransaction; in production mode it is not checked', async () => {
    expect(() => transact((async () => undefined) as never)).toThrowError(expect.objectContaining({ code: 'reactive.asyncTransaction' }));
    setDevMode(false);
    try {
      await expect(transact(async () => 'later')).resolves.toBe('later');
    } finally {
      setDevMode(true);
    }
  });
});

describe('C6: a lazy resource read inside a computed (resource-lazy-read-in-computed)', () => {
  it('C6: it starts from a microtask, the first read sees idle, and the computed updates when the value arrives', async () => {
    const handle = resource(async () => 'loaded', { lazy: true, name: 'lazy.in.computed' });
    const seen = computed(() => handle.state.get().status);
    const log: string[] = [];
    const sub = seen.subscribe((status) => log.push(status));
    expect(seen.peek()).toBe('idle'); // no reactive.writeInComputed
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.state.peek()).toMatchObject({ status: 'ready', value: 'loaded' });
    expect(seen.peek()).toBe('ready');
    expect(log).toContain('ready');
    sub.dispose();
    handle.dispose();
  });
});

describe('C6: the node registry (reactive-node-registry-leak)', () => {
  it('C6: production mode registers no nodes; dev mode and the debug flag do', () => {
    const named = (label: string): number => reactiveDebug.nodes().filter((n) => n.name === label).length;
    setDevMode(false);
    try {
      const keep = state(1, { name: 'registry.prod' });
      expect(named('registry.prod')).toBe(0);
      reactiveDebug.enable(true);
      const debugged = state(1, { name: 'registry.debug' });
      expect(named('registry.debug')).toBe(1);
      reactiveDebug.enable(false);
      void keep;
      void debugged;
    } finally {
      setDevMode(true);
    }
    const dev = state(1, { name: 'registry.dev' });
    expect(named('registry.dev')).toBe(1);
    void dev;
  });
});

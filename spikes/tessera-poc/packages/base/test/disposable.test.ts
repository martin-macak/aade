import { describe, expect, it } from 'vitest';
import { captureErrors } from '@tessera/testing';
import {
  DisposableObject,
  DisposableStore,
  MutableDisposable,
  disposeAll,
  disposeLike,
  isDisposable,
  toDisposable,
} from '@tessera/base';

describe('C2: DisposableStore disposes deterministically', () => {
  it('C2: disposes in reverse insertion order (LIFO)', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push('a')));
    store.add(toDisposable(() => order.push('b')));
    store.add(toDisposable(() => order.push('c')));
    store.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('C2: a throwing disposable does not stop the others; errors are thrown as one AggregateError', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push('first')));
    store.add(
      toDisposable(() => {
        throw new Error('boom 1');
      }),
    );
    store.add(toDisposable(() => order.push('middle')));
    store.add(
      toDisposable(() => {
        throw new Error('boom 2');
      }),
    );
    store.add(toDisposable(() => order.push('last')));
    let thrown: unknown;
    try {
      store.dispose();
    } catch (error) {
      thrown = error;
    }
    expect(order).toEqual(['last', 'middle', 'first']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((e: Error) => e.message)).toEqual(['boom 2', 'boom 1']);
  });

  it('C2: dispose() is idempotent', () => {
    let count = 0;
    const store = new DisposableStore();
    store.add(toDisposable(() => count++));
    store.dispose();
    store.dispose();
    expect(count).toBe(1);
    expect(store.isDisposed).toBe(true);
  });

  it('C2: adding to a disposed store disposes the item at once and reports a leak warning', () => {
    const capture = captureErrors();
    const store = new DisposableStore('late');
    store.dispose();
    let disposed = false;
    store.add(toDisposable(() => (disposed = true)));
    expect(disposed).toBe(true);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context.source).toBe('dispose');
    expect(String((reported[0]!.error as Error).message)).toContain('late');
  });

  it('release() hands ownership back, delete() disposes, clear() keeps the store usable', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    const a = store.add(toDisposable(() => log.push('a')));
    const b = store.add(toDisposable(() => log.push('b')));
    store.add(toDisposable(() => log.push('c')));
    store.release(a);
    store.delete(b);
    expect(log).toEqual(['b']);
    expect(store.size).toBe(1);
    store.clear();
    expect(log).toEqual(['b', 'c']);
    expect(store.isDisposed).toBe(false);
    store.add(toDisposable(() => log.push('d')));
    store.dispose();
    expect(log).toEqual(['b', 'c', 'd']);
    a.dispose();
    expect(log).toContain('a');
  });

  it('a store refuses to register itself', () => {
    const store = new DisposableStore();
    expect(() => store.add(store)).toThrow(/itself/);
    store.dispose();
  });

  it('toDisposable and DisposableStore implement the ES resource-management protocol (Symbol.dispose)', () => {
    // The `using` statement calls [Symbol.dispose](). The statement itself is not written here because
    // dependency-cruiser's swc walker cannot parse it yet.
    let disposed = false;
    const handle: Disposable = toDisposable(() => (disposed = true));
    handle[Symbol.dispose]();
    expect(disposed).toBe(true);
    const store = new DisposableStore();
    store[Symbol.dispose]();
    expect(store.isDisposed).toBe(true);
  });

  it('toDisposable runs its function once', () => {
    let count = 0;
    const d = toDisposable(() => count++);
    d.dispose();
    d[Symbol.dispose]();
    expect(count).toBe(1);
  });
});

describe('C2: helpers', () => {
  it('disposeAll runs in reverse order and aggregates errors', () => {
    const order: number[] = [];
    const items = [1, 2, 3].map((n) =>
      toDisposable(() => {
        order.push(n);
        if (n === 2) throw new Error('two');
      }),
    );
    expect(() => disposeAll(items)).toThrow(AggregateError);
    expect(order).toEqual([3, 2, 1]);
  });

  it('disposeLike prefers asyncDispose, then dispose, then Symbol.dispose, and awaits', async () => {
    const calls: string[] = [];
    await disposeLike({
      [Symbol.asyncDispose]: async () => {
        await Promise.resolve();
        calls.push('async');
      },
      dispose: () => calls.push('dispose'),
    } as never);
    await disposeLike({ dispose: () => calls.push('dispose'), [Symbol.dispose]: () => calls.push('sym') });
    await disposeLike({ [Symbol.dispose]: () => calls.push('sym') });
    expect(calls).toEqual(['async', 'dispose', 'sym']);
  });

  it('isDisposable recognises all three protocols and rejects other values', () => {
    expect(isDisposable({ dispose() {} })).toBe(true);
    expect(isDisposable({ [Symbol.dispose]() {} })).toBe(true);
    expect(isDisposable({ [Symbol.asyncDispose]: async () => {} })).toBe(true);
    expect(isDisposable({})).toBe(false);
    expect(isDisposable(null)).toBe(false);
    expect(isDisposable(42)).toBe(false);
  });

  it('DisposableObject disposes what it registered, newest first', () => {
    const order: string[] = [];
    class Owner extends DisposableObject {
      constructor() {
        super();
        this.register(toDisposable(() => order.push('one')));
        this.register(toDisposable(() => order.push('two')));
      }
    }
    const owner = new Owner();
    owner.dispose();
    owner.dispose();
    expect(order).toEqual(['two', 'one']);
  });

  it('MutableDisposable disposes the old value when a new one is set', () => {
    const log: string[] = [];
    const holder = new MutableDisposable();
    holder.value = toDisposable(() => log.push('first'));
    holder.value = toDisposable(() => log.push('second'));
    expect(log).toEqual(['first']);
    holder.clear();
    expect(log).toEqual(['first', 'second']);
    holder.value = toDisposable(() => log.push('third'));
    holder.dispose();
    expect(log).toEqual(['first', 'second', 'third']);
    holder.value = toDisposable(() => log.push('after dispose'));
    expect(log).toEqual(['first', 'second', 'third', 'after dispose']);
  });
});

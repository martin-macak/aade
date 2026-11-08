import type { DisposableLike, IDisposable } from './disposable-types.ts';
import { reportError, throwCollected } from './errors.ts';
import { markDisposed, trackDisposable } from './tracker.ts';

/** Returns an object with both dispose() and [Symbol.dispose], so `using d = toDisposable(fn)` works. */
export function toDisposable(fn: () => void): IDisposable & Disposable {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  return {
    dispose: run,
    [Symbol.dispose]: run,
  };
}

export function isDisposable(value: unknown): value is DisposableLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const v = value as Record<PropertyKey, unknown>;
  return (
    typeof v['dispose'] === 'function' ||
    typeof v[Symbol.dispose] === 'function' ||
    typeof v[Symbol.asyncDispose] === 'function'
  );
}

/** Disposes in reverse order. Runs all, then throws AggregateError if any failed. */
export function disposeAll(items: Iterable<IDisposable>): void {
  const list = [...items];
  const errors: unknown[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  throwCollected(errors, 'Errors while disposing');
}

/** Prefers [Symbol.asyncDispose], then dispose(), then [Symbol.dispose]. Awaits the result. */
export async function disposeLike(value: DisposableLike): Promise<void> {
  const v = value as Record<PropertyKey, unknown>;
  if (typeof v[Symbol.asyncDispose] === 'function') {
    await (v[Symbol.asyncDispose] as () => Promise<void>).call(value);
  } else if (typeof v['dispose'] === 'function') {
    await (v['dispose'] as () => void | Promise<void>).call(value);
  } else if (typeof v[Symbol.dispose] === 'function') {
    (v[Symbol.dispose] as () => void).call(value);
  }
}

export class DisposableStore implements IDisposable, Disposable {
  /** A Set keeps insertion order and releases in O(1): a long-lived store with many short-lived entries does not grow. */
  readonly #items = new Set<IDisposable>();
  #disposed = false;
  readonly #name: string | undefined;

  constructor(name?: string) {
    this.#name = name;
    trackDisposable(this, name === undefined ? { kind: 'store' } : { kind: 'store', name });
  }

  /** Adds and returns d. If the store is already disposed, disposes d at once and reports a leak warning. */
  add<T extends IDisposable>(d: T): T {
    if ((d as unknown) === this) throw new Error('Cannot register a store with itself');
    if (this.#disposed) {
      reportError(new Error(`Disposable added to the disposed store${this.#name ? ` "${this.#name}"` : ''}; it is disposed at once`), {
        source: 'dispose',
      });
      try {
        d.dispose();
      } catch (error) {
        reportError(error, { source: 'dispose' });
      }
      return d;
    }
    this.#items.add(d);
    return d;
  }

  /** Removes d and disposes it. */
  delete(d: IDisposable): void {
    this.release(d);
    d.dispose();
  }

  /** Removes d without disposing it (ownership moves to the caller). */
  release(d: IDisposable): void {
    this.#items.delete(d);
  }

  /** Disposes everything now. The store stays usable. */
  clear(): void {
    if (this.#items.size === 0) return;
    const items = [...this.#items];
    this.#items.clear();
    disposeAll(items);
  }

  get size(): number {
    return this.#items.size;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Reverse insertion order. Errors are collected and thrown as one AggregateError at the end. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    markDisposed(this);
    this.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Base class for objects that own disposables. Subclasses call this.register(...). */
export abstract class DisposableObject implements IDisposable, Disposable {
  protected readonly store: DisposableStore = new DisposableStore(this.constructor.name);

  protected register<T extends IDisposable>(d: T): T {
    return this.store.add(d);
  }

  dispose(): void {
    this.store.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Holds one disposable. Setting a new value disposes the old one. */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  #value: T | undefined;
  #disposed = false;

  get value(): T | undefined {
    return this.#value;
  }

  set value(next: T | undefined) {
    if (this.#disposed || next === this.#value) {
      if (this.#disposed) next?.dispose();
      return;
    }
    const previous = this.#value;
    this.#value = next;
    previous?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const previous = this.#value;
    this.#value = undefined;
    previous?.dispose();
  }
}

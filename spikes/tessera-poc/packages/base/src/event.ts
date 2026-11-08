import { CancellationError } from './cancellation.ts';
import type { IDisposable } from './disposable-types.ts';
import { DisposableStore, toDisposable } from './disposable.ts';
import { reportError } from './errors.ts';
import { getScheduler, transactionGate } from './scheduler.ts';
import { markDisposed, trackDisposable } from './tracker.ts';

/** VS Code-style event: subscribe by calling it. Returns the subscription. */
export type Event<T> = (listener: (e: T) => void, options?: ListenOptions) => IDisposable;

export interface ListenOptions {
  /** The subscription is added to this store. */
  readonly store?: DisposableStore;
  /** The subscription ends when the signal aborts. */
  readonly signal?: AbortSignal;
  /** The subscription ends after the first event. */
  readonly once?: boolean;
}

export interface EventNamespace {
  readonly None: Event<never>;
  once<T>(event: Event<T>): Event<T>;
  map<T, U>(event: Event<T>, fn: (e: T) => U): Event<U>;
  filter<T>(event: Event<T>, predicate: (e: T) => boolean): Event<T>;
  any<T>(...events: Event<T>[]): Event<T>;
  debounce<T>(event: Event<T>, delayMs: number, merge?: (last: T | undefined, e: T) => T): Event<T>;
  toPromise<T>(event: Event<T>, signal?: AbortSignal): Promise<T>;
}

export const Event: EventNamespace = {
  None: () => toDisposable(() => {}),

  once<T>(event: Event<T>): Event<T> {
    return (listener, options) => event(listener, { ...options, once: true });
  },

  map<T, U>(event: Event<T>, fn: (e: T) => U): Event<U> {
    return (listener, options) => event((e) => listener(fn(e)), options);
  },

  filter<T>(event: Event<T>, predicate: (e: T) => boolean): Event<T> {
    return (listener, options) =>
      event((e) => {
        if (predicate(e)) listener(e);
      }, options);
  },

  any<T>(...events: Event<T>[]): Event<T> {
    return (listener, options) => {
      const store = new DisposableStore();
      for (const event of events) store.add(event(listener));
      return attachOptions(store, options);
    };
  },

  debounce<T>(event: Event<T>, delayMs: number, merge?: (last: T | undefined, e: T) => T): Event<T> {
    return (listener, options) => {
      const store = new DisposableStore();
      let last: T | undefined;
      let hasValue = false;
      let timer: IDisposable | undefined;
      store.add(
        event((e) => {
          last = merge ? merge(hasValue ? last : undefined, e) : e;
          hasValue = true;
          timer?.dispose();
          timer = getScheduler().timeout(() => {
            const value = last as T;
            last = undefined;
            hasValue = false;
            timer = undefined;
            listener(value);
          }, delayMs);
        }),
      );
      store.add(toDisposable(() => timer?.dispose()));
      return attachOptions(store, options);
    };
  },

  toPromise<T>(event: Event<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CancellationError());
        return;
      }
      const subscription = event(
        (value) => {
          subscription.dispose();
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        { once: true },
      );
      const onAbort = (): void => {
        subscription.dispose();
        reject(new CancellationError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

/** Applies store and signal options to a subscription and returns it. */
function attachOptions(subscription: IDisposable, options: ListenOptions | undefined): IDisposable {
  const handle = abortable(subscription, options?.signal);
  if (options?.store) options.store.add(handle);
  return handle;
}

/**
 * Ends `subscription` when `signal` aborts, and removes the abort listener when the subscription is disposed first. A long-lived
 * signal (the signal of a plugin lives as long as the plugin) otherwise keeps one listener per subscription that already ended.
 * Returns the handle to give to the caller: disposing it disposes the subscription and removes the listener.
 */
export function abortable(subscription: IDisposable, signal: AbortSignal | undefined): IDisposable {
  if (!signal) return subscription;
  if (signal.aborted) {
    subscription.dispose();
    return subscription;
  }
  const onAbort = (): void => subscription.dispose();
  signal.addEventListener('abort', onAbort, { once: true });
  return toDisposable(() => {
    signal.removeEventListener('abort', onAbort);
    subscription.dispose();
  });
}

export interface EmitterOptions {
  /** Name for traces and leak warnings. */
  readonly name?: string;
  readonly onFirstListenerAdd?: () => void;
  readonly onLastListenerRemove?: () => void;
  /** Warn when the listener count passes this value. Default 175 (VS Code default). */
  readonly leakWarningThreshold?: number;
  /** Receives listener errors. Default: reportError(e, { source: 'listener' }). */
  readonly onListenerError?: (error: unknown) => void;
  /** Default true: inside a transaction, fire() is deferred until commit (section 5.7). */
  readonly deferInTransaction?: boolean;
}

interface ListenerEntry<T> {
  fn: (e: T) => void;
  active: boolean;
}

export class Emitter<T> implements IDisposable {
  readonly #options: EmitterOptions;
  #listeners: ListenerEntry<T>[] = [];
  #disposed = false;
  #delivering = false;
  readonly #pending: T[] = [];
  #warned = false;
  #event: Event<T> | undefined;

  constructor(options?: EmitterOptions) {
    this.#options = options ?? {};
    trackDisposable(this, this.#options.name === undefined ? { kind: 'emitter' } : { kind: 'emitter', name: this.#options.name });
  }

  get event(): Event<T> {
    this.#event ??= (listener, options) => {
      if (this.#disposed) return toDisposable(() => {});
      const entry: ListenerEntry<T> = { fn: listener, active: true };
      const wasEmpty = this.#listeners.length === 0;
      // copy on write: a delivery in progress iterates its own snapshot
      this.#listeners = [...this.#listeners, entry];
      const threshold = this.#options.leakWarningThreshold ?? 175;
      if (this.#listeners.length > threshold && !this.#warned) {
        this.#warned = true;
        reportError(new Error(`Emitter${this.#options.name ? ` "${this.#options.name}"` : ''} has more than ${threshold} listeners: possible leak`), {
          source: 'listener',
        });
      }
      if (wasEmpty) this.#options.onFirstListenerAdd?.();
      const remove = (): void => {
        if (!entry.active) return;
        entry.active = false;
        this.#listeners = this.#listeners.filter((l) => l !== entry);
        if (this.#listeners.length === 0) this.#options.onLastListenerRemove?.();
      };
      if (options?.once) {
        const inner = entry.fn;
        entry.fn = (e) => {
          remove();
          inner(e);
        };
      }
      const subscription = attachOptions(toDisposable(remove), options);
      return subscription;
    };
    return this.#event;
  }

  get hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  get listenerCount(): number {
    return this.#listeners.length;
  }

  fire(event: T): void {
    if (this.#disposed) return;
    if (this.#options.deferInTransaction !== false && transactionGate.depth > 0) {
      transactionGate.defer(() => this.#fireNow(event));
      return;
    }
    this.#fireNow(event);
  }

  #fireNow(event: T): void {
    if (this.#disposed) return;
    this.#pending.push(event);
    if (this.#delivering) return; // re-entrant fire: delivered after the current delivery
    this.#delivering = true;
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift() as T;
        for (const entry of this.#listeners) {
          if (!entry.active) continue;
          try {
            entry.fn(next);
          } catch (error) {
            this.#handleError(error);
          }
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  #handleError(error: unknown): void {
    const onError = this.#options.onListenerError;
    if (onError) {
      try {
        onError(error);
      } catch (inner) {
        reportError(inner, { source: 'listener' });
      }
    } else {
      reportError(error, { source: 'listener', ...(this.#options.name !== undefined ? { target: this.#options.name } : {}) });
    }
  }

  /** Removes all listeners. Later fire() calls do nothing. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    markDisposed(this);
    for (const entry of this.#listeners) entry.active = false;
    this.#listeners = [];
    this.#pending.length = 0;
  }
}

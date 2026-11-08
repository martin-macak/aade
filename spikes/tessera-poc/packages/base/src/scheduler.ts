import type { IDisposable } from './disposable-types.ts';
import { reportError } from './errors.ts';

export type Delivery = 'sync' | 'microtask' | 'idle';

export interface IdleDeadlineLike {
  timeRemaining(): number;
  readonly didTimeout: boolean;
}

export interface Scheduler {
  now(): number;
  microtask(fn: () => void): void;
  /** Runs fn when the host is idle, or after timeoutMs at the latest. */
  idle(fn: (deadline: IdleDeadlineLike) => void, options?: { timeoutMs?: number }): IDisposable;
  timeout(fn: () => void, ms: number): IDisposable;
}

const IDLE_BUDGET_MS = 8;

/** Default: queueMicrotask, and setTimeout(0) with an 8 ms budget for idle. The DOM adapter installs requestIdleCallback. */
const defaultScheduler: Scheduler = {
  now: () => performance.now(),
  microtask: (fn) => queueMicrotask(fn),
  idle(fn, options) {
    const started = performance.now();
    const handle = setTimeout(
      () => {
        fn({
          didTimeout: false,
          timeRemaining: () => Math.max(0, IDLE_BUDGET_MS - (performance.now() - started)),
        });
      },
      0,
    );
    void options;
    return { dispose: () => clearTimeout(handle) };
  },
  timeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { dispose: () => clearTimeout(handle) };
  },
};

let current: Scheduler = defaultScheduler;

export function getScheduler(): Scheduler {
  return current;
}

export function setScheduler(scheduler: Scheduler): IDisposable {
  const previous = current;
  current = scheduler;
  return {
    dispose() {
      if (current === scheduler) current = previous;
    },
  };
}

/** Shared by Emitter, the event bus and transact(). One per realm. */
export interface TransactionGate {
  readonly depth: number;
  begin(): void;
  /** Ends the innermost transaction. On the outermost commit, runs deferred work in FIFO order. */
  end(commit: boolean): void;
  /** Outside a transaction runs fn now. Inside, queues it until the outermost commit. */
  defer(fn: () => void): void;
}

class Gate implements TransactionGate {
  readonly #queue: Array<() => void> = [];
  readonly #savepoints: number[] = [];
  #flushing = false;

  get depth(): number {
    return this.#savepoints.length;
  }

  begin(): void {
    this.#savepoints.push(this.#queue.length);
  }

  end(commit: boolean): void {
    const savepoint = this.#savepoints.pop();
    if (savepoint === undefined) throw new Error('transactionGate.end() without begin()');
    if (!commit) {
      this.#queue.length = Math.min(savepoint, this.#queue.length);
      return;
    }
    if (this.#savepoints.length === 0 && !this.#flushing) this.#flush();
  }

  defer(fn: () => void): void {
    if (this.#savepoints.length === 0 && !this.#flushing) {
      fn();
      return;
    }
    this.#queue.push(fn);
  }

  #flush(): void {
    this.#flushing = true;
    try {
      // The queue may grow while we flush: items deferred by a flushed item run in the same flush.
      for (let i = 0; i < this.#queue.length; i++) {
        try {
          this.#queue[i]?.();
        } catch (error) {
          reportError(error, { source: 'listener' });
        }
      }
    } finally {
      this.#queue.length = 0;
      this.#flushing = false;
    }
  }
}

export const transactionGate: TransactionGate = new Gate();

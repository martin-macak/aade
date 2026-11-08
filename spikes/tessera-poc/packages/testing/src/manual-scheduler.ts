import { setScheduler, toDisposable, type IDisposable, type IdleDeadlineLike, type Scheduler } from '@tessera/base';

interface TimerEntry {
  readonly seq: number;
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

interface IdleEntry {
  readonly seq: number;
  readonly fn: (deadline: IdleDeadlineLike) => void;
  readonly timeoutAt: number | undefined;
  cancelled: boolean;
}

export interface RunIdleOptions {
  /** What `deadline.timeRemaining()` returns while the callbacks run. Default 50. A function can lower it as work proceeds. */
  readonly timeRemaining?: number | (() => number);
}

/**
 * A scheduler under test control. Nothing runs by itself: call flushMicrotasks(), runIdle() or advance(ms).
 * No test in Tessera relies on real time.
 */
export class ManualScheduler implements Scheduler {
  #now = 0;
  #seq = 0;
  #microtasks: Array<() => void> = [];
  #timers: TimerEntry[] = [];
  #idles: IdleEntry[] = [];

  now(): number {
    return this.#now;
  }

  microtask(fn: () => void): void {
    this.#microtasks.push(fn);
  }

  idle(fn: (deadline: IdleDeadlineLike) => void, options?: { timeoutMs?: number }): IDisposable {
    const entry: IdleEntry = {
      seq: this.#seq++,
      fn,
      timeoutAt: options?.timeoutMs === undefined ? undefined : this.#now + options.timeoutMs,
      cancelled: false,
    };
    this.#idles.push(entry);
    return toDisposable(() => {
      entry.cancelled = true;
      this.#idles = this.#idles.filter((e) => e !== entry);
    });
  }

  timeout(fn: () => void, ms: number): IDisposable {
    const entry: TimerEntry = { seq: this.#seq++, at: this.#now + Math.max(0, ms), fn, cancelled: false };
    this.#timers.push(entry);
    return toDisposable(() => {
      entry.cancelled = true;
      this.#timers = this.#timers.filter((t) => t !== entry);
    });
  }

  /** Number of queued microtasks, idle callbacks and timers. */
  get pending(): number {
    return this.#microtasks.length + this.#idles.length + this.#timers.length;
  }

  get pendingMicrotasks(): number {
    return this.#microtasks.length;
  }

  get pendingIdle(): number {
    return this.#idles.length;
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Runs queued microtasks, including the ones they queue. */
  flushMicrotasks(): void {
    let guard = 0;
    while (this.#microtasks.length > 0) {
      if (++guard > 100_000) throw new Error('ManualScheduler: microtask loop');
      const batch = this.#microtasks;
      this.#microtasks = [];
      for (const fn of batch) fn();
    }
  }

  /** Runs the idle callbacks queued right now (callbacks queued by them wait for the next call). */
  runIdle(options?: RunIdleOptions): void {
    this.flushMicrotasks();
    const remaining = options?.timeRemaining ?? 50;
    const batch = this.#idles;
    this.#idles = [];
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i] as IdleEntry;
      if (entry.cancelled) continue;
      entry.fn({ didTimeout: false, timeRemaining: typeof remaining === 'function' ? remaining : () => remaining });
      this.flushMicrotasks();
    }
  }

  /** Moves time forward. Timers fire in time order; idle callbacks whose timeout elapsed run with didTimeout true. */
  advance(ms: number): void {
    const target = this.#now + ms;
    this.flushMicrotasks();
    for (;;) {
      const dueTimer = this.#timers.filter((t) => t.at <= target).toSorted((a, b) => a.at - b.at || a.seq - b.seq)[0];
      const dueIdle = this.#idles
        .filter((e) => e.timeoutAt !== undefined && e.timeoutAt <= target)
        .toSorted((a, b) => (a.timeoutAt as number) - (b.timeoutAt as number) || a.seq - b.seq)[0];
      if (dueTimer === undefined && dueIdle === undefined) break;
      const timerAt = dueTimer?.at ?? Number.POSITIVE_INFINITY;
      const idleAt = dueIdle?.timeoutAt ?? Number.POSITIVE_INFINITY;
      if (timerAt <= idleAt && dueTimer !== undefined) {
        this.#now = Math.max(this.#now, dueTimer.at);
        this.#timers = this.#timers.filter((t) => t !== dueTimer);
        if (!dueTimer.cancelled) dueTimer.fn();
      } else if (dueIdle !== undefined) {
        this.#now = Math.max(this.#now, dueIdle.timeoutAt as number);
        this.#idles = this.#idles.filter((e) => e !== dueIdle);
        if (!dueIdle.cancelled) dueIdle.fn({ didTimeout: true, timeRemaining: () => 0 });
      }
      this.flushMicrotasks();
    }
    this.#now = target;
  }

  /** Runs everything that is queued now: microtasks, then idle callbacks. Timers need advance(). */
  tick(): void {
    this.flushMicrotasks();
    this.runIdle();
  }

  /** Makes this scheduler the process-wide one (getScheduler()) until the returned handle is disposed. */
  install(): IDisposable {
    return setScheduler(this);
  }
}

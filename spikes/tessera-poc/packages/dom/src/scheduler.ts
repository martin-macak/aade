import { toDisposable, type IdleDeadlineLike, type Scheduler } from '@tessera/base';

type IdleWindow = Window & {
  requestIdleCallback?: (fn: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** requestIdleCallback-based Scheduler for a DOM window. Falls back to a timeout where the API is missing (Safari, jsdom). */
export function domScheduler(view: Window): Scheduler {
  const w = view as IdleWindow;
  return {
    now: () => view.performance.now(),
    microtask: (fn) => queueMicrotask(fn),
    idle(fn, options) {
      if (typeof w.requestIdleCallback === 'function') {
        const handle = w.requestIdleCallback(fn, options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs });
        return toDisposable(() => w.cancelIdleCallback?.(handle));
      }
      const started = view.performance.now();
      const handle = view.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => Math.max(0, 8 - (view.performance.now() - started)) }), 0);
      return toDisposable(() => view.clearTimeout(handle));
    },
    timeout(fn, ms) {
      const handle = view.setTimeout(fn, ms);
      return toDisposable(() => view.clearTimeout(handle));
    },
  };
}

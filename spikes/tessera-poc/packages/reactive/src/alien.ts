import * as A from 'alien-signals';
import type { EngineComputed, EngineState, ReactiveEngine } from './engine.ts';

function untrackedRun<R>(fn: () => R): R {
  const previous = A.setActiveSub(undefined);
  try {
    return fn();
  } finally {
    A.setActiveSub(previous);
  }
}

/**
 * Drop-in alternative engine on alien-signals 3.2.1. Import it from '@tessera/reactive/alien' and pass it to
 * installReactiveEngine() before the first node is created. alien-signals is an optional peer dependency.
 */
export const alienEngine: ReactiveEngine = {
  id: 'alien-signals',
  state<T>(initial: T): EngineState<T> {
    const s = A.signal<T>(initial);
    return {
      read: () => s(),
      peek: () => untrackedRun(() => s()),
      write: (value) => {
        s(value);
      },
    };
  },
  computed<T>(fn: () => T): EngineComputed<T> {
    const c = A.computed<T>(() => fn());
    return { read: () => c(), peek: () => untrackedRun(() => c()) };
  },
  effect(fn) {
    let cleanup: void | (() => void);
    const stop = A.effect(() => {
      if (typeof cleanup === 'function') {
        const previous = cleanup;
        cleanup = undefined;
        untrackedRun(previous);
      }
      cleanup = fn();
    });
    return () => {
      stop();
      if (typeof cleanup === 'function') {
        const previous = cleanup;
        cleanup = undefined;
        untrackedRun(previous);
      }
    };
  },
  batch<R>(fn: () => R): R {
    A.startBatch();
    try {
      return fn();
    } finally {
      A.endBatch();
    }
  },
  untracked: untrackedRun,
};

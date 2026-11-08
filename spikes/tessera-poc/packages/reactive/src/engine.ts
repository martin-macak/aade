import { TesseraError, toDisposable, type IDisposable } from '@tessera/base';
import * as P from '@preact/signals-core';

export interface EngineState<T> {
  read(): T;
  peek(): T;
  write(value: T): void;
}
export interface EngineComputed<T> {
  read(): T;
  peek(): T;
}

export interface ReactiveEngine {
  /** 'preact-signals-core', 'alien-signals' */
  readonly id: string;
  state<T>(initial: T): EngineState<T>;
  computed<T>(fn: () => T): EngineComputed<T>;
  /** Returns stop. */
  effect(fn: () => void | (() => void)): () => void;
  batch<R>(fn: () => R): R;
  untracked<R>(fn: () => R): R;
}

/** The default engine: @preact/signals-core. */
export const preactEngine: ReactiveEngine = {
  id: 'preact-signals-core',
  state<T>(initial: T): EngineState<T> {
    const s = P.signal(initial);
    return {
      read: () => s.value,
      peek: () => s.peek(),
      write: (value) => {
        s.value = value;
      },
    };
  },
  computed<T>(fn: () => T): EngineComputed<T> {
    const c = P.computed(fn);
    return { read: () => c.value, peek: () => c.peek() };
  },
  effect: (fn) => P.effect(fn),
  batch: (fn) => P.batch(fn),
  untracked: (fn) => P.untracked(fn),
};

let engine: ReactiveEngine | undefined;
let locked = false;

/**
 * Must be called before the first node is created. Throws 'reactive.engineLocked' afterwards.
 * Returns the restore: disposing it puts the previous engine and the previous lock state back, so an application that installed an engine
 * leaves the realm as it found it (the shell disposes it with the application).
 */
export function installReactiveEngine(next: ReactiveEngine): IDisposable {
  if (locked) {
    throw new TesseraError('reactive.engineLocked', `Cannot install reactive engine "${next.id}": engine "${engine?.id}" is already in use`);
  }
  const previous = engine;
  const wasLocked = locked;
  engine = next;
  return toDisposable(() => {
    if (engine !== next) return; // another install replaced it meanwhile: leave that one alone
    engine = previous;
    locked = wasLocked;
  });
}

/** Returns the engine and locks the choice. Called when a node is created. */
export function useEngine(): ReactiveEngine {
  engine ??= preactEngine;
  locked = true;
  return engine;
}

/** Returns the engine without locking (diagnostics). */
export function peekEngineId(): string {
  return (engine ?? preactEngine).id;
}

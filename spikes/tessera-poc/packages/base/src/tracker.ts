import type { IDisposable } from './disposable-types.ts';

export interface TrackedInfo {
  readonly kind: string;
  readonly name?: string;
}

/**
 * Leak tracking hook (VS Code `IDisposableTracker`). `@tessera/testing` installs one for `leakCheck()`.
 * Kernel objects that own resources call `trackDisposable` when they are created and `markDisposed` when they end.
 */
export interface DisposableTracker {
  trackDisposable(target: object, info: TrackedInfo): void;
  markDisposed(target: object): void;
}

let tracker: DisposableTracker | undefined;

export function setDisposableTracker(next: DisposableTracker | undefined): IDisposable {
  const previous = tracker;
  tracker = next;
  return {
    dispose() {
      if (tracker === next) tracker = previous;
    },
  };
}

export function trackDisposable(target: object, info: TrackedInfo): void {
  tracker?.trackDisposable(target, info);
}

export function markDisposed(target: object): void {
  tracker?.markDisposed(target);
}

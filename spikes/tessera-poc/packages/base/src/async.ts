import { TesseraError } from './errors.ts';
import { getScheduler } from './scheduler.ts';

export class DeferredPromise<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (error: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  reject(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }

  get settled(): boolean {
    return this.#settled;
  }
}

export class Barrier {
  #open = false;
  readonly #deferred = new DeferredPromise<void>();

  open(): void {
    this.#open = true;
    this.#deferred.resolve();
  }

  wait(): Promise<void> {
    return this.#deferred.promise;
  }

  get isOpen(): boolean {
    return this.#open;
  }
}

/** Rejects with TesseraError('timeout') after ms. Does not cancel the work: pass a signal for that. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = getScheduler().timeout(() => {
      reject(new TesseraError('timeout', `${what} timed out after ${ms} ms`, { details: { ms, what } }));
    }, ms);
    promise.then(
      (value) => {
        timer.dispose();
        resolve(value);
      },
      (error: unknown) => {
        timer.dispose();
        reject(error);
      },
    );
  });
}

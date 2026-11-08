import { TesseraError } from './errors.ts';

export class CancellationError extends TesseraError {
  constructor(message = 'Operation cancelled', options?: { cause?: unknown }) {
    super('cancelled', message, options);
    this.name = 'AbortError';
  }
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof CancellationError || (error instanceof Error && error.name === 'AbortError');
}

/** Throws CancellationError if aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancellationError();
}

/** Rejects with CancellationError when the signal aborts first. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

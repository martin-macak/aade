import { toDisposable, type IDisposable } from '@tessera/base';
import { effect, isComputing, state, untracked, type Observable } from './facade.ts';

export type Resource<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly previous?: T }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: unknown; readonly previous?: T };

export interface ResourceHandle<T> extends IDisposable {
  readonly state: Observable<Resource<T>>;
  /** Aborts the running load (if any) and starts a new one. */
  reload(): void;
  abort(): void;
}

/**
 * Loads with an AbortSignal. If `deps` is given, reloads when the observables it reads change.
 * dispose() aborts the running load. A lazy resource starts on the first read of `state` or on reload().
 */
export function resource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options?: { readonly name?: string; readonly deps?: () => unknown; readonly lazy?: boolean },
): ResourceHandle<T> {
  const current = state<Resource<T>>({ status: 'idle' }, options?.name === undefined ? {} : { name: options.name });
  let controller: AbortController | undefined;
  let runId = 0;
  let started = false;
  let disposed = false;
  let lastValue: { readonly value: T } | undefined;
  let startQueued = false;

  const run = (): void => {
    if (disposed) return;
    started = true;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const id = ++runId;
    current.set(lastValue ? { status: 'pending', previous: lastValue.value } : { status: 'pending' });
    let promise: Promise<T>;
    try {
      promise = load(mine.signal);
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (value) => {
        if (id !== runId || disposed) return;
        lastValue = { value };
        current.set({ status: 'ready', value });
      },
      (error: unknown) => {
        if (id !== runId || disposed || mine.signal.aborted) return;
        current.set(lastValue ? { status: 'error', error, previous: lastValue.value } : { status: 'error', error });
      },
    );
  };

  const ensureStarted = (): void => {
    if (started || disposed) return;
    // Reading inside a computed or a render: state may not be written there (reactive.writeInComputed). The start waits for a
    // microtask and the read sees 'idle'; the write of 'pending' and then 'ready' updates the reader.
    if (isComputing()) {
      if (!startQueued) {
        startQueued = true;
        queueMicrotask(() => {
          startQueued = false;
          if (!started && !disposed) untracked(run);
        });
      }
      return;
    }
    untracked(run);
  };

  const depsEffect: IDisposable | undefined =
    options?.deps !== undefined
      ? effect(
          () => {
            options.deps?.();
            if (options.lazy && !started) {
              return;
            }
            untracked(run);
          },
          { name: options.name === undefined ? 'resource.deps' : `${options.name}.deps` },
        )
      : undefined;

  if (options?.deps === undefined && !options?.lazy) run();

  const view: Observable<Resource<T>> = {
    name: options?.name,
    get() {
      ensureStarted();
      return current.get();
    },
    peek() {
      ensureStarted();
      return current.peek();
    },
    subscribe(listener) {
      ensureStarted();
      return current.subscribe(listener);
    },
  };

  return {
    state: view,
    reload: () => untracked(run),
    abort() {
      runId++;
      controller?.abort();
      controller = undefined;
      if (current.peek().status === 'pending') {
        current.set(lastValue ? { status: 'ready', value: lastValue.value } : { status: 'idle' });
      }
    },
    ...toDisposable(() => {
      if (disposed) return;
      disposed = true;
      runId++;
      controller?.abort();
      depsEffect?.dispose();
    }),
  };
}

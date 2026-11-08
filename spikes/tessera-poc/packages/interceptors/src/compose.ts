import { DeferredPromise, getScheduler, reportError, type IDisposable } from '@tessera/base';
import { InterceptorError } from './errors.ts';
import type { InvocationContext, InvocationKind, Interceptor, Next } from './types.ts';

/**
 * Koa-style onion. chain[0] is outermost. Guards against: next called twice, a missing await (the interceptor
 * settles before the downstream work does), and errors of the interceptor itself (wrapped in InterceptorError).
 */
export function compose<K extends InvocationKind, R>(
  chain: readonly Interceptor<K, R>[],
  terminal: (ctx: InvocationContext<K>) => Promise<R>,
): (ctx: InvocationContext<K>) => Promise<R> {
  const dispatch = (index: number, ctx: InvocationContext<K>): Promise<R> => {
    const interceptor = chain[index];
    if (interceptor === undefined) return terminal(ctx);

    let nextCalls = 0;
    let nextTwice: InterceptorError | undefined;
    let downstream: Promise<R> | undefined;
    let downstreamSettled = false;
    let downstreamError: { readonly error: unknown } | undefined;

    const next: Next<K, R> = (nextCtx) => {
      if (++nextCalls > 1) {
        nextTwice ??= new InterceptorError('interceptor.nextTwice', `Interceptor "${interceptor.id}" called next() more than once for ${ctx.kind} "${ctx.target}"`, interceptor.id);
        const rejected = Promise.reject(nextTwice);
        rejected.catch(() => {}); // the interceptor may ignore it; the invocation still fails below
        return rejected;
      }
      let promise: Promise<R>;
      try {
        promise = dispatch(index + 1, nextCtx ?? ctx);
      } catch (error) {
        promise = Promise.reject(error);
      }
      downstream = promise;
      promise.then(
        () => {
          downstreamSettled = true;
        },
        (error: unknown) => {
          downstreamSettled = true;
          downstreamError = { error };
        },
      );
      return promise;
    };

    let own: Promise<R>;
    try {
      own = interceptor.intercept(ctx, next);
    } catch (error) {
      own = Promise.reject(error);
    }
    return Promise.resolve(own).then(
      (value) => {
        if (nextTwice !== undefined) return Promise.reject(nextTwice) as Promise<R>;
        if (downstream !== undefined && !downstreamSettled) {
          return Promise.reject(
            new InterceptorError(
              'interceptor.missingAwait',
              `Interceptor "${interceptor.id}" finished before the work behind next() did, for ${ctx.kind} "${ctx.target}". Await next().`,
              interceptor.id,
            ),
          ) as Promise<R>;
        }
        return value;
      },
      (error: unknown) => {
        if (error instanceof InterceptorError) throw error; // a pipeline failure (own or another interceptor's) passes through
        if (downstreamError !== undefined && downstreamError.error === error) throw error; // the downstream error, unchanged
        throw new InterceptorError('interceptor.failed', `Interceptor "${interceptor.id}" failed for ${ctx.kind} "${ctx.target}": ${describe(error)}`, interceptor.id, { cause: error });
      },
    );
  };
  return (ctx) => dispatch(0, ctx);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The default time an observer interceptor may take on its own (not counting the work behind next()). */
export const DEFAULT_OBSERVER_BUDGET_MS = 200;

export interface IsolateOptions {
  /** Default 200 ms. The time before next() is called and after it settled counts; the time behind next() does not. */
  readonly budgetMs?: number;
  /** Asked on every expiry; false skips the report (the registry reports once per interceptor, not once per invocation). */
  readonly shouldReport?: (interceptorId: string) => boolean;
}

/**
 * A time budget for the code of one interceptor. The clock runs while the interceptor is in control and stops while it waits
 * for next(). `expired` resolves when the budget is used up or the invocation is aborted.
 */
function createBudget(ms: number, signal: AbortSignal): { readonly expired: Promise<'timeout' | 'aborted'>; pause(): void; resume(): void; dispose(): void } {
  const expired = new DeferredPromise<'timeout' | 'aborted'>();
  const scheduler = getScheduler();
  let spent = 0;
  let armedAt = scheduler.now();
  let timer: IDisposable | undefined = scheduler.timeout(() => expired.resolve('timeout'), ms);
  const onAbort = (): void => expired.resolve('aborted');
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    expired: expired.promise,
    pause() {
      if (!timer) return;
      spent += scheduler.now() - armedAt;
      timer.dispose();
      timer = undefined;
    },
    resume() {
      if (timer || expired.settled) return;
      armedAt = scheduler.now();
      timer = scheduler.timeout(() => expired.resolve('timeout'), Math.max(0, ms - spent));
    },
    dispose() {
      timer?.dispose();
      timer = undefined;
      signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Wraps an interceptor so that it can never change the outcome (observer mode). If it throws before it calls
 * next, the wrapper calls next itself. If it throws after next returned, the wrapper returns the stored result or
 * rethrows the stored error. It cannot skip next, change the input or change the result. Its errors are reported.
 * It cannot hold the pipeline either: if its own code takes longer than the budget (200 ms by default, or the invocation
 * is aborted), the wrapper calls next itself, reports 'interceptor.observerTimeout' and does not wait for the observer's tail.
 */
export function isolate<K extends InvocationKind, R>(interceptor: Interceptor<K, R>, options?: IsolateOptions): Interceptor<K, R> {
  const budgetMs = options?.budgetMs ?? DEFAULT_OBSERVER_BUDGET_MS;
  const isolated: Interceptor<K, R> = {
    id: interceptor.id,
    kinds: interceptor.kinds,
    phase: interceptor.phase ?? 'transform',
    order: interceptor.order ?? 0,
    mode: 'observer',
    async intercept(ctx, next) {
      let downstream: Promise<R> | undefined;
      const budget = createBudget(budgetMs, ctx.signal);
      const observed: Next<K, R> = () => {
        if (downstream === undefined) {
          budget.pause(); // the time behind next() is the command's, not the observer's
          downstream = next();
          const resume = (): void => budget.resume();
          downstream.then(resume, resume);
        }
        return downstream; // a second call returns the same promise: next-twice is the observer's problem, not the pipeline's
      };
      const report = (error: unknown): void =>
        reportError(error, {
          source: 'interceptor',
          target: ctx.target,
          ...(interceptor.owner !== undefined ? { pluginId: interceptor.owner } : {}),
          details: { interceptorId: interceptor.id },
        });
      let own: Promise<'done'>;
      try {
        own = Promise.resolve(interceptor.intercept(ctx, observed)).then(
          () => 'done' as const,
          (error: unknown) => {
            report(error);
            return 'done' as const;
          },
        );
      } catch (error) {
        report(error);
        own = Promise.resolve('done' as const);
      }
      try {
        const outcome = await Promise.race([own, budget.expired]);
        if (outcome !== 'done') {
          if (options?.shouldReport?.(interceptor.id) !== false) report(new InterceptorError('interceptor.observerTimeout', `Observer interceptor "${interceptor.id}" did not finish in ${budgetMs} ms for ${ctx.kind} "${ctx.target}"; the pipeline went on without it`, interceptor.id));
        }
      } finally {
        budget.dispose();
      }
      return (downstream ??= next());
    },
  };
  return Object.assign(isolated, {
    ...(interceptor.match !== undefined ? { match: interceptor.match } : {}),
    ...(interceptor.owner !== undefined ? { owner: interceptor.owner } : {}),
  });
}

/**
 * Wraps a guard that has a `timeoutMs`: the guard's own time (before it calls next) is limited. On expiry the invocation
 * rejects with 'interceptor.guardTimeout' (a guard that cannot decide does not let the invocation through).
 */
export function limitGuard<K extends InvocationKind, R>(interceptor: Interceptor<K, R>, timeoutMs: number): Interceptor<K, R> {
  const limited: Interceptor<K, R> = {
    ...interceptor,
    async intercept(ctx, next) {
      const budget = createBudget(timeoutMs, ctx.signal);
      const timed: Next<K, R> = (nextCtx) => {
        budget.pause();
        const promise = next(nextCtx);
        const resume = (): void => budget.resume();
        promise.then(resume, resume);
        return promise;
      };
      try {
        const own = Promise.resolve().then(() => interceptor.intercept(ctx, timed));
        const guard = budget.expired.then((why): never => {
          throw new InterceptorError('interceptor.guardTimeout', `Guard "${interceptor.id}" did not decide in ${timeoutMs} ms (${why}) for ${ctx.kind} "${ctx.target}"`, interceptor.id);
        });
        guard.catch(() => undefined);
        return await Promise.race([own, guard]);
      } finally {
        budget.dispose();
      }
    },
  };
  return limited;
}

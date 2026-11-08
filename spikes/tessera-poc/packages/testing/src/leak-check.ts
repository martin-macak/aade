import { setDisposableTracker, type DisposableTracker, type IDisposable, type TrackedInfo } from '@tessera/base';
import { reactiveDebug } from '@tessera/reactive';

interface Live {
  readonly info: TrackedInfo;
  readonly stack: string | undefined;
  readonly ref: WeakRef<object>;
}

const live = new Map<object, Live>();
let installed: IDisposable | undefined;
/** Reactive counters when tracking was reset: a leak is a rise above this baseline, so one leaky test fails alone. */
let baseline = { subscriptions: 0, effects: 0 };

const tracker: DisposableTracker = {
  trackDisposable(target, info) {
    live.set(target, { info, stack: new Error('created here').stack, ref: new WeakRef(target) });
  },
  markDisposed(target) {
    live.delete(target);
  },
};

/** Starts leak tracking (idempotent). The Vitest setup file calls it, so every suite is covered. */
export function startLeakTracking(): void {
  installed ??= setDisposableTracker(tracker);
}

export function stopLeakTracking(): void {
  installed?.dispose();
  installed = undefined;
  live.clear();
}

function snapshotBaseline(): void {
  baseline = { subscriptions: reactiveDebug.liveSubscriptions(), effects: reactiveDebug.liveEffects() };
}

export interface LeakReport {
  /** Objects that were created and never disposed. Emitters count only when they still have listeners. */
  readonly undisposed: ReadonlyArray<{ readonly kind: string; readonly name: string | undefined; readonly stack: string | undefined }>;
  readonly liveSubscriptions: number;
  readonly liveEffects: number;
}

function hasListeners(target: object): boolean {
  const candidate = target as { hasListeners?: unknown };
  return typeof candidate.hasListeners === 'boolean' ? candidate.hasListeners : true;
}

export function collectLeaks(): LeakReport {
  const undisposed: Array<{ kind: string; name: string | undefined; stack: string | undefined }> = [];
  for (const [target, entry] of live) {
    if (entry.info.kind === 'emitter' && !hasListeners(target)) continue;
    undisposed.push({ kind: entry.info.kind, name: entry.info.name, stack: entry.stack });
  }
  return {
    undisposed,
    liveSubscriptions: reactiveDebug.liveSubscriptions() - baseline.subscriptions,
    liveEffects: reactiveDebug.liveEffects() - baseline.effects,
  };
}

/** Forgets everything tracked so far. Call it in a test that creates leaks on purpose. */
export function resetLeakTracking(): void {
  live.clear();
  snapshotBaseline();
}

export class LeakError extends Error {
  readonly report: LeakReport;
  constructor(message: string, report: LeakReport) {
    super(message);
    this.name = 'LeakError';
    this.report = report;
  }
}

/**
 * Asserts that nothing is left alive after teardown: no undisposed DisposableStore, DI scope or Emitter with
 * listeners, and zero live reactive subscriptions and effects. Runs in afterEach of every suite.
 * It resets its tracking after it reports, so one leak fails one test only.
 */
export function leakCheck(): void {
  startLeakTracking();
  const report = collectLeaks();
  const problems: string[] = [];
  if (report.liveSubscriptions > 0) problems.push(`${report.liveSubscriptions} live reactive subscription(s)`);
  if (report.liveEffects > 0) problems.push(`${report.liveEffects} live effect(s)`);
  for (const item of report.undisposed) {
    problems.push(`undisposed ${item.kind}${item.name ? ` "${item.name}"` : ''}${item.stack ? `\n${item.stack.split('\n').slice(1, 6).join('\n')}` : ''}`);
  }
  if (problems.length > 0) {
    resetLeakTracking();
    throw new LeakError(`leakCheck found leaks:\n${problems.join('\n')}`, report);
  }
}

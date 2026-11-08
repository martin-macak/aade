import {
  DeferredPromise,
  Emitter,
  TesseraError,
  getScheduler,
  reportError,
  toDisposable,
  type Event,
  type IDisposable,
} from '@tessera/base';
import {
  CoreTopics,
  LifecyclePhase,
  SHUTDOWN_ORDER,
  type BeforeShutdownEvent,
  type EventNode,
  type LifecycleOptions,
  type LifecycleService,
  type ShutdownReason,
  type ShutdownResult,
  type ShutdownState,
  type ShutdownStep,
  type ShutdownStepReport,
  type WillShutdownEvent,
} from '@tessera/contracts';
import { state, type Observable, type State } from '@tessera/reactive';

export const DEFAULT_LIFECYCLE_OPTIONS: LifecycleOptions = {
  contributionBudgetMs: 5000,
  vetoNoticeMs: 3000,
  joinTimeoutMs: 3000,
  eventuallyDelayMs: 2500,
  phaseBudgetMs: 5000,
  disposeBudgetMs: 5000,
  finalFlushFloorMs: 1000,
  appDisposeFloorMs: 500,
  firstPaintBudgetMs: 800,
  restoredBudgetMs: 1500,
};

export interface LifecycleServiceInit {
  readonly options?: Partial<LifecycleOptions>;
  /** Publishes CoreTopics.lifecyclePhase when given. */
  readonly node?: EventNode;
}

interface VetoEntry {
  readonly id: string;
  readonly result: Promise<boolean>;
}

/** The one veto phase in flight. Callers join it; a force call resolves it with no vetoes. */
interface VetoPhase {
  readonly promise: Promise<string[]>;
  escalate(): void;
}

/** A step gets its deadline minus this much, so a step that bounds itself ends (and reports) before the runner's backstop fires at the deadline. */
const BACKSTOP_GRACE_MS = 50;

/** Phases, veto and join shutdown (contracts.md section 8). */
export class DefaultLifecycleService implements LifecycleService, IDisposable {
  readonly phase: Observable<LifecyclePhase>;
  readonly shutdownState: Observable<ShutdownState>;
  readonly onSlowVeto: Event<{ readonly pending: readonly string[] }>;
  readonly options: LifecycleOptions;

  readonly #phase: State<LifecyclePhase>;
  readonly #state: State<ShutdownState>;
  readonly #slow = new Emitter<{ readonly pending: readonly string[] }>({ name: 'lifecycle.slowVeto', deferInTransaction: false });
  readonly #barriers = new Map<LifecyclePhase, DeferredPromise<void>>();
  readonly #beforeHandlers: Array<(e: BeforeShutdownEvent) => void> = [];
  readonly #willHandlers: Array<(e: WillShutdownEvent) => void> = [];
  readonly #node: EventNode | undefined;
  readonly #steps: ShutdownStep[] = [];
  #running: Promise<ShutdownResult> | undefined;
  #vetoPhase: VetoPhase | undefined;

  constructor(init?: LifecycleServiceInit) {
    this.options = { ...DEFAULT_LIFECYCLE_OPTIONS, ...init?.options };
    this.#node = init?.node;
    this.#phase = state<LifecyclePhase>(LifecyclePhase.Starting, { name: 'lifecycle.phase' });
    this.#state = state<ShutdownState>('running', { name: 'lifecycle.shutdownState' });
    this.phase = this.#phase.asReadonly();
    this.shutdownState = this.#state.asReadonly();
    this.onSlowVeto = this.#slow.event;
  }

  registerShutdownStep(step: ShutdownStep): IDisposable {
    if (this.#steps.some((s) => s.id === step.id)) {
      throw new TesseraError('lifecycle.duplicateShutdownStep', `A shutdown step with id "${step.id}" is already registered`, { details: { id: step.id } });
    }
    this.#steps.push(step);
    return toDisposable(() => {
      const index = this.#steps.indexOf(step);
      if (index >= 0) this.#steps.splice(index, 1);
    });
  }

  when(phase: LifecyclePhase): Promise<void> {
    if (this.#phase.peek() >= phase) return Promise.resolve();
    let barrier = this.#barriers.get(phase);
    if (!barrier) {
      barrier = new DeferredPromise<void>();
      this.#barriers.set(phase, barrier);
    }
    return barrier.promise;
  }

  setPhase(phase: LifecyclePhase): void {
    const current = this.#phase.peek();
    if (phase < current) {
      throw new TesseraError('lifecycle.backwards', `Lifecycle phase cannot go backwards (${current} to ${phase})`, { details: { from: current, to: phase } });
    }
    if (phase === current) return;
    this.#phase.set(phase);
    for (const [barrierPhase, barrier] of [...this.#barriers]) {
      if (barrierPhase <= phase) {
        barrier.resolve();
        this.#barriers.delete(barrierPhase);
      }
    }
    try {
      this.#node?.publish(CoreTopics.lifecyclePhase, { phase });
    } catch (error) {
      reportError(error, { source: 'lifecycle', target: 'phase' });
    }
  }

  onBeforeShutdown(handler: (e: BeforeShutdownEvent) => void): IDisposable {
    this.#beforeHandlers.push(handler);
    return toDisposable(() => {
      const index = this.#beforeHandlers.indexOf(handler);
      if (index >= 0) this.#beforeHandlers.splice(index, 1);
    });
  }

  onWillShutdown(handler: (e: WillShutdownEvent) => void): IDisposable {
    this.#willHandlers.push(handler);
    return toDisposable(() => {
      const index = this.#willHandlers.indexOf(handler);
      if (index >= 0) this.#willHandlers.splice(index, 1);
    });
  }

  checkVeto(reason: ShutdownReason): Promise<ShutdownResult> {
    if (this.#isPastVeto()) return Promise.resolve({ vetoed: false, vetoedBy: [], timedOut: [] });
    return this.#joinVeto(reason).promise.then((vetoedBy) => ({ vetoed: vetoedBy.length > 0, vetoedBy, timedOut: [] }));
  }

  shutdown(reason: ShutdownReason, options?: { readonly force?: boolean }): Promise<ShutdownResult> {
    const force = options?.force === true;
    if (this.#running) {
      // One rule for concurrent calls: join the run in flight. A force call escalates it (the pending veto step ends with no vetoes).
      if (force) this.#vetoPhase?.escalate();
      return this.#running;
    }
    if (this.#isPastVeto()) return Promise.resolve({ vetoed: false, vetoedBy: [], timedOut: [] });
    const run = this.#shutdown(reason, force);
    this.#running = run;
    void run.then(
      (result) => {
        if (result.vetoed) this.#running = undefined;
      },
      () => {
        this.#running = undefined;
      },
    );
    return run;
  }

  /** In joining, disposing and done the veto is over: a later call has nothing to veto. */
  #isPastVeto(): boolean {
    const current = this.#state.peek();
    return current === 'joining' || current === 'disposing' || current === 'done';
  }

  /** The memoised veto phase: concurrent callers share one run of the beforeShutdown handlers. */
  #joinVeto(reason: ShutdownReason): VetoPhase {
    if (this.#vetoPhase) return this.#vetoPhase;
    const forced = new DeferredPromise<string[]>();
    const phase: VetoPhase = {
      promise: Promise.race([this.#veto(reason), forced.promise]).finally(() => {
        if (this.#vetoPhase === phase) this.#vetoPhase = undefined;
        if (this.#state.peek() === 'vetoing') this.#state.set('running');
      }),
      escalate: () => forced.resolve([]),
    };
    this.#vetoPhase = phase;
    return phase;
  }

  async #shutdown(reason: ShutdownReason, force: boolean): Promise<ShutdownResult> {
    if (force) this.#vetoPhase?.escalate();
    else {
      const vetoedBy = await this.#joinVeto(reason).promise;
      if (vetoedBy.length > 0) return { vetoed: true, vetoedBy, timedOut: [] };
    }
    this.#state.set('joining');
    const { timedOut, failed } = await this.#join(reason);
    this.#state.set('disposing');
    const steps = await this.#runSteps();
    for (const id of steps.failed) if (!failed.includes(id)) failed.push(id);
    const overruns = steps.timedOut;
    const notStarted = steps.notStarted;
    this.#state.set('done');
    return {
      vetoed: false,
      vetoedBy: [],
      timedOut: [...timedOut, ...overruns],
      ...(failed.length > 0 ? { failed } : {}),
      ...(notStarted.length > 0 ? { notStarted } : {}),
    };
  }

  /**
   * The dispose phase: close the gate (every step's close(), synchronously), then run the steps by order against one deadline.
   * A step at order 600 or more gets a floor (final flush, application dispose) even when the budget is spent, so the total
   * is bounded by disposeBudgetMs plus the floors (I32). A step that throws gives lifecycle.shutdownStepFailed and the next one runs.
   */
  async #runSteps(): Promise<{ timedOut: string[]; failed: string[]; notStarted: string[] }> {
    const timedOut = new Set<string>();
    const failed = new Set<string>();
    const notStarted = new Set<string>();
    // The list is taken now: a step of a window-scope module still runs after an earlier step disposed its scope.
    const steps = this.#steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.order - b.step.order || a.index - b.index).map((e) => e.step);
    for (const step of steps) {
      try {
        step.close?.();
      } catch (error) {
        reportError(new TesseraError('lifecycle.shutdownStepFailed', `Shutdown step "${step.id}" failed in close()`, { cause: error, details: { id: step.id, phase: 'close' } }), { source: 'lifecycle', target: `shutdown.${step.id}` });
        failed.add(step.id);
      }
    }
    const scheduler = getScheduler();
    const until = scheduler.now() + this.options.disposeBudgetMs;
    for (const step of steps) {
      // Floors: the final flush and the application dispose get a little time even when the budget is spent. The caps keep the total at
      // disposeBudgetMs + finalFlushFloorMs + appDisposeFloorMs.
      const { finalFlushFloorMs, appDisposeFloorMs } = this.options;
      let deadline = until;
      if (step.order >= SHUTDOWN_ORDER.applicationDispose) deadline = Math.min(Math.max(until, scheduler.now() + appDisposeFloorMs), until + finalFlushFloorMs + appDisposeFloorMs);
      else if (step.order >= SHUTDOWN_ORDER.storageFinal) deadline = Math.min(Math.max(until, scheduler.now() + finalFlushFloorMs), until + finalFlushFloorMs);
      const outcome = await this.#runStep(step, deadline);
      if (outcome === 'timeout') timedOut.add(step.id);
      else if (outcome === 'failed') failed.add(step.id);
      else if (outcome) {
        for (const id of outcome.timedOut ?? []) timedOut.add(id);
        for (const id of outcome.failed ?? []) failed.add(id);
        for (const id of outcome.notStarted ?? []) notStarted.add(id);
      }
    }
    return { timedOut: [...timedOut], failed: [...failed], notStarted: [...notStarted] };
  }

  /** Runs one step against its deadline. Few promise hops on purpose: a step that needs only microtasks ends before any timer. */
  #runStep(step: ShutdownStep, deadline: number): Promise<ShutdownStepReport | 'timeout' | 'failed' | undefined> {
    const scheduler = getScheduler();
    return new Promise((resolve) => {
      const holder: { timer?: IDisposable } = {};
      const finish = (outcome: ShutdownStepReport | 'timeout' | 'failed' | undefined): void => {
        holder.timer?.dispose();
        resolve(outcome);
      };
      const fail = (error: unknown): void => {
        reportError(new TesseraError('lifecycle.shutdownStepFailed', `Shutdown step "${step.id}" failed`, { cause: error, details: { id: step.id, phase: 'run' } }), { source: 'lifecycle', target: `shutdown.${step.id}` });
        finish('failed');
      };
      // The step itself gets 50 ms less than the deadline, so a step that bounds itself reports before this backstop fires. A step that
      // starts after its deadline (an earlier step used the budget) still gets 50 ms: enough for work that needs only microtasks.
      const backstopAt = Math.max(deadline, scheduler.now() + BACKSTOP_GRACE_MS);
      holder.timer = scheduler.timeout(() => finish('timeout'), backstopAt - scheduler.now());
      try {
        void Promise.resolve(step.run(Math.max(scheduler.now(), deadline - BACKSTOP_GRACE_MS))).then((report) => finish(report ?? undefined), fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  async #veto(reason: ShutdownReason): Promise<string[]> {
    this.#state.set('vetoing');
    const entries: VetoEntry[] = [];
    const pending = new Set<string>();
    let handlerIndex = 0;
    for (const handler of [...this.#beforeHandlers]) {
      const handlerId = `beforeShutdown#${handlerIndex++}`;
      const event: BeforeShutdownEvent = {
        reason,
        veto: (value, id) => {
          pending.add(id);
          const result = Promise.resolve(value).then(
            (v) => v,
            (error: unknown) => {
              reportError(error, { source: 'lifecycle', target: `veto:${id}` });
              return true; // a rejected veto counts as a veto
            },
          );
          entries.push({ id, result: result.finally(() => pending.delete(id)) });
        },
      };
      try {
        handler(event);
      } catch (error) {
        reportError(error, { source: 'lifecycle', target: `veto:${handlerId}` });
        entries.push({ id: handlerId, result: Promise.resolve(true) }); // a throwing handler vetoes
      }
    }
    const notice = getScheduler().timeout(() => {
      if (pending.size > 0) this.#slow.fire({ pending: [...pending] });
    }, this.options.vetoNoticeMs);
    try {
      const results = await Promise.all(entries.map(async (e) => ({ id: e.id, vetoed: await e.result })));
      return results.filter((r) => r.vetoed).map((r) => r.id);
    } finally {
      notice.dispose();
    }
  }

  async #join(reason: ShutdownReason): Promise<{ readonly timedOut: string[]; readonly failed: string[] }> {
    const abort = new AbortController();
    const unfinished = new Map<string, Promise<void>>();
    const failed: string[] = [];
    const event: WillShutdownEvent = {
      reason,
      signal: abort.signal,
      join: (id, work) => {
        let promise: Promise<void>;
        try {
          promise = Promise.resolve(typeof work === 'function' ? work() : work);
        } catch (error) {
          promise = Promise.reject(error);
        }
        unfinished.set(
          id,
          promise.catch((error: unknown) => {
            failed.push(id);
            reportError(error, { source: 'lifecycle', target: `join:${id}` });
          }),
        );
      },
    };
    let handlerIndex = 0;
    for (const handler of [...this.#willHandlers]) {
      try {
        handler(event);
      } catch (error) {
        reportError(error, { source: 'lifecycle', target: `join:willShutdown#${handlerIndex}` });
      }
      handlerIndex++;
    }
    if (unfinished.size === 0) return { timedOut: [], failed };
    const finished = new Set<string>();
    const all = Promise.all([...unfinished].map(([id, p]) => p.then(() => void finished.add(id))));
    const timeout = new DeferredPromise<'timeout'>();
    const timer = getScheduler().timeout(() => timeout.resolve('timeout'), this.options.joinTimeoutMs);
    try {
      const outcome = await Promise.race([all.then(() => 'done' as const), timeout.promise]);
      if (outcome === 'timeout') {
        abort.abort();
        return { timedOut: [...unfinished.keys()].filter((id) => !finished.has(id)), failed };
      }
      return { timedOut: [], failed };
    } finally {
      timer.dispose();
    }
  }

  dispose(): void {
    this.#slow.dispose();
  }
}

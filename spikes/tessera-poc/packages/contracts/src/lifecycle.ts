import type { Event, IDisposable } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { multiToken, token, type MultiToken, type Token } from '@tessera/di';

export const LifecyclePhase = { Starting: 1, Ready: 2, Restored: 3, Eventually: 4 } as const;
export type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

export const ShutdownReason = { Close: 'close', Quit: 'quit', Reload: 'reload', Update: 'update' } as const;
export type ShutdownReason = (typeof ShutdownReason)[keyof typeof ShutdownReason];

export type ShutdownState = 'running' | 'vetoing' | 'joining' | 'disposing' | 'done';

export interface BeforeShutdownEvent {
  readonly reason: ShutdownReason;
  /** true or a promise of true vetoes. A rejected promise counts as a veto. id names the participant. */
  veto(value: boolean | Promise<boolean>, id: string): void;
}

export interface WillShutdownEvent {
  readonly reason: ShutdownReason;
  /** Aborts when the join timeout expires. */
  readonly signal: AbortSignal;
  /** Wait for work (a save). Cannot refuse. */
  join(id: string, work: Promise<void> | (() => Promise<void>)): void;
}

export interface ShutdownResult {
  readonly vetoed: boolean;
  readonly vetoedBy: readonly string[];
  readonly timedOut: readonly string[];       // join participants that did not finish in time, and dispose-step overruns
  /** Join participants that rejected (for example 'storage.flush' when a key could not be written). Absent when none failed. */
  readonly failed?: readonly string[];
  /** Plugins whose deactivate() never started because the dispose budget was gone (their synchronous cleanup still ran). Absent when none. */
  readonly notStarted?: readonly string[];
}

/** What a shutdown step reports. Absent members mean none. */
export interface ShutdownStepReport {
  /** Ids (plugin ids, task ids) that did not finish before the step's deadline. */
  readonly timedOut?: readonly string[];
  /** Participants that failed (for example 'storage.flush', 'layout.flush'). */
  readonly failed?: readonly string[];
  /** Ids whose work never started because the deadline was gone (plugins whose deactivate() was skipped). */
  readonly notStarted?: readonly string[];
}

/**
 * One step of the shutdown dispose phase. Modules register their own steps (`LifecycleService.registerShutdownStep`);
 * the lifecycle service runs them by `order` against one deadline (contracts.md 8.3).
 */
export interface ShutdownStep {
  /** Unique, for reports and errors ('plugins', 'workbench.settle'). */
  readonly id: string;
  /** Position in the run. See SHUTDOWN_ORDER. Equal orders run in registration order. */
  readonly order: number;
  /** Runs synchronously when the gate closes, before any step runs (abort signals, close the activation gate). */
  close?(): void;
  /** `deadline` is scheduler time in ms. The step must end by then. The runner enforces it with a short grace as a backstop. */
  run(deadline: number): Promise<ShutdownStepReport | void>;
}

/** Where the core steps sit. Applications and modules may use any number in between (350 runs between contributions and the layout flush). */
export const SHUTDOWN_ORDER = {
  /** The shell closes the start gate and waits for start(). */
  start: 50,
  plugins: 100,
  settle: 200,
  contributions: 300,
  layout: 400,
  windowDispose: 500,
  storageFinal: 600,
  applicationDispose: 700,
} as const;

export interface LifecycleService {
  readonly phase: Observable<LifecyclePhase>;
  readonly shutdownState: Observable<ShutdownState>;
  /** Resolves when the phase is reached (at once if already reached). */
  when(phase: LifecyclePhase): Promise<void>;
  /** Shell only. Throws 'lifecycle.backwards' for a lower phase. */
  setPhase(phase: LifecyclePhase): void;
  onBeforeShutdown(handler: (e: BeforeShutdownEvent) => void): IDisposable;
  onWillShutdown(handler: (e: WillShutdownEvent) => void): IDisposable;
  /**
   * Adds a shutdown step. The step stays until the returned disposable is disposed. The runner takes its list when the dispose phase
   * starts, so a step of a window-scope module still runs when its scope is disposed by an earlier step.
   * Throws 'lifecycle.duplicateShutdownStep' for an id that is registered.
   */
  registerShutdownStep(step: ShutdownStep): IDisposable;
  /** Runs veto, join, then the shutdown steps. force skips the veto step. */
  shutdown(reason: ShutdownReason, options?: { readonly force?: boolean }): Promise<ShutdownResult>;
  /** Runs only the veto step, then returns to 'running'. Used for a multi-window quit (process-model.md). */
  checkVeto(reason: ShutdownReason): Promise<ShutdownResult>;
  /** Fires while a veto takes longer than vetoNoticeMs, so the UI can offer "Quit anyway" (shutdown with force). */
  readonly onSlowVeto: Event<{ readonly pending: readonly string[] }>;
}
export const LifecycleService: Token<LifecycleService> = token<LifecycleService>('tessera.lifecycle');

export interface LifecycleContribution {
  readonly id: string;
  readonly phase: LifecyclePhase;
  run(signal: AbortSignal): void | Promise<void>;
}
export const LifecycleContribution: MultiToken<LifecycleContribution> = multiToken<LifecycleContribution>('tessera.lifecycleContribution');

export interface LifecycleOptions {
  readonly contributionBudgetMs: number;   // default 5000, per Starting or Ready contribution
  readonly vetoNoticeMs: number;           // default 3000
  readonly joinTimeoutMs: number;          // default 3000, for all joins together
  readonly eventuallyDelayMs: number;      // default 2500 after Restored, or on first idle
  readonly phaseBudgetMs: number;          // default 5000, aggregate per phase (report only: lifecycle.phaseBudget)
  readonly disposeBudgetMs: number;        // default 5000, one deadline for all shutdown steps (deactivate, flush, terminate)
  readonly finalFlushFloorMs: number;      // default 1000, the final storage flush gets at least this long even when the budget is spent
  readonly appDisposeFloorMs: number;      // default 500, application.dispose gets at least this long
  readonly firstPaintBudgetMs: number;     // default 800, app.start to first-paint (report only: lifecycle.markBudget)
  readonly restoredBudgetMs: number;       // default 1500, app.start to restored (report only: lifecycle.markBudget)
}
export const LifecycleOptions: Token<LifecycleOptions> = token<LifecycleOptions>('tessera.lifecycleOptions');

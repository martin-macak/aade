import { Event, TesseraError, getScheduler, reportError, withTimeout, type IDisposable } from '@tessera/base';
import {
  PluginLoader,
  type DeactivateReason,
  WorkItemService,
  type FailureCause,
  type PluginDescription,
  type PluginHost,
  type PluginModule,
} from '@tessera/contracts';
import type { Scope } from '@tessera/di';
import { state, type Observable } from '@tessera/reactive';
import { createPluginRuntime, type PluginRuntime } from './runtime.ts';

export const ACTIVATE_TIMEOUT_MS = 10_000;
export const DEACTIVATE_TIMEOUT_MS = 5_000;
/** Longest wait for the import of a plugin's main entry (PluginLoader.load). A loader that never settles fails the activation with plugin.loadTimeout. */
export const LOAD_TIMEOUT_MS = 10_000;

/** Thrown by the host when activation fails. The cause becomes `PluginStatus.failure.cause`. */
export class PluginActivationError extends TesseraError {
  readonly failureCause: FailureCause;

  constructor(cause: FailureCause, message: string, original: unknown) {
    super(
      cause === 'activateTimeout' ? 'plugin.activationTimeout' : cause === 'dependencyFailed' ? 'plugin.dependencyFailed' : 'plugin.activationFailed',
      message,
      { cause: original },
    );
    this.name = 'PluginActivationError';
    this.failureCause = cause;
  }
}

/** Bounds for one deactivation (the shutdown passes them; a normal deactivation uses the defaults). */
export interface HostDeactivateOptions {
  /** Longest wait for deactivate() itself. Default: the host's deactivateTimeoutMs. */
  readonly timeoutMs?: number;
  /** Absolute time (scheduler.now() clock) after which cleanup stops waiting for disposers. */
  readonly deadline?: number;
  /** Do not call the plugin's deactivate(): abort and clean up only (the shutdown budget is gone). */
  readonly skipDeactivate?: boolean;
  /** Called when deactivate() overran `timeoutMs`. */
  readonly onTimeout?: () => void;
}

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === 'object' && value !== null && typeof (value as { activate?: unknown }).activate === 'function';
}

/** Runs plugin code in the renderer realm (contracts.md 14.4 `PluginHost`, v1's only host). */
export class InProcessPluginHost implements PluginHost {
  readonly id = 'in-process';
  readonly kind = 'in-process' as const;
  readonly state: Observable<'starting' | 'ready' | 'unresponsive' | 'exited'> = state<'starting' | 'ready' | 'unresponsive' | 'exited'>('ready', { name: 'pluginHost.state' }).asReadonly();
  readonly onDidExit: Event<{ readonly code: number | null }> = Event.None;

  readonly #window: Scope;
  readonly #runtimes = new Map<string, PluginRuntime>();
  /** Runtimes whose deactivation started and whose cleanup has not ended: the view door still sees them (and treats them as closing). */
  readonly #closingRuntimes = new Map<string, PluginRuntime>();
  /** Finished runtimes keep their live report so a test can read it after deactivation. */
  readonly #finished = new Map<string, PluginRuntime>();
  readonly #activateTimeoutMs: number;
  readonly #deactivateTimeoutMs: number;
  readonly #loadTimeoutMs: number;
  /** The one listener on WorkItemService.onDidCreate: it hands each WorkItem to the runtime of its owner. */
  #workItemListener: IDisposable | undefined;

  constructor(window: Scope, options?: { readonly activateTimeoutMs?: number; readonly deactivateTimeoutMs?: number; readonly loadTimeoutMs?: number }) {
    this.#window = window;
    this.#activateTimeoutMs = options?.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS;
    this.#deactivateTimeoutMs = options?.deactivateTimeoutMs ?? DEACTIVATE_TIMEOUT_MS;
    this.#loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  }

  /** The longest an activation can take: the entry load plus activate(). A deactivation that waits for a pending activation waits at most this long. */
  get activationBudgetMs(): number {
    return this.#loadTimeoutMs + this.#activateTimeoutMs;
  }

  async activate(description: PluginDescription, reason: string): Promise<void> {
    const manifest = description.manifest;
    const pluginId = manifest.id;
    this.#finished.delete(pluginId);
    // 2. load the main entry. A declarative-only plugin (no main) is active at once.
    let module: PluginModule | undefined;
    if (manifest.main !== undefined) {
      try {
        const loading = this.#window.get(PluginLoader).load(description, 'main');
        loading.catch(() => undefined); // a load that fails after the timeout is not unhandled
        const namespace = await withTimeout(loading, this.#loadTimeoutMs, `Loading "${manifest.main}" of plugin "${pluginId}"`).catch((error: unknown) => {
          if (error instanceof TesseraError && error.code === 'timeout') {
            throw new TesseraError('plugin.loadTimeout', `Loading "${manifest.main}" of plugin "${pluginId}" took longer than ${this.#loadTimeoutMs} ms`, { cause: error, details: { pluginId, ms: this.#loadTimeoutMs } });
          }
          throw error;
        });
        const candidate = (namespace as { default?: unknown } | undefined)?.default ?? namespace;
        if (!isPluginModule(candidate)) throw new TesseraError('validation', `Entry "${manifest.main}" of "${pluginId}" has no default export with an activate() function`);
        module = candidate;
      } catch (error) {
        throw new PluginActivationError('loadFailed', `Loading "${manifest.main}" of plugin "${pluginId}" failed: ${messageOf(error)}`, error);
      }
    }
    if (module === undefined) return;
    // 3. plugin DI scope, store, abort controller, context
    const runtime = createPluginRuntime(this.#window, description, reason);
    runtime.module = module;
    this.#runtimes.set(pluginId, runtime);
    this.#listenForWorkItems();
    // 4. activate(ctx), bounded
    const activation = Promise.resolve().then(() => (module as PluginModule).activate(runtime.ctx));
    try {
      await withTimeout(activation, this.#activateTimeoutMs, `activate() of plugin "${pluginId}"`);
      // deactivate() ended the runtime while activate() was pending: the activation did not succeed
      if (runtime.closed) throw new TesseraError('plugin.deactivated', `Plugin "${pluginId}" was deactivated while its activate() was running`);
      runtime.activated = true;
    } catch (error) {
      runtime.abort.abort();
      // 6. failure: OSGi rule. Dispose everything. deactivate() is never called.
      if (!runtime.closed) await this.#cleanup(runtime);
      if (this.#runtimes.get(pluginId) === runtime) this.#runtimes.delete(pluginId);
      this.#finished.set(pluginId, runtime);
      const timedOut = error instanceof TesseraError && error.code === 'timeout';
      // An activate() that is abandoned by the timeout may still reject later: report it (it is not silent any more).
      if (timedOut) activation.catch((late: unknown) => reportError(late, { source: 'activation', pluginId, target: 'lateRejection' }));
      throw new PluginActivationError(timedOut ? 'activateTimeout' : 'activateThrew', `activate() of plugin "${pluginId}" ${timedOut ? 'timed out' : 'threw'}: ${messageOf(error)}`, error);
    }
  }

  #listenForWorkItems(): void {
    if (this.#workItemListener) return;
    const service = this.#window.get(WorkItemService, { optional: true });
    this.#workItemListener = service?.onDidCreate((workItem) => {
      if (workItem.owner !== undefined) this.#runtimes.get(workItem.owner)?.adoptWorkItem(workItem);
    });
  }

  async deactivate(pluginId: string, reason: DeactivateReason = 'disable', options?: HostDeactivateOptions): Promise<void> {
    const runtime = this.#runtimes.get(pluginId);
    if (!runtime) return;
    this.#runtimes.delete(pluginId);
    this.#closingRuntimes.set(pluginId, runtime);
    try {
      runtime.abort.abort(); // 2. ctx.signal aborts
      const module = runtime.module;
      // OSGi rule: deactivate() runs only after a successful activate(). A runtime whose activate() is pending is only cleaned up.
      if (module?.deactivate && runtime.activated && options?.skipDeactivate !== true) {
        try {
          // 3. deactivate(), bounded. Errors and timeouts are reported.
          await withTimeout(Promise.resolve().then(() => module.deactivate?.(reason)), options?.timeoutMs ?? this.#deactivateTimeoutMs, `deactivate() of plugin "${pluginId}"`);
        } catch (error) {
          if (error instanceof TesseraError && error.code === 'timeout') options?.onTimeout?.();
          reportError(error, { source: 'deactivation', pluginId, target: pluginId });
        }
      }
      await this.#cleanup(runtime, options?.deadline);
      this.#finished.set(pluginId, runtime);
    } finally {
      if (this.#closingRuntimes.get(pluginId) === runtime) this.#closingRuntimes.delete(pluginId);
    }
  }

  /** 14.5 deactivation step 4: store (LIFO), WorkItems, undo entries, plugin DI scope. Runs in every case. */
  async #cleanup(runtime: PluginRuntime, deadline?: number): Promise<void> {
    const pluginId = runtime.description.manifest.id;
    const fail = (error: unknown): void => reportError(error, { source: 'dispose', pluginId, target: pluginId });
    runtime.closed = true; // a late call of the plugin (an abandoned activate(), async work) now throws 'plugin.deactivated'
    try {
      runtime.store.dispose();
    } catch (error) {
      fail(error);
    }
    for (const workItem of [...runtime.workItems].reverse()) {
      try {
        const left = deadline === undefined ? this.#deactivateTimeoutMs : Math.max(0, Math.min(this.#deactivateTimeoutMs, deadline - getScheduler().now()));
        await withTimeout(Promise.resolve(workItem.terminate()), left, `terminate() of a WorkItem of plugin "${pluginId}"`);
      } catch (error) {
        fail(error);
      }
    }
    try {
      runtime.undo?.invalidateOwner(pluginId);
    } catch (error) {
      fail(error);
    }
    try {
      await runtime.scope.dispose(deadline === undefined ? undefined : { deadline });
    } catch (error) {
      fail(error);
    }
  }

  /** The running runtime of a plugin (its view door), if any. */
  runtimeOf(pluginId: string): PluginRuntime | undefined {
    return this.#runtimes.get(pluginId) ?? this.#closingRuntimes.get(pluginId);
  }

  isActive(pluginId: string): boolean {
    return this.#runtimes.has(pluginId);
  }

  /** Dev-mode report: what the plugin registered through its context and has not disposed. Must be empty after deactivation. */
  liveDisposables(pluginId: string): readonly string[] {
    const runtime = this.#runtimes.get(pluginId) ?? this.#finished.get(pluginId);
    return runtime ? [...runtime.live.values()] : [];
  }

  /** Aborts ctx.signal of every running plugin (the start of the shutdown dispose step). */
  abortAll(): void {
    for (const runtime of this.#runtimes.values()) runtime.abort.abort();
  }

  async dispose(): Promise<void> {
    this.#workItemListener?.dispose();
    this.#workItemListener = undefined;
    for (const id of [...this.#runtimes.keys()].reverse()) await this.deactivate(id, 'shutdown');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { IDisposable };

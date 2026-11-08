import {
  TesseraError,
  createLogger,
  dedupingReporter,
  getScheduler,
  isDevMode,
  reportError,
  setDevMode,
  setErrorReporter,
  setScheduler,
  withTimeout,
  type ErrorReporter as ErrorReporterType,
  type IAsyncDisposable,
  type IDisposable,
} from '@tessera/base';
import {
  ContextKeyService,
  ErrorReporter,
  HostEnvironment,
  HostPluginServices,
  InterceptorRegistry,
  LifecycleContribution,
  LifecycleOptions,
  LifecyclePhase,
  LifecycleService,
  Logger,
  PluginCatalog,
  PluginLoader,
  PluginPolicy,
  SHUTDOWN_ORDER,
  StorageBackend,
  WorkItemService,
  WorkbenchService,
  type HostPluginService,
  type InstallContext,
  type ServiceModule,
  type ShutdownReason,
  type ShutdownResult,
} from '@tessera/contracts';
import { createRootScope, type Scope } from '@tessera/di';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { DEFAULT_LIFECYCLE_OPTIONS, lifecycleModule } from '@tessera/lifecycle';
import { persistenceModule } from '@tessera/persistence';
import { pluginsModule } from '@tessera/plugins';
import { createInterceptorRegistry } from '@tessera/interceptors';
import { installReactiveEngine, type ReactiveEngine } from '@tessera/reactive';
import { workItemsModule } from '@tessera/workitems';
import { workbenchModule } from '@tessera/workbench';

export interface ApplicationOptions {
  readonly host: HostEnvironment;
  /** App-specific modules, installed after the core modules. */
  readonly modules?: readonly ServiceModule[];
  /**
   * Replaces core modules by id (a host that swaps the storage module, for example). Each entry must have the id of a core module;
   * an unknown id throws `shell.unknownModule`. A module in `modules` with an id that is already installed throws `shell.duplicateModule`.
   */
  readonly replaceModules?: readonly ServiceModule[];
  readonly lifecycle?: Partial<LifecycleOptions>;
  readonly reactiveEngine?: ReactiveEngine;
  /**
   * Safe mode: only builtin plugins resolve, the stored layout is not restored (and the default layout is not written over it),
   * and the context key `app.safeMode` is true. The crash-loop guard that decides when to start in safe mode lives in the
   * main process (process-model.md; the Electron host is not built).
   */
  readonly safeMode?: boolean;
  /** Decides which requested capabilities a plugin gets. Default: builtin and dev plugins get what they declare, user plugins none (contracts.md 14.7). */
  readonly pluginPolicy?: PluginPolicy;
  /**
   * Services of the host product that plugins may use (a git service, a project service). Each entry's token must be registered by the host
   * (in `modules`). It becomes a public token for the plugins that hold `capability`, or for all when none is named; `facade` wraps it per plugin.
   */
  readonly pluginServices?: readonly HostPluginService[];
}

export interface Application extends IAsyncDisposable {
  readonly application: Scope;
  readonly window: Scope;
  /**
   * Runs Starting and Ready, calls mount() (the host renders the window), awaits WorkbenchService.whenRestored()
   * (bounded by 10 s), then sets Restored. Eventually follows on its own.
   */
  start(options: { readonly mount: () => void | Promise<void> }): Promise<void>;
  shutdown(reason: ShutdownReason, options?: { readonly force?: boolean }): Promise<ShutdownResult>;
  /** Startup marks in order: app.start, phase.Starting.end, first-paint, restored (scheduler time in ms). */
  readonly marks: ReadonlyMap<string, number>;
}

/** The seven core modules in a safe install order. Install order is recomputed from `dependsOn`. */
export const coreModules: readonly ServiceModule[] = [eventsModule, lifecycleModule, workItemsModule, commandsModule, persistenceModule, pluginsModule, workbenchModule];

const RESTORE_BOUND_MS = 10_000;

/** The one live Application of this realm (createApplication writes process-global state: error reporter, scheduler, dev mode). */
let liveApplication: symbol | undefined;

/** Core modules with `replaceModules` applied. */
function withReplacements(replace: readonly ServiceModule[] | undefined): ServiceModule[] {
  const result = [...coreModules];
  for (const module of replace ?? []) {
    const index = result.findIndex((m) => m.id === module.id);
    if (index < 0) throw new TesseraError('shell.unknownModule', `replaceModules: "${module.id}" is not a core module (core modules: ${coreModules.map((m) => m.id).join(', ')})`, { details: { id: module.id } });
    result[index] = module;
  }
  return result;
}

/** Orders modules so that each comes after the modules it `dependsOn` (those that are installed). A cycle throws shell.moduleCycle. */
export function orderModules(modules: readonly ServiceModule[]): ServiceModule[] {
  const byId = new Map<string, ServiceModule>();
  for (const module of modules) {
    if (byId.has(module.id)) {
      throw new TesseraError('shell.duplicateModule', `Service module "${module.id}" is listed twice. To replace a core module, use ApplicationOptions.replaceModules`, { details: { id: module.id } });
    }
    byId.set(module.id, module);
  }
  const ordered: ServiceModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (module: ServiceModule, path: readonly string[]): void => {
    const mark = state.get(module.id);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new TesseraError('shell.moduleCycle', `Service modules depend on each other in a cycle: ${[...path, module.id].join(' -> ')}`, { details: { path: [...path, module.id] } });
    state.set(module.id, 'visiting');
    for (const dep of module.dependsOn ?? []) {
      const target = byId.get(dep);
      if (target) visit(target, [...path, module.id]);
    }
    state.set(module.id, 'done');
    ordered.push(module);
  };
  for (const module of modules) visit(module, []);
  return ordered;
}

/**
 * The composition root of one renderer realm (contracts.md 19.2). DOM-free and Electron-free, so tests boot it in Node.
 * Creating it installs the services; start() runs the phases.
 */
export function createApplication(options: ApplicationOptions): Application {
  // Validate first: nothing global is touched when the module list is wrong or another application is live.
  const orderedModules = orderModules([...withReplacements(options.replaceModules), ...(options.modules ?? [])]);
  if (liveApplication !== undefined) {
    throw new TesseraError('shell.secondApplication', 'Another Application is live in this realm. Dispose it first: createApplication sets the error reporter, the scheduler and dev mode for the whole realm');
  }
  const identity = Symbol('application');
  liveApplication = identity;
  const previousDevMode = isDevMode();
  const host: HostEnvironment = options.safeMode === undefined ? options.host : { ...options.host, safeMode: options.safeMode };
  const globals: IDisposable[] = [{ dispose: () => setDevMode(previousDevMode) }];
  // Restored after the shutdown result is known, not in the application.dispose step: the lifecycle service writes its last state ('done') after that step.
  const lateGlobals: IDisposable[] = [];
  try {
    return buildApplication(options, host, globals, lateGlobals, orderedModules, identity);
  } catch (error) {
    for (const g of globals.splice(0).reverse()) g.dispose();
    for (const g of lateGlobals.splice(0).reverse()) g.dispose();
    if (liveApplication === identity) liveApplication = undefined;
    throw error;
  }
}

function buildApplication(options: ApplicationOptions, host: HostEnvironment, globals: IDisposable[], lateGlobals: IDisposable[], orderedModules: readonly ServiceModule[], identity: symbol): Application {
  // 1. reactive engine, error reporter, scheduler and dev mode from the host
  // The engine of the application is restored with it (process-global state: the previous engine comes back on dispose, after the last state write of the shutdown).
  if (options.reactiveEngine) lateGlobals.push(installReactiveEngine(options.reactiveEngine));
  let dedupedReporter: ErrorReporterType | undefined;
  if (host.errorReporter) {
    // A host reporter gets the same error at most once per 5 s per code, target and owner, then one "suppressed N" record.
    const deduped = dedupingReporter(host.errorReporter);
    dedupedReporter = deduped;
    globals.push(setErrorReporter(deduped), deduped);
  }
  if (host.scheduler) globals.push(setScheduler(host.scheduler));
  setDevMode(host.isDev);

  // 3. the interceptor registry and the DI hook that routes service calls to it
  const interceptors = createInterceptorRegistry();
  const application = createRootScope({
    id: 'app',
    kind: 'application',
    interception: async (call, invoke) => {
      const ctx = interceptors.createContext('service', `${call.tokenId}.${call.method}`, { tokenId: call.tokenId, method: call.method, args: call.args });
      return interceptors.run(ctx, async (c) => invoke(c.data.args));
    },
  });
  // 2. host-provided values
  const logger = host.logger ?? createLogger('tessera');
  const lifecycleOptions: LifecycleOptions = { ...DEFAULT_LIFECYCLE_OPTIONS, ...options.lifecycle };
  application.provideValue(HostEnvironment, host, { owner: 'shell' });
  application.provideValue(StorageBackend, host.storage, { owner: 'shell' });
  application.provideValue(PluginCatalog, host.pluginCatalog, { owner: 'shell' });
  application.provideValue(PluginLoader, host.pluginLoader, { owner: 'shell' });
  application.provideValue(Logger, logger, { owner: 'shell' });
  application.provideValue(ErrorReporter, dedupedReporter ?? { report: (error, context) => reportError(error, context) }, { owner: 'shell' });
  application.provideValue(LifecycleOptions, lifecycleOptions, { owner: 'shell' });
  application.provideValue(InterceptorRegistry, interceptors, { owner: 'shell' });
  if (options.pluginPolicy) application.provideValue(PluginPolicy, options.pluginPolicy, { owner: 'shell' });
  if (options.pluginServices) application.provideValue(HostPluginServices, options.pluginServices, { owner: 'shell' });
  // 4. the window scope
  const window = application.createChild('window', host.windowId);

  // 5. modules in dependency order
  const context: InstallContext = { application, window, host };
  for (const module of orderedModules) module.install(context);

  let started: Promise<void> | undefined;
  let disposed: Promise<ShutdownResult> | undefined;
  /** The closing gate: closed by the first line of the dispose step. start() checks it at each phase boundary and returns quietly. */
  const closing = new AbortController();
  const closed = new Promise<void>((resolve) => closing.signal.addEventListener('abort', () => resolve(), { once: true }));
  let lifecycleRef: LifecycleService | undefined;
  let eventuallyTimer: IDisposable | undefined;
  const tracked = new Map<Promise<unknown>, string>();
  const aborts = new Set<AbortController>();
  const marks = new Map<string, number>();
  const reportedMarks = new Set<string>();
  const mark = (name: string): void => {
    marks.set(name, getScheduler().now());
    // Performance marks for the browser's profiler (and Node): tessera:<name>, and a measure from app.start to each later mark.
    try {
      performance.mark(`tessera:${name}`);
      if (name !== 'app.start' && marks.has('app.start')) performance.measure(`tessera:${name}`, `tessera:app.start`, `tessera:${name}`);
    } catch {
      // no performance timeline in this realm
    }
    // Budgets of B17 and B18: a mark that comes later than its budget is reported once (report only, the start goes on).
    const budget = name === 'first-paint' ? lifecycleOptions.firstPaintBudgetMs : name === 'restored' ? lifecycleOptions.restoredBudgetMs : undefined;
    const startedAt = marks.get('app.start');
    if (budget !== undefined && startedAt !== undefined && !reportedMarks.has(name)) {
      const spent = (marks.get(name) as number) - startedAt;
      if (spent > budget) {
        reportedMarks.add(name);
        reportError(new TesseraError('lifecycle.markBudget', `Startup mark "${name}" came ${Math.round(spent)} ms after app.start (budget ${budget} ms)`, { details: { mark: name, spent, budget } }), { source: 'lifecycle', target: `mark:${name}` });
      }
    }
  };

  const runPhase = async (phase: LifecyclePhase, awaited: boolean): Promise<void> => {
    const lifecycle = window.get(LifecycleService);
    lifecycle.setPhase(phase);
    const runs: Array<Promise<void>> = [];
    const phaseStart = getScheduler().now();
    for (const contribution of window.getAll(LifecycleContribution)) {
      if (contribution.phase !== phase) continue;
      if (closing.signal.aborted) break;
      const abort = new AbortController();
      aborts.add(abort);
      const run = (async (): Promise<void> => {
        try {
          const work = Promise.resolve().then(() => contribution.run(abort.signal));
          await (awaited ? withTimeout(work, lifecycleOptions.contributionBudgetMs, `Lifecycle contribution "${contribution.id}"`) : work);
        } catch (error) {
          abort.abort();
          reportError(error, { source: 'lifecycle', target: contribution.id });
        }
      })();
      if (awaited) {
        await run;
        aborts.delete(abort);
      } else {
        tracked.set(run, contribution.id);
        void run.finally(() => {
          tracked.delete(run);
          aborts.delete(abort);
        });
        runs.push(run);
      }
    }
    // Report only: the aggregate time of the awaited contributions of one phase.
    const spent = getScheduler().now() - phaseStart;
    if (awaited && spent > lifecycleOptions.phaseBudgetMs) {
      const name = Object.entries(LifecyclePhase).find(([, value]) => value === phase)?.[0] ?? String(phase);
      reportError(new TesseraError('lifecycle.phaseBudget', `Lifecycle phase ${name} took ${Math.round(spent)} ms (budget ${lifecycleOptions.phaseBudgetMs} ms)`, { details: { phase: name, spent, budget: lifecycleOptions.phaseBudgetMs } }), { source: 'lifecycle', target: `phase:${name}` });
    }
  };

  /** Races work against what is left of the dispose budget. Resolves true when the work finished in time. */
  const bounded = async (work: Promise<unknown>, until: number): Promise<boolean> => {
    const left = Math.max(0, until - getScheduler().now());
    return new Promise<boolean>((resolve) => {
      const timer = getScheduler().timeout(() => resolve(false), left);
      work.then(
        () => (timer.dispose(), resolve(true)),
        (error: unknown) => {
          timer.dispose();
          reportError(error, { source: 'lifecycle', target: 'shutdown.dispose' });
          resolve(true);
        },
      );
    });
  };

  // The shell contributes only its own shutdown steps: the start gate (50), tracked contributions (300), window.dispose (500) and
  // application.dispose (700). The modules contribute theirs (plugins 100, workbench settle 200 and layout 400, storage final flush 600).
  // The lifecycle service runs them all by order against one deadline (contracts.md 8.3).
  const lifecycleService = application.get(LifecycleService);
  lifecycleService.registerShutdownStep({
    id: 'app.start',
    order: SHUTDOWN_ORDER.start,
    close() {
      closing.abort();
      for (const abort of aborts) abort.abort();
    },
    async run(deadline) {
      // start() stops at its next boundary; a mount() or a restore that runs now is not waited for beyond the deadline
      const overran = started && !(await bounded(started.catch(() => undefined), deadline));
      eventuallyTimer?.dispose();
      return overran ? { timedOut: ['app.start'] } : undefined;
    },
  });
  lifecycleService.registerShutdownStep({
    id: 'contributions',
    order: SHUTDOWN_ORDER.contributions,
    async run(deadline) {
      const running = [...tracked.entries()];
      if (await bounded(Promise.allSettled(running.map(([p]) => p)), deadline)) return;
      return { timedOut: running.filter(([p]) => tracked.has(p)).map(([, id]) => id) };
    },
  });
  lifecycleService.registerShutdownStep({
    id: 'window.dispose',
    order: SHUTDOWN_ORDER.windowDispose,
    // A hung disposer does not hold the quit: each disposer is bounded and so is the whole step.
    async run(deadline) {
      return (await bounded(window.dispose({ deadline }), deadline)) ? undefined : { timedOut: ['window.dispose'] };
    },
  });
  lifecycleService.registerShutdownStep({
    id: 'application.dispose',
    order: SHUTDOWN_ORDER.applicationDispose,
    async run(deadline) {
      const overran = !(await bounded(application.dispose({ deadline }), deadline));
      for (const g of globals.splice(0).reverse()) g.dispose();
      if (liveApplication === identity) liveApplication = undefined;
      return overran ? { timedOut: ['application.dispose'] } : undefined;
    },
  });

  const app: Application = {
    application,
    window,
    start(startOptions) {
      started ??= (async () => {
        const lifecycle = lifecycleService;
        if (closing.signal.aborted) return; // shutdown ran before start(): nothing starts
        if (host.safeMode === true) window.get(ContextKeyService).root.set('app.safeMode', true);
        window.get(WorkItemService); // the root WorkItem is the window: create it before anything uses the window scope
        host.attachLifecycle?.(lifecycle);
        mark('app.start');
        await runPhase(LifecyclePhase.Starting, true);
        mark('phase.Starting.end');
        if (closing.signal.aborted) return;
        await runPhase(LifecyclePhase.Ready, true);
        if (closing.signal.aborted) return;
        await startOptions.mount();
        mark('first-paint');
        if (closing.signal.aborted) return;
        try {
          await Promise.race([withTimeout(window.get(WorkbenchService).whenRestored(), RESTORE_BOUND_MS, 'Restoring the workbench'), closed]);
        } catch (error) {
          if (!closing.signal.aborted) reportError(error, { source: 'lifecycle', target: 'workbench.whenRestored' });
        }
        if (closing.signal.aborted) return;
        mark('restored');
        await runPhase(LifecyclePhase.Restored, false);
        if (closing.signal.aborted) return;
        // Eventually: after the delay (the host scheduler decides what "idle" means)
        eventuallyTimer = getScheduler().timeout(() => {
          if (!closing.signal.aborted) void runPhase(LifecyclePhase.Eventually, false);
        }, lifecycleOptions.eventuallyDelayMs);
      })();
      return started;
    },
    marks,
    shutdown(reason, shutdownOptions) {
      // the window scope is gone after a shutdown: keep the service and the result of the first completed shutdown
      lifecycleRef ??= window.get(LifecycleService);
      const result = lifecycleRef.shutdown(reason, shutdownOptions);
      void result.then((r) => {
        if (r.vetoed) return;
        for (const g of lateGlobals.splice(0).reverse()) g.dispose();
        disposed ??= Promise.resolve(r);
      });
      return disposed ?? result;
    },
    async dispose() {
      disposed ??= app.shutdown('quit', { force: true });
      await disposed;
    },
  };
  return app;
}

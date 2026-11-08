import { createLogger, LogLevel, type LogRecord, type Logger } from '@tessera/base';
import {
  CommandService,
  ConfigurationService,
  ContextKeyService,
  DockSurfaceFactory,
  LifecyclePhase,
  LifecycleService,
  PluginManager,
  StorageService,
  WorkItemService,
  WorkbenchService,
  type HostEnvironment,
  type HostPluginService,
  type PluginPolicy,
  type LifecycleOptions,
  type PluginDescription,
  type ServiceModule,
  type WindowId,
} from '@tessera/contracts';
import type { Scope, Token } from '@tessera/di';
import type { ReactiveEngine } from '@tessera/reactive';
import { memoryStorageBackend, type MemoryStorageBackend } from '@tessera/persistence';
import { createApplication, staticPluginCatalog, staticPluginLoader, type Application, type StaticPluginCatalog } from '@tessera/shell';
import { MAX_HISTORY, fakeDockSurfaceFactory, type FakeDockSurfaceFactory } from './fake-dock-surface.ts';
import { ManualScheduler } from './manual-scheduler.ts';
import { trackForDisposal } from './test-scope.ts';

export interface TestAppOptions {
  /** Plugins the static catalog lists. */
  readonly plugins?: readonly PluginDescription[];
  /** Module map for the static loader: key = plugin location (or `<location>#<renderer>`). */
  readonly modules?: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
  /** Storage that survives a restart(): pass the one from a previous app, or seed data. */
  readonly storage?: MemoryStorageBackend | { readonly application?: Record<string, unknown>; readonly project?: Record<string, unknown> };
  readonly host?: Partial<HostEnvironment>;
  readonly lifecycle?: Partial<LifecycleOptions>;
  /** Default: fake dock surfaces. `false`: none. */
  readonly dockSurfaces?: FakeDockSurfaceFactory | false;
  /** Extra service modules (after the core modules). Not the plugin modules: those go in `modules`. */
  readonly appModules?: readonly ServiceModule[];
  /** Replaces core modules by id (ApplicationOptions.replaceModules). */
  readonly replaceModules?: readonly ServiceModule[];
  /** Plugin policy and host services (ApplicationOptions). */
  readonly pluginPolicy?: PluginPolicy;
  readonly pluginServices?: readonly HostPluginService[];
  /** Safe mode (ApplicationOptions.safeMode). */
  readonly safeMode?: boolean;
  /** The reactive engine of the application (ApplicationOptions.reactiveEngine). It is restored when the application is disposed. */
  readonly reactiveEngine?: ReactiveEngine;
  /** Boot at once (default true). */
  readonly start?: boolean;
}

export interface TestApp {
  readonly app: Application;
  readonly application: Scope;
  readonly window: Scope;
  readonly scheduler: ManualScheduler;
  readonly storage: MemoryStorageBackend;
  readonly catalog: StaticPluginCatalog;
  readonly dock: FakeDockSurfaceFactory | undefined;
  /** What the host logger received. */
  readonly logs: readonly LogRecord[];
  get<T>(token: Token<T>): T;
  readonly commands: CommandService;
  readonly workbench: WorkbenchService;
  readonly plugins: PluginManager;
  readonly storageService: StorageService;
  readonly configuration: ConfigurationService;
  readonly contextKeys: ContextKeyService;
  readonly workItems: WorkItemService;
  /** Runs the lifecycle: Starting, Ready, mount, Restored. */
  start(): Promise<void>;
  /** Lets background work of the workbench and promise chains finish. */
  settle(): Promise<void>;
  /** Advances the manual scheduler, then settles. */
  advance(ms: number): Promise<void>;
  /** Advances past the Eventually delay and settles: `onStartupFinished` plugins are active afterwards. */
  toEventually(): Promise<void>;
  /** Flushes storage, shuts the app down and boots a new one over the same storage and plugins. */
  restart(overrides?: Partial<TestAppOptions>): Promise<TestApp>;
  dispose(): Promise<void>;
}

/**
 * Boots @tessera/shell in Node with an in-memory host, a static plugin catalog, fake dock surfaces and a manual scheduler
 * (poc-plan C23). No DOM. The test app is disposed by the Vitest setup file, so a test needs no cleanup code.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const scheduler = new ManualScheduler();
  const logs: LogRecord[] = [];
  const logger: Logger = createLogger('test', { level: LogLevel.Debug, sink: (r) => {
      logs.push(r);
      if (logs.length > MAX_HISTORY) logs.splice(0, logs.length - MAX_HISTORY); // bounded history: see MAX_HISTORY
    },
  });
  const storage = isMemoryBackend(options.storage) ? options.storage : memoryStorageBackend(options.storage);
  const catalog = staticPluginCatalog(options.plugins ?? []);
  const dock = options.dockSurfaces === false ? undefined : (options.dockSurfaces ?? fakeDockSurfaceFactory());
  const host: HostEnvironment = {
    kind: 'test',
    platform: 'linux',
    windowId: 'w-test' as WindowId,
    projectId: 'test-project',
    appVersion: '0.0.0-test',
    isDev: true,
    storage,
    pluginCatalog: catalog,
    pluginLoader: staticPluginLoader(options.modules ?? {}),
    scheduler,
    logger,
    ...options.host,
  };
  const extra: ServiceModule[] = [...(options.appModules ?? [])];
  if (dock) {
    extra.push({
      id: 'testing.dockSurfaces',
      install: ({ window }) => void window.provideValue(DockSurfaceFactory, dock, { owner: 'testing' }),
    });
  }
  const app = createApplication({ host, ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}), ...(options.safeMode !== undefined ? { safeMode: options.safeMode } : {}), ...(options.reactiveEngine ? { reactiveEngine: options.reactiveEngine } : {}), ...(options.pluginPolicy ? { pluginPolicy: options.pluginPolicy } : {}), ...(options.pluginServices ? { pluginServices: options.pluginServices } : {}), modules: extra, ...(options.replaceModules ? { replaceModules: options.replaceModules } : {}) });
  let disposed: Promise<void> | undefined;
  const tracking = trackForDisposal({
    dispose: () => testApp.dispose(),
  });

  const settle = async (): Promise<void> => {
    const workbench = app.window.get(WorkbenchService) as { settle?: () => Promise<void> };
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await workbench.settle?.();
    }
  };

  const testApp: TestApp = {
    app,
    application: app.application,
    window: app.window,
    scheduler,
    storage,
    catalog,
    dock,
    logs,
    get: (token) => app.window.get(token),
    get commands() {
      return app.window.get(CommandService);
    },
    get workbench() {
      return app.window.get(WorkbenchService);
    },
    get plugins() {
      return app.window.get(PluginManager);
    },
    get storageService() {
      return app.window.get(StorageService);
    },
    get configuration() {
      return app.window.get(ConfigurationService);
    },
    get contextKeys() {
      return app.window.get(ContextKeyService);
    },
    get workItems() {
      return app.window.get(WorkItemService);
    },
    start: async () => {
      await app.start({ mount: () => undefined });
      await settle();
    },
    settle,
    advance: async (ms) => {
      scheduler.advance(ms);
      await settle();
    },
    toEventually: async () => {
      await settle();
      const delay = options.lifecycle?.eventuallyDelayMs ?? 2500;
      scheduler.advance(delay);
      await settle();
      await app.application.get(LifecycleService).when(LifecyclePhase.Eventually);
      await settle();
    },
    async restart(overrides) {
      await testApp.dispose();
      return createTestApp({ ...options, storage, ...overrides });
    },
    async dispose() {
      disposed ??= (async () => {
        tracking.dispose();
        await app.dispose();
      })();
      await disposed;
    },
  };
  if (options.start !== false) await testApp.start();
  return testApp;
}

function isMemoryBackend(value: unknown): value is MemoryStorageBackend {
  return typeof value === 'object' && value !== null && 'writeExternally' in value;
}

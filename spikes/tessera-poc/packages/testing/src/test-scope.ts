import { Emitter, Event, nullLogger, reportError, setScheduler, type IDisposable, type Logger } from '@tessera/base';
import {
  ErrorReporter,
  HostEnvironment,
  InterceptorRegistry,
  Logger as LoggerToken,
  type InstallContext,
  type ServiceModule,
  type StorageBackend,
  type WindowId,
} from '@tessera/contracts';
import { createRootScope, type Scope } from '@tessera/di';
import { createInterceptorRegistry } from '@tessera/interceptors';
import { ManualScheduler } from './manual-scheduler.ts';

/** A StorageBackend in memory. Stage A fake; the real in-memory backend arrives with @tessera/persistence. */
export function createMemoryStorageBackend(initial?: { application?: Record<string, unknown>; project?: Record<string, unknown> }): StorageBackend & {
  readonly writes: ReadonlyArray<{ readonly scope: 'application' | 'project'; readonly set: Readonly<Record<string, unknown>>; readonly delete: readonly string[] }>;
} {
  const data = { application: { ...initial?.application }, project: { ...initial?.project } };
  const writes: Array<{ scope: 'application' | 'project'; set: Readonly<Record<string, unknown>>; delete: readonly string[] }> = [];
  const external = new Emitter<{ readonly scope: 'application' | 'project'; readonly keys: readonly string[] }>({ name: 'testing.storage.external' });
  return {
    writes,
    load: async (scope) => ({ ...data[scope] }),
    write: async (scope, batch) => {
      writes.push({ scope, set: batch.set, delete: batch.delete });
      Object.assign(data[scope], batch.set);
      for (const key of batch.delete) delete data[scope][key];
    },
    onDidChangeExternally: external.event,
  };
}

export function createTestHost(overrides?: Partial<HostEnvironment>): HostEnvironment {
  return {
    kind: 'test',
    platform: 'linux',
    windowId: 'w-test' as WindowId,
    projectId: '',
    appVersion: '0.0.0-test',
    isDev: true,
    storage: createMemoryStorageBackend(),
    pluginCatalog: { list: async () => [], onDidChange: Event.None },
    pluginLoader: { load: async () => { throw new Error('No plugin loader in this test host'); } },
    ...overrides,
  };
}

export interface TestScopeOptions {
  /** One scope plays application and window (kind 'test'). Default false: application scope with a window child. */
  readonly flat?: boolean;
  readonly host?: Partial<HostEnvironment>;
  /** Installed in order after the infrastructure services. */
  readonly modules?: readonly ServiceModule[];
  /** Default true: ManualScheduler becomes the process-wide scheduler until the test scope is disposed. */
  readonly installScheduler?: boolean;
  /** Collects what the test logs. Default: silent. */
  readonly logger?: Logger;
}

export interface TestScope extends IDisposable {
  readonly application: Scope;
  /** Where windows services live and tests resolve from. Equal to `application` for a flat test scope. */
  readonly window: Scope;
  readonly host: HostEnvironment;
  readonly scheduler: ManualScheduler;
  readonly interceptors: InterceptorRegistry;
  install(module: ServiceModule): void;
  dispose(): Promise<void>;
}

const live = new Set<TestScope>();

/**
 * A DI scope tree for tests, with the infrastructure services every module expects: Logger, ErrorReporter,
 * InterceptorRegistry (with the DI service-interception hook wired to it), HostEnvironment, and a ManualScheduler.
 * Test scopes are disposed by the Vitest setup file before leakCheck() runs, so tests do not have to.
 */
export function createTestScope(options?: TestScopeOptions): TestScope {
  const scheduler = new ManualScheduler();
  const schedulerHandle = options?.installScheduler === false ? undefined : setScheduler(scheduler);
  const interceptors = createInterceptorRegistry();
  const root = createRootScope({
    id: 'test',
    kind: options?.flat ? 'test' : 'application',
    interception: async (call, invoke) => {
      const ctx = interceptors.createContext('service', `${call.tokenId}.${call.method}`, { tokenId: call.tokenId, method: call.method, args: call.args });
      return interceptors.run(ctx, async (c) => invoke(c.data.args));
    },
  });
  const window = options?.flat ? root : root.createChild('window', 'w-test');
  const host = createTestHost(options?.host);

  root.provideValue(HostEnvironment, host);
  root.provideValue(InterceptorRegistry, interceptors);
  root.provideValue(LoggerToken, options?.logger ?? nullLogger);
  root.provideValue(ErrorReporter, { report: (error, context) => reportError(error, context) });

  const context: InstallContext = { application: root, window, host };
  let disposed: Promise<void> | undefined;
  const testScope: TestScope = {
    application: root,
    window,
    host,
    scheduler,
    interceptors,
    install(module) {
      module.install(context);
    },
    dispose() {
      disposed ??= (async () => {
        live.delete(testScope);
        try {
          await root.dispose();
        } finally {
          schedulerHandle?.dispose();
        }
      })();
      return disposed;
    },
  };
  live.add(testScope);
  for (const module of options?.modules ?? []) testScope.install(module);
  return testScope;
}

const liveApps = new Set<{ dispose(): Promise<void> | void }>();

/** Test applications (createTestApp) register here, so the Vitest setup file disposes them with the test scopes. */
export function trackForDisposal(item: { dispose(): Promise<void> | void }): { dispose(): void } {
  liveApps.add(item);
  return { dispose: () => void liveApps.delete(item) };
}

/** Called by the Vitest setup file in afterEach, before leakCheck(). Collects disposal errors. */
export async function disposeTestScopes(): Promise<void> {
  const errors: unknown[] = [];
  for (const item of [...liveApps].reverse()) {
    try {
      await item.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  liveApps.clear();
  for (const scope of [...live].reverse()) {
    try {
      await scope.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  live.clear();
  if (errors.length > 0) throw new AggregateError(errors, 'Errors while disposing test scopes');
}

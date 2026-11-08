import { createLogger, LogLevel, reportError, type ErrorReporter, type IDisposable, type Logger } from '@tessera/base';
import {
  DockSurfaceFactory,
  DockSurfaceHost,
  ViewMounter,
  type DockSurfaceFactory as DockSurfaceFactoryType,
  type HostEnvironment,
  type PluginDescription,
  type PluginManifest,
  type PluginSource,
  type ServiceModule,
  type ShutdownReason,
  type ShutdownResult,
  type StorageBackend,
  type WindowId,
  type WorkbenchRenderer,
  type DockSurfaceHost as DockSurfaceHostType,
  type LifecycleOptions,
} from '@tessera/contracts';
import type { Scope, ScopeReader } from '@tessera/di';
import { domScheduler, installFocusTracking, installKeyboard } from '@tessera/dom';
import { createApplication, staticPluginCatalog, staticPluginLoader, type Application, type StaticPluginCatalog } from '@tessera/shell';
import { localStorageBackend } from './local-storage-backend.ts';
import { webHostModule } from './web-module.ts';

/** A plugin that the web app ships in its own bundle. Entries load lazily: `() => import('...')` (Vite splits them). */
export interface WebPlugin {
  readonly manifest: PluginManifest;
  /** Loads the `main` entry (the module namespace or a PluginModule). */
  readonly main?: () => unknown;
  /** Loads `ui[rendererId]` entries, for example `{ react: () => import('...') }`. */
  readonly ui?: Readonly<Record<string, () => unknown>>;
  readonly source?: PluginSource;
}

/** What the app gives the host for rendering. The host knows no renderer: this is how React and dockview arrive. */
export interface WebRenderer {
  readonly mounter: ViewMounter<HTMLElement>;
  readonly workbench: WorkbenchRenderer<HTMLElement>;
}

export interface StartWebAppOptions {
  /** The element the workbench renders into. */
  readonly root: HTMLElement;
  readonly plugins: readonly WebPlugin[];
  /** Creates the renderer (for example createReactRenderer). Called once, before start, with the window DI scope. */
  readonly renderer: (services: ScopeReader) => WebRenderer;
  /** Creates the dock surface factory (for example dockviewSurfaceFactory). Without it the renderer draws its fallback. */
  readonly dock?: (services: ScopeReader) => DockSurfaceFactoryType & DockSurfaceHostType<HTMLElement>;
  /** Default: localStorageBackend(). */
  readonly storage?: StorageBackend;
  readonly projectId?: string;
  readonly appVersion?: string;
  readonly isDev?: boolean;
  readonly windowId?: string;
  readonly logger?: Logger;
  readonly errorReporter?: ErrorReporter;
  readonly modules?: readonly ServiceModule[];
  readonly lifecycle?: Partial<LifecycleOptions>;
  /** The browser window. Default: root.ownerDocument.defaultView. */
  readonly view?: Window;
  /** Install the keyboard and focus tracking on the document. Default true. */
  readonly installDomHandlers?: boolean;
  /**
   * Install the global error funnel: window `error` and `unhandledrejection` events are reported with source `global`
   * (the last net for what escapes isolation). Default true.
   */
  readonly installGlobalErrorHandlers?: boolean;
}

export interface WebApp {
  readonly app: Application;
  readonly host: HostEnvironment;
  readonly catalog: StaticPluginCatalog;
  readonly storage: StorageBackend;
  readonly renderer: WebRenderer;
  /** The window DI scope. */
  readonly services: Scope;
  shutdown(reason?: ShutdownReason, options?: { readonly force?: boolean }): Promise<ShutdownResult>;
  dispose(): Promise<void>;
}

/**
 * Boots Tessera in a browser page (contracts.md 17.4 and 19.2): builds the HostEnvironment (localStorage, a static plugin
 * catalog and loader, a DOM scheduler), creates the application with the web host module and the dock and renderer
 * adapters, runs the phases, renders the workbench into `root` and installs the keyboard and focus handlers.
 * Resolves after the restore step (phase Restored).
 */
export async function startWebApp(options: StartWebAppOptions): Promise<WebApp> {
  const root = options.root;
  const view = options.view ?? root.ownerDocument.defaultView;
  if (!view) throw new Error('startWebApp needs a root element that belongs to a window.');
  const windowId = (options.windowId ?? 'w-main') as WindowId;
  const storage = options.storage ?? localStorageBackend({ view, ...(options.projectId === undefined ? {} : { projectId: options.projectId }) });

  const descriptions: PluginDescription[] = [];
  const modules = new Map<string, unknown>();
  for (const plugin of options.plugins) {
    const location = `web://${plugin.manifest.id}/`;
    descriptions.push({ manifest: plugin.manifest, location, source: plugin.source ?? 'builtin' });
    if (plugin.main) modules.set(location, plugin.main);
    for (const [rendererId, load] of Object.entries(plugin.ui ?? {})) modules.set(`${location}#${rendererId}`, load);
  }
  const catalog = staticPluginCatalog(descriptions);
  const logger = options.logger ?? createLogger('tessera.web', { level: options.isDev === false ? LogLevel.Warn : LogLevel.Info });

  let shutdownHook: IDisposable | undefined;
  const host: HostEnvironment = {
    kind: 'web',
    platform: 'web',
    windowId,
    projectId: options.projectId ?? '',
    appVersion: options.appVersion ?? '0.0.0',
    isDev: options.isDev ?? true,
    storage,
    pluginCatalog: catalog,
    pluginLoader: staticPluginLoader(modules),
    scheduler: domScheduler(view),
    logger,
    ...(options.errorReporter ? { errorReporter: options.errorReporter } : {}),
    attachLifecycle(lifecycle) {
      // a closing page cannot await anything: start the shutdown (its joins flush layout and storage) and let it run
      const onPageHide = (): void => void lifecycle.shutdown('close', { force: true });
      view.addEventListener('pagehide', onPageHide);
      shutdownHook = { dispose: () => view.removeEventListener('pagehide', onPageHide) };
      return shutdownHook;
    },
  };

  let renderer!: WebRenderer;
  const adapterModule: ServiceModule = {
    id: '@tessera/host-web/adapters',
    install({ window }) {
      if (options.dock) {
        const dock = options.dock(window);
        window.provideValue(DockSurfaceFactory, dock, { owner: 'host-web' });
        window.provideValue(DockSurfaceHost, dock, { owner: 'host-web' });
      }
      renderer = options.renderer(window);
      window.provideValue(ViewMounter, renderer.mounter, { owner: 'host-web' });
    },
  };

  const app = createApplication({
    host,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    modules: [webHostModule, adapterModule, ...(options.modules ?? [])],
  });

  const handlers: IDisposable[] = [];
  if (options.installGlobalErrorHandlers !== false) handlers.push(installGlobalErrorFunnel(view));
  let rendered: IDisposable | undefined;
  await app.start({
    mount: () => {
      if (options.installDomHandlers !== false) {
        handlers.push(installKeyboard(root.ownerDocument, app.window), installFocusTracking(root.ownerDocument, app.window));
      }
      rendered = renderer.workbench.render(root, windowId);
    },
  });

  let disposed: Promise<void> | undefined;
  const teardown = async (): Promise<void> => {
    for (const h of handlers.splice(0).reverse()) h.dispose();
    rendered?.dispose();
    rendered = undefined;
    (renderer.mounter as Partial<IDisposable>).dispose?.();
    shutdownHook?.dispose();
    catalog.dispose();
    (storage as Partial<IDisposable>).dispose?.();
  };
  return {
    app,
    host,
    catalog,
    storage,
    renderer,
    services: app.window,
    shutdown: async (reason = 'close', shutdownOptions) => {
      const result = await app.shutdown(reason, shutdownOptions);
      if (!result.vetoed) await (disposed ??= teardown());
      return result;
    },
    dispose: async () => {
      // rendering stops first, then the application shuts down (flushing layout and storage), then the host parts go
      for (const h of handlers.splice(0).reverse()) h.dispose();
      rendered?.dispose();
      rendered = undefined;
      await app.dispose();
      await (disposed ??= teardown());
    },
  };
}

/** window `error` and `unhandledrejection` become reportError(…, source 'global'). The events are not prevented: the console still shows them. */
function installGlobalErrorFunnel(view: Window): IDisposable {
  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    reportError(e.error ?? new Error(e.message || 'Uncaught error'), { source: 'global', target: e.filename || 'window.error' });
  };
  const onRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    reportError(reason ?? new Error('Unhandled promise rejection'), { source: 'global', target: 'unhandledrejection' });
  };
  view.addEventListener('error', onError);
  view.addEventListener('unhandledrejection', onRejection);
  return {
    dispose() {
      view.removeEventListener('error', onError);
      view.removeEventListener('unhandledrejection', onRejection);
    },
  };
}

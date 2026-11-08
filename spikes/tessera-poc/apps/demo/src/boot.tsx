import { createRoot } from 'react-dom/client';
import type { StorageBackend } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { dockviewSurfaceFactory } from '@tessera/layout-dockview';
import { startWebApp, localStorageBackend, type WebApp } from '@tessera/host-web';
import { createReactRenderer } from '@tessera/react';
import { Controls, type ControlActions } from './controls.tsx';
import { DEMO_PLUGINS } from './plugins.ts';
import { DEMO_PROJECT } from './seed.ts';

export interface DemoOptions {
  /** The element for the workbench. */
  readonly root: HTMLElement;
  /** The element for the demo buttons and the event log. Optional: tests may skip it. */
  readonly controls?: HTMLElement;
  readonly storage?: StorageBackend;
  readonly actions?: Partial<ControlActions>;
  /** React StrictMode for the whole app. Default true. */
  readonly strictMode?: boolean;
  /** Use dockview for the editor area. Default true. false: the renderer draws its tab fallback (jsdom has no layout engine). */
  readonly dock?: boolean;
}

export interface DemoHandle {
  readonly web: WebApp;
  dispose(): Promise<void>;
}

/**
 * Composes the demo: the web host (localStorage, static plugin catalog and loader), the React renderer, the dockview dock
 * surface and the four sample plugins. The same function runs in the browser page (main.tsx) and in the tests.
 */
export async function bootDemo(options: DemoOptions): Promise<DemoHandle> {
  const strict = options.strictMode ?? true;
  const web = await startWebApp({
    root: options.root,
    plugins: DEMO_PLUGINS,
    projectId: DEMO_PROJECT,
    appVersion: '0.0.0-poc',
    ...(options.storage ? { storage: options.storage } : { storage: localStorageBackend({ projectId: DEMO_PROJECT }) }),
    renderer: (services) => createReactRenderer({ services, strictMode: strict, title: 'Tessera POC' }),
    ...(options.dock === false ? {} : { dock: (services: ScopeReader) => dockviewSurfaceFactory({ services }) }),
  });
  const actions: ControlActions = {
    seedAndReload: options.actions?.seedAndReload ?? (() => undefined),
    resetAndReload: options.actions?.resetAndReload ?? (() => undefined),
    reload: options.actions?.reload ?? (() => undefined),
  };
  const controlsRoot = options.controls ? createRoot(options.controls) : undefined;
  controlsRoot?.render(<Controls services={web.services} actions={actions} />);
  return {
    web,
    async dispose() {
      controlsRoot?.unmount();
      await web.dispose();
    },
  };
}

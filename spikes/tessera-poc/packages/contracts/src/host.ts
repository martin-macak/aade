import type { ErrorReporter, IDisposable, Logger, Scheduler } from '@tessera/base';
import { token, type Token } from '@tessera/di';
import type { EventRelay } from './events.ts';
import type { Box, WindowId } from './ids.ts';
import type { LifecycleService, ShutdownReason } from './lifecycle.ts';
import type { PluginCatalog, PluginLoader } from './plugins.ts';
import type { StorageBackend } from './storage.ts';
import type { Event } from '@tessera/base';

/** contracts.md 17.3. */
export interface WindowsMainService {
  openWindow(options: { readonly projectId?: string }): Promise<{ readonly windowId: string }>;
  closeWindow(windowId: string): Promise<void>;
  focusWindow(windowId: string): Promise<void>;
  setBounds(windowId: string, bounds: Box): Promise<void>;
  registerAuxiliary(windowId: string, auxiliaryId: string): Promise<void>;
  readonly onDidOpenWindow: Event<{ readonly windowId: string }>;
  readonly onDidCloseWindow: Event<{ readonly windowId: string }>;
}

/** contracts.md 17.3: registered by the renderer on its main connection. */
export interface RendererLifecycle {
  checkVeto(reason: ShutdownReason): Promise<{ readonly vetoed: boolean; readonly vetoedBy: readonly string[] }>;
  shutdown(reason: ShutdownReason): Promise<{ readonly timedOut: readonly string[]; readonly failed?: readonly string[]; readonly notStarted?: readonly string[] }>;
}

/** What a host gives the shell (contracts.md 17.4). */
export interface HostEnvironment {
  readonly kind: 'electron' | 'web' | 'test';
  readonly platform: 'mac' | 'win' | 'linux' | 'web';
  readonly windowId: WindowId;
  /** '' when no project is open. */
  readonly projectId: string;
  readonly appVersion: string;
  readonly isDev: boolean;
  readonly storage: StorageBackend;
  readonly pluginCatalog: PluginCatalog;
  readonly pluginLoader: PluginLoader;
  readonly eventRelay?: EventRelay;
  readonly windows?: WindowsMainService;
  readonly scheduler?: Scheduler;
  readonly logger?: Logger;
  readonly errorReporter?: ErrorReporter;
  /**
   * Safe mode (set by the shell from ApplicationOptions.safeMode): only builtin plugins resolve, the stored layout is neither read nor
   * written, and the context key `app.safeMode` is true. A way back into an app that a user plugin or a broken layout keeps from starting.
   */
  readonly safeMode?: boolean;
  /** Registers the close handshake (RendererLifecycle) once the LifecycleService exists. */
  attachLifecycle?(lifecycle: LifecycleService): IDisposable;
  /**
   * Reloads the renderer window, where the host can (Electron: webContents.reload()). The UI offers "Reload window" next to the notice
   * that storage recovered from degraded mode, because a plugin that read its settings in degraded mode has stale values.
   */
  reloadWindow?(): void | Promise<void>;
}
export const HostEnvironment: Token<HostEnvironment> = token<HostEnvironment>('tessera.host');

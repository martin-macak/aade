// Capability 4: plugin lifecycle: lazy activation, deactivation with disposal, failure isolation.
//
// Native (the JupyterLab-style model in @lumino/application + @lumino/coreutils PluginRegistry):
//  - `IPlugin { id, requires, optional, provides, autoStart, activate, deactivate }` with `Token`s.
//  - Lazy by dependency: a plugin with `autoStart: false` is activated the first time another plugin `requires` its token
//    (or by `app.activatePlugin(id)`). Required services are activated first, in dependency order, with cycle detection.
//  - Failure isolation at startup: `start()` activates the autoStart plugins and logs a failure of one without stopping the rest.
//  - `deactivatePlugin(id)` deactivates the dependents first, in order. It throws a TypeError when the plugin OR ANY DEPENDENT has no `deactivate`.
// Not native, and added below:
//  - Contributions before code. In Lumino a command exists only after the plugin's `activate` ran `addCommand`. Here the manifest declares
//    commands and views when the plugin is REGISTERED, so menu and palette show them before any plugin code runs; running one activates the plugin.
//  - Disposal. `deactivate` is a plain callback; Lumino does not track what `activate` registered. Each activation gets a child
//    Scope of the application scope that owns every registration (reverse order, capability 7), and it is disposed on deactivate or on a failed activate.
//  - A `failed` state. `activatePlugin` only rejects; Lumino keeps no record of a failure.
import { type Application } from '@lumino/application';
import { type Token } from '@lumino/coreutils';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { type ViewHost, type ViewType } from './cap1-shared-view.tsx';
import { type CommandDeclaration, type Contributions } from './contributions.ts';
import { Scope } from './cap7-di.ts';

export type PluginState = 'registered' | 'active' | 'failed' | 'inactive';
export type Handler = (args: Record<string, unknown>) => unknown;

export interface PluginContext {
  readonly id: string;
  /** The window scope: resolve window services by token. */
  readonly scope: Scope;
  /** Everything registered through `own` is disposed when the plugin deactivates (or when its activation fails). */
  own<T extends IDisposable>(value: T): T;
  /** Provide the code of a command that the manifest declared. */
  handle(commandId: string, handler: Handler): IDisposable;
}

export interface PluginManifest<S = unknown> {
  id: string;
  autoStart?: boolean | 'defer';
  requires?: Token<any>[];
  optional?: Token<any>[];
  provides?: Token<S>;
  /** Contributed before activation. */
  commands?: Array<Omit<CommandDeclaration, 'execute'>>;
  views?: Array<Omit<ViewType<any>, 'plugin'>>;
  activate(ctx: PluginContext, ...services: any[]): S | Promise<S>;
}

export class PluginHost {
  readonly stateChanged = new Signal<this, { id: string; state: PluginState; error?: unknown }>(this);
  private readonly states = new Map<string, PluginState>();
  private readonly handlers = new Map<string, Handler>();

  constructor(
    private readonly app: Application,
    private readonly appScope: Scope,
    private readonly windowScope: Scope,
    private readonly contributions: Contributions,
    private readonly views: ViewHost,
  ) {}

  state(id: string): PluginState | undefined {
    return this.states.get(id);
  }

  activate(id: string): Promise<void> {
    return this.app.activatePlugin(id);
  }

  deactivate(id: string): Promise<string[]> {
    return this.app.deactivatePlugin(id);
  }

  register(manifest: PluginManifest<any>): void {
    const { id } = manifest;
    this.setState(id, 'registered');
    for (const command of manifest.commands ?? []) this.contributions.declare({ ...command, execute: (args) => this.dispatch(id, command.id, args) });
    for (const view of manifest.views ?? []) this.views.register({ ...view, plugin: id });
    let runtime: Scope | undefined;
    this.app.registerPlugin({
      id,
      autoStart: manifest.autoStart,
      requires: manifest.requires,
      optional: manifest.optional,
      provides: manifest.provides ?? null,
      activate: async (_app, ...services) => {
        const owned = this.appScope.createChild('plugin');
        const ctx: PluginContext = {
          id,
          scope: this.windowScope,
          own: (value) => owned.own(value),
          handle: (commandId, handler) => owned.own(this.addHandler(commandId, handler)),
        };
        try {
          const service = await manifest.activate(ctx, ...services);
          if (manifest.provides) owned.own(this.appScope.bind(manifest.provides, () => service)); // visible to DI in every scope
          runtime = owned;
          this.setState(id, 'active');
          return service;
        } catch (error) {
          try {
            owned.dispose(); // roll back what activate registered before it threw
          } catch {
            // the original error is the one that matters
          }
          this.setState(id, 'failed', error);
          throw error;
        }
      },
      deactivate: async () => {
        this.views.closeWhere((placement) => placement.type.plugin === id);
        runtime?.dispose();
        runtime = undefined;
        this.setState(id, 'inactive');
      },
    });
  }

  private addHandler(commandId: string, handler: Handler): IDisposable {
    if (this.handlers.has(commandId)) throw new Error(`Command "${commandId}" already has a handler`);
    this.handlers.set(commandId, handler);
    return new DisposableDelegate(() => void this.handlers.delete(commandId));
  }

  /** Run a declared command; activates the owning plugin on first use. */
  private async dispatch(pluginId: string, commandId: string, args: Record<string, unknown>): Promise<unknown> {
    let handler = this.handlers.get(commandId);
    if (!handler) {
      await this.app.activatePlugin(pluginId);
      handler = this.handlers.get(commandId);
    }
    if (!handler) throw new Error(`Command "${commandId}" has no handler (plugin "${pluginId}" is ${this.state(pluginId)})`);
    return handler(args);
  }

  private setState(id: string, state: PluginState, error?: unknown): void {
    this.states.set(id, state);
    this.stateChanged.emit({ id, state, ...(error === undefined ? {} : { error }) });
  }
}

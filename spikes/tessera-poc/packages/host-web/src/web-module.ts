import { DisposableStore, type IDisposable } from '@tessera/base';
import {
  CommandRegistry,
  KeybindingService,
  LifecycleContribution,
  LifecyclePhase,
  NotificationService,
  PluginManager,
  QuickInputService,
  type ServiceModule,
} from '@tessera/contracts';
import { injectScope, token, type Scope, type Token } from '@tessera/di';

/** The command that opens the command palette. Renderer-independent: the QuickInputService holds the model. */
export const SHOW_COMMAND_PALETTE = 'workbench.showCommandPalette';
export const RETRY_PLUGIN = 'plugins.retry';

/** Owns the subscriptions and registrations of the web host. Window DI scope: disposed with the window. */
class WebHostBehavior implements IDisposable {
  readonly #store = new DisposableStore('host-web');
  readonly #scope: Scope;

  constructor() {
    this.#scope = injectScope(); // the container creates this object inside the window scope's injection context
  }

  start(): void {
    const scope = this.#scope;
    const registry = scope.get(CommandRegistry);
    this.#store.add(registry.declare({ id: SHOW_COMMAND_PALETTE, title: 'Show Command Palette', category: 'View', owner: 'core', palette: false }));
    this.#store.add(registry.registerHandler(SHOW_COMMAND_PALETTE, { run: () => scope.get(QuickInputService).showCommandPalette() }, 'core'));
    this.#store.add(scope.get(KeybindingService).register({ key: 'mod+shift+p', command: SHOW_COMMAND_PALETTE, source: 'core', owner: 'core' }));

    // a plugin that failed gets a visible error with a retry action (failure isolation, demo item 4)
    const plugins = scope.get(PluginManager);
    const notified = new Set<string>();
    this.#store.add(
      plugins.onDidChangeState((status) => {
        if (status.state !== 'failed' || notified.has(status.id)) return;
        notified.add(status.id);
        scope.get(NotificationService).notify({
          severity: 'error',
          message: `Plugin "${status.id}" failed to activate`,
          ...(status.failure ? { detail: status.failure.error.message } : {}),
          source: status.id,
          actions: [{ title: 'Retry', command: RETRY_PLUGIN, args: { id: status.id } }],
        });
      }),
    );
    this.#store.add(registry.declare({ id: RETRY_PLUGIN, title: 'Retry Plugin Activation', category: 'Plugins', owner: 'core', palette: false }));
    this.#store.add(
      registry.registerHandler<{ id: string }, void>(
        RETRY_PLUGIN,
        {
          run: async (args) => {
            notified.delete(args.id);
            await plugins.retry(args.id);
          },
        },
        'core',
      ),
    );
  }

  dispose(): void {
    this.#store.dispose();
  }
}

const WebHost: Token<WebHostBehavior> = token<WebHostBehavior>('tessera.hostWeb');

/**
 * Small host behaviour that every web app wants and that belongs to no L2 package (see deviations.md):
 * the palette command with its keybinding, and an error notification when a plugin fails to activate.
 */
export const webHostModule: ServiceModule = {
  id: '@tessera/host-web',
  dependsOn: ['@tessera/commands', '@tessera/plugins', '@tessera/workbench'],
  install({ window }) {
    window.provide(WebHost, () => window.createInstance(WebHostBehavior), { owner: 'core' });
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return { id: 'host-web.start', phase: LifecyclePhase.Starting, run: () => scope.get(WebHost).start() };
      },
      { owner: 'core', order: 50 },
    );
  },
};

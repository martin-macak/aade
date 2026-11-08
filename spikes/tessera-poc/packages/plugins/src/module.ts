import { getScheduler } from '@tessera/base';
import { inject, injectScope } from '@tessera/di';
import {
  ActivationService,
  ContributionRegistry,
  HostEnvironment,
  LifecycleContribution,
  LifecyclePhase,
  LifecycleService,
  PluginCatalog,
  PluginManager,
  PluginState,
  SHUTDOWN_ORDER,
  UndoOwnerCheck,
  ViewServicesPolicy,
  type ServiceModule,
} from '@tessera/contracts';
import { DefaultContributionRegistry } from './contribution-registry.ts';
import { DefaultPluginManager } from './plugin-manager.ts';
import { interceptorsPoint } from './points.ts';
import { viewServicesPolicy } from './view-policy.ts';

/**
 * ContributionRegistry (application), PluginManager and ActivationService (window, the same object).
 * Lifecycle contributions: `Starting` defines the `interceptors` point and adds the catalog plugins;
 * `Ready` reports unknown points; `Restored` (after the first paint) activates `*` plugins; `Eventually` activates `onStartupFinished` plugins.
 */
export const pluginsModule: ServiceModule = {
  id: '@tessera/plugins',
  dependsOn: ['@tessera/persistence', '@tessera/commands', '@tessera/events'],
  install({ application, window }) {
    const owner = 'core';
    application.provide(ContributionRegistry, () => new DefaultContributionRegistry(), { owner });
    window.provide(PluginManager, () => window.createInstance(DefaultPluginManager), { owner });
    window.provide(ActivationService, () => inject(PluginManager), { owner });
    // The undo service asks before it takes an entry: a plugin that is not active any more cannot push (undo.ownerGone). Unknown owners (the core) are allowed.
    window.provide(
      UndoOwnerCheck,
      () => {
        const manager = inject(PluginManager);
        return (name: string): boolean => {
          const state = manager.status(name)?.state;
          return state === undefined || state === PluginState.Active || state === PluginState.Activating;
        };
      },
      { owner },
    );
    // The view door of the gate: a view that a plugin owns sees the plugin's gated reader and context facade, not the raw scopes.
    window.provide(ViewServicesPolicy, () => viewServicesPolicy(inject(PluginManager) as DefaultPluginManager), { owner });
    application.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.interceptorsPoint',
          phase: LifecyclePhase.Starting,
          run() {
            scope.get(ContributionRegistry).definePoint(interceptorsPoint);
          },
        };
      },
      { owner, order: -50 },
    );
    // The plugins shutdown step (order 100): close the activation gate and abort every ctx.signal, then deactivate in reverse dependency waves.
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.shutdownStep',
          phase: LifecyclePhase.Starting,
          run() {
            const lifecycle = scope.get(LifecycleService, { optional: true });
            if (!lifecycle) return;
            const manager = scope.get(PluginManager);
            scope.track(
              lifecycle.registerShutdownStep({
                id: 'plugins',
                order: SHUTDOWN_ORDER.plugins,
                close: () => manager.abortAll(),
                async run(deadline) {
                  let result: { readonly notStarted: readonly string[]; readonly timedOut: readonly string[] } | undefined;
                  // deactivateAll honours the deadline itself and reports what it skipped; this race is a backstop that names the stuck plugins.
                  const scheduler = getScheduler();
                  let timer: { dispose(): void } | undefined;
                  const expired = new Promise<'timeout'>((resolve) => void (timer = scheduler.timeout(() => resolve('timeout'), Math.max(0, deadline - scheduler.now()) + 25)));
                  try {
                    const outcome = await Promise.race([manager.deactivateAll({ deadline }).then((r) => void (result = r)), expired]);
                    if (outcome === 'timeout') {
                      const stuck = [...manager.plugins.peek().values()].filter((p) => p.state === PluginState.Active || p.state === PluginState.Deactivating || p.state === PluginState.Activating).map((p) => p.id);
                      return { timedOut: stuck.length > 0 ? stuck : ['plugins.deactivateAll'] };
                    }
                  } finally {
                    timer?.dispose();
                  }
                  return { timedOut: result?.timedOut ?? [], notStarted: result?.notStarted ?? [] };
                },
              }),
            );
          },
        };
      },
      { owner, order: -100 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.catalog',
          phase: LifecyclePhase.Starting,
          async run() {
            const manager = scope.get(PluginManager) as DefaultPluginManager;
            const catalog = await scope.get(PluginCatalog).list();
            // Safe mode: only builtin plugins resolve (a user plugin is what may keep the app from starting).
            const safe = scope.get(HostEnvironment, { optional: true })?.safeMode === true;
            await manager.add(safe ? catalog.filter((d) => d.source === 'builtin') : catalog);
            manager.watchCatalog();
          },
        };
      },
      { owner, order: 1000 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.reportUnknownPoints',
          phase: LifecyclePhase.Ready,
          run() {
            (scope.get(PluginManager) as DefaultPluginManager).reportUnknownPoints();
          },
        };
      },
      { owner, order: 1000 },
    );
    // '*' means "after the first paint" (like VS Code onStartupFinished): Restored comes after mount(), and it is not awaited by the paint.
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.startupStar',
          phase: LifecyclePhase.Restored,
          async run() {
            await scope.get(PluginManager).activateByEvent('*');
          },
        };
      },
      { owner, order: 1000 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'plugins.startupFinished',
          phase: LifecyclePhase.Eventually,
          async run() {
            await scope.get(PluginManager).activateByEvent('onStartupFinished');
          },
        };
      },
      { owner, order: 1000 },
    );
  },
};

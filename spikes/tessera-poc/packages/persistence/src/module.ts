import { TesseraError, reportError } from '@tessera/base';
import { inject, injectScope } from '@tessera/di';
import {
  CommandRegistry,
  ConfigurationService,
  ContextKeyService,
  NotificationService,
  ContributionRegistry,
  InterceptorRegistry,
  LifecycleContribution,
  LifecyclePhase,
  LAYOUT_STORAGE_KEY,
  LifecycleService,
  SHUTDOWN_ORDER,
  StorageBackend,
  StorageService,
  type ServiceModule,
} from '@tessera/contracts';
import { DefaultConfigurationService, configurationPoint } from './configuration-service.ts';
import { DefaultStorageService } from './storage-service.ts';

const STORAGE_RETRY_COMMAND = 'tessera.storage.retryLoad';

/**
 * Registers StorageService and ConfigurationService in the application DI scope. Lifecycle contributions:
 * `Starting` loads both storage scopes, registers the 'storage.flush' shutdown join and defines the `configuration` point.
 */
export const persistenceModule: ServiceModule = {
  id: '@tessera/persistence',
  dependsOn: ['@tessera/lifecycle'],
  install({ application, window }) {
    const owner = 'core';
    application.provide(StorageService, () => new DefaultStorageService(inject(StorageBackend), inject(InterceptorRegistry, { optional: true })), { owner });
    application.provide(ConfigurationService, () => application.createInstance(DefaultConfigurationService), { owner });
    application.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'persistence.storage',
          phase: LifecyclePhase.Starting,
          async run() {
            const storage = scope.get(StorageService);
            // The shutdown step is registered first and always: a failed load does not stop the flush of the degraded session.
            // It runs after the window scope is gone (order 600), so a write of a window-scope disposer is flushed too. One final flush
            // with the remaining time: a write in flight that hangs is abandoned (I32).
            const lifecycle = scope.get(LifecycleService, { optional: true });
            if (lifecycle) {
              scope.track(
                lifecycle.registerShutdownStep({
                  id: 'storage.flush',
                  order: SHUTDOWN_ORDER.storageFinal,
                  async run(deadline) {
                    const { failedKeys } = await storage.flush({ final: true, deadline });
                    if (failedKeys.length === 0) return;
                    reportError(new TesseraError('storage.writeFailed', `${failedKeys.length} storage key(s) could not be written`, { details: { failedKeys } }), { source: 'persistence', target: 'shutdown.flush' });
                    const layoutKey = `project:${LAYOUT_STORAGE_KEY}`;
                    const failed = new Set<string>();
                    for (const key of failedKeys) failed.add(key === layoutKey ? 'layout.flush' : 'storage.flush');
                    return { failed: [...failed] };
                  },
                }),
              );
            }
            await storage.whenReady();
          },
        };
      },
      { owner, order: -100 },
    );
    // Degraded mode (the load failed): say so with a context key and one notification with a Retry action. The window scope sees
    // the services of the workbench (notifications, commands); the storage itself is an application service.
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'persistence.degradedNotice',
          phase: LifecyclePhase.Ready,
          run() {
            const storage = scope.get(StorageService);
            if (!storage.degraded.peek()) return;
            const contextKeys = scope.get(ContextKeyService, { optional: true });
            contextKeys?.root.set('storage.degraded', true);
            const commands = scope.get(CommandRegistry, { optional: true });
            // everything registered here ends with the window scope
            if (commands) {
              scope.track(commands.declare({ id: STORAGE_RETRY_COMMAND, title: 'Retry loading settings', owner: 'core', palette: false }));
              scope.track(commands.registerHandler(STORAGE_RETRY_COMMAND, { run: async () => void (await storage.retryLoad()) }, 'core'));
            }
            const notice = scope.get(NotificationService, { optional: true })?.notify({
              severity: 'warning',
              message: 'Settings and layout could not be loaded. Changes in this session will not be saved.',
              actions: [{ title: 'Retry', command: STORAGE_RETRY_COMMAND }],
            });
            if (notice) scope.track(notice);
            scope.track(
              storage.degraded.subscribe((degraded) => {
                if (!degraded) contextKeys?.root.set('storage.degraded', false);
              }),
            );
          },
        };
      },
      { owner, order: -50 },
    );
    application.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'persistence.configurationPoint',
          phase: LifecyclePhase.Starting,
          run() {
            const registry = scope.get(ContributionRegistry, { optional: true });
            registry?.definePoint(configurationPoint);
            (scope.get(ConfigurationService) as DefaultConfigurationService).start();
          },
        };
      },
      { owner, order: -50 },
    );
  },
};

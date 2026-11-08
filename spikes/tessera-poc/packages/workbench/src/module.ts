import { injectScope } from '@tessera/di';
import {
  ContributionRegistry,
  DialogService,
  DockSurfaceFactory,
  HostEnvironment,
  LayoutStore,
  LifecycleContribution,
  LifecyclePhase,
  LifecycleService,
  NotificationService,
  QuickInputService,
  SHUTDOWN_ORDER,
  SelectionService,
  ViewInstanceRegistry,
  ViewRegistry,
  WorkbenchAdapterApi,
  WorkbenchService,
  type ServiceModule,
} from '@tessera/contracts';
import { computed } from '@tessera/reactive';
import { DefaultViewInstanceRegistry } from './instances.ts';
import { DefaultLayoutStore } from './layout-store.ts';
import { DefaultDialogService } from './dialog-model.ts';
import { DefaultNotificationService } from './notifications.ts';
import { viewsHandler, viewsPoint, workspacesPoint } from './points.ts';
import { DefaultQuickInputService } from './quick-input.ts';
import { DefaultSelectionService } from './selection.ts';
import { DefaultViewRegistry } from './view-registry.ts';
import { DefaultWorkbenchService } from './workbench-service.ts';

/**
 * Application scope: ViewRegistry, the `views` point. Window scope: view instances, workbench (service and adapter
 * port, one object), selection, notifications, quick input, layout store, the `workspaces` point, the `workbench.*`
 * commands. Ready contributions load the layout (restore steps 2 to 6) before plugins with activation event `*` run.
 */
export const workbenchModule: ServiceModule = {
  id: '@tessera/workbench',
  dependsOn: ['@tessera/commands', '@tessera/workitems', '@tessera/persistence', '@tessera/plugins', '@tessera/lifecycle'],
  install({ application, window }) {
    const owner = 'core';
    application.provide(ViewRegistry, () => new DefaultViewRegistry(), { owner });
    window.provide(ViewInstanceRegistry, () => new DefaultViewInstanceRegistry(window.get(ViewRegistry)), { owner });
    window.provide(LayoutStore, () => new DefaultLayoutStore(window.get(HostEnvironment).appVersion), { owner });
    window.provide(WorkbenchService, () => window.createInstance(DefaultWorkbenchService), { owner });
    window.provide(WorkbenchAdapterApi, () => window.get(WorkbenchService) as DefaultWorkbenchService, { owner });
    window.provide(
      SelectionService,
      () => new DefaultSelectionService(computed(() => window.get(WorkbenchService).state.get().focus, { name: 'selection.focus' })),
      { owner },
    );
    window.provide(NotificationService, () => new DefaultNotificationService(), { owner });
    window.provide(DialogService, () => new DefaultDialogService(), { owner });
    window.provide(QuickInputService, () => window.createInstance(DefaultQuickInputService), { owner });

    application.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'workbench.viewsPoint',
          phase: LifecyclePhase.Starting,
          run() {
            scope.get(ContributionRegistry).definePoint(viewsPoint, viewsHandler(scope));
          },
        };
      },
      { owner, order: -80 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'workbench.start',
          phase: LifecyclePhase.Starting,
          run() {
            const workbench = scope.get(WorkbenchService) as DefaultWorkbenchService;
            scope.get(ContributionRegistry).definePoint(workspacesPoint, { apply: (c) => workbench.addWorkspaceDef(c.value, c.pluginId) });
            workbench.registerCommands();
            if (scope.has(DockSurfaceFactory)) workbench.ensureSurfaces();
            const lifecycle = scope.get(LifecycleService, { optional: true });
            if (lifecycle) {
              // Shutdown steps of the workbench: let background work settle (200), then write the layout snapshot into storage (400).
              // The storage flush itself is the persistence step (600): one write at the end, one deadline.
              scope.track(lifecycle.registerShutdownStep({ id: 'workbench.settle', order: SHUTDOWN_ORDER.settle, run: () => workbench.settle() }));
              scope.track(
                lifecycle.registerShutdownStep({
                  id: 'layout.flush',
                  order: SHUTDOWN_ORDER.layout,
                  run: () => {
                    (scope.get(LayoutStore) as DefaultLayoutStore).commit();
                    return Promise.resolve();
                  },
                }),
              );
            }
            lifecycle?.onBeforeShutdown((e) => workbench.beforeShutdown(e)); // a dirty presenter vetoes the quit
          },
        };
      },
      { owner, order: -80 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'workbench.restore',
          phase: LifecyclePhase.Ready,
          async run() {
            await (scope.get(WorkbenchService) as DefaultWorkbenchService).loadLayout();
          },
        };
      },
      { owner, order: 0 },
    );
  },
};

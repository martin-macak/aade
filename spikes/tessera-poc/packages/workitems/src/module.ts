import { inject } from '@tessera/di';
import { ContextKeyService, CurrentWorkItem, EventBus, EventNode, WorkItemService, type ServiceModule } from '@tessera/contracts';
import { DefaultWorkItemService } from './service.ts';

/**
 * Registers `WorkItemService` and `CurrentWorkItem` in the window DI scope.
 * The service creates the root WorkItem on first use. The root WorkItem is the window itself: it uses the window DI scope,
 * the window event node (from `@tessera/events`) and a new context-key scope 'window' (a child of the application scope
 * from `@tessera/commands`). The shell resolves `WorkItemService` while it boots the window.
 * Child WorkItems add their own `CurrentWorkItem` and `EventNode` to their DI scope.
 */
export const workItemsModule: ServiceModule = {
  id: '@tessera/workitems',
  dependsOn: ['@tessera/events', '@tessera/commands'],
  install({ window }) {
    window.provide(
      WorkItemService,
      () => new DefaultWorkItemService(inject(EventBus), window, inject(EventNode), inject(ContextKeyService).root.createChild('window')),
      { owner: 'core' },
    );
    window.provide(CurrentWorkItem, () => inject(WorkItemService).root, { owner: 'core' });
  },
};

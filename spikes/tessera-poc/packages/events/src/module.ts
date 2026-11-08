import { inject } from '@tessera/di';
import { EventBus, EventNode, InterceptorRegistry, type ServiceModule } from '@tessera/contracts';
import { DefaultEventBus } from './bus.ts';

/**
 * Registers the EventBus (application DI scope) and the EventNode tokens: the root node in the application scope
 * and one child node per window (its id is the window DI scope path). WorkItem nodes are added by @tessera/workitems.
 */
export const eventsModule: ServiceModule = {
  id: '@tessera/events',
  install({ application, window }) {
    application.provide(
      EventBus,
      () => {
        const interceptors = inject(InterceptorRegistry, { optional: true });
        return new DefaultEventBus(interceptors ? { rootId: application.path, interceptors } : { rootId: application.path });
      },
      { owner: 'core' },
    );
    application.provide(EventNode, () => inject(EventBus).root, { owner: 'core' });
    if (window !== application) {
      window.provide(EventNode, () => inject(EventBus).createNode(inject(EventBus).root, window.path), { owner: 'core' });
    }
  },
};

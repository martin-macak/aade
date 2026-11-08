import { ContextKeyService, EventBus, WorkItemService, type ContextKeyService as ContextKeyServiceType, type EventBus as EventBusType, type WorkItemService as WorkItemServiceType } from '@tessera/contracts';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { createTestScope, type TestScope } from '@tessera/testing';
import { workItemsModule } from '@tessera/workitems';

export interface Kit {
  readonly t: TestScope;
  readonly bus: EventBusType;
  readonly service: WorkItemServiceType;
  readonly keys: ContextKeyServiceType;
}

/** application > window (= root WorkItem) with events, commands (context keys) and workitems installed. */
export function kit(): Kit {
  const t = createTestScope({ modules: [eventsModule, commandsModule, workItemsModule] });
  return { t, bus: t.window.get(EventBus), service: t.window.get(WorkItemService), keys: t.window.get(ContextKeyService) };
}

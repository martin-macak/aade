import { describe, expect, it } from 'vitest';
import type { StateSchema } from '@tessera/base';
import { ContextKeyService, EventBus, StorageBackend, StorageService, WorkItemService } from '@tessera/contracts';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { persistenceModule, type DefaultStorageService } from '@tessera/persistence';
import { createTestScope } from '@tessera/testing';
import { workItemsModule } from '@tessera/workitems';

const schema: StateSchema<number> = { version: 1, schema: { safeParse: (i) => (typeof i === 'number' ? { success: true, data: i } : { success: false, error: { issues: [] } }) }, initial: () => 0 };

async function setup() {
  const t = createTestScope({ modules: [eventsModule, commandsModule, persistenceModule, workItemsModule] });
  t.application.provideValue(StorageBackend, t.host.storage);
  const storage = t.window.get(StorageService) as DefaultStorageService;
  await storage.whenReady();
  void t.window.get(EventBus);
  void t.window.get(ContextKeyService);
  return { t, storage, service: t.window.get(WorkItemService) };
}

describe('round 2: WorkItem state and mementos', () => {
  it('C8: 10,000 create, memento and terminate cycles leave no memento in the storage service', async () => {
    const { storage, service } = await setup();
    for (let i = 0; i < 10_000; i++) {
      const item = service.root.createChild(`cycle-${i % 5}`);
      item.memento('state', schema).set(i);
      await item.terminate();
    }
    expect(storage.mementoCount).toBe(0);
  });

  it('C8: terminate() keeps the stored state (restore after a teardown works); terminate({ discardState }) deletes the keys of the item and its children only', async () => {
    const { storage, service } = await setup();
    const tasks = service.root.createChild('tasks');
    const child = tasks.createChild('a');
    const sibling = service.root.createChild('tasks2');
    tasks.memento('filter', schema).set(1);
    child.memento('filter', schema).set(2);
    sibling.memento('filter', schema).set(3);
    await storage.flush();
    await sibling.terminate(); // a normal end (a deactivation, a shutdown): the state stays for the next session
    expect(storage.keys('project', 'workItem:')).toContain('workItem:root/tasks2:filter');
    await tasks.terminate({ discardState: true });
    expect(storage.keys('project', 'workItem:')).toEqual(['workItem:root/tasks2:filter']); // 'root/tasks' and 'root/tasks/a' are gone, tasks2 is not a prefix match
  });
});

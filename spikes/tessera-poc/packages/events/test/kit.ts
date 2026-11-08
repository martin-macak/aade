import { EventBus, EventNode, type EventBus as EventBusType, type EventNode as EventNodeType } from '@tessera/contracts';
import { createTestScope, type TestScope } from '@tessera/testing';
import { eventsModule } from '@tessera/events';

export interface Tree {
  readonly t: TestScope;
  readonly bus: EventBusType;
  /** application root */
  readonly app: EventNodeType;
  /** the window node (root WorkItem) */
  readonly win: EventNodeType;
  /** WorkItem root/tasks */
  readonly tasks: EventNodeType;
  /** child WorkItem root/tasks/project-a */
  readonly a: EventNodeType;
  /** child WorkItem root/tasks/project-b */
  readonly b: EventNodeType;
  /** an unrelated WorkItem root/other */
  readonly other: EventNodeType;
}

/** application > window > tasks > (project-a, project-b) and window > other. */
export function tree(): Tree {
  const t = createTestScope({ modules: [eventsModule] });
  const bus = t.window.get(EventBus);
  const win = t.window.get(EventNode);
  const tasks = bus.createNode(win, 'root/tasks');
  const a = bus.createNode(tasks, 'root/tasks/project-a');
  const b = bus.createNode(tasks, 'root/tasks/project-b');
  const other = bus.createNode(win, 'root/other');
  return { t, bus, app: bus.root, win, tasks, a, b, other };
}

import { useEffect, useState, type ReactElement } from 'react';
import type { IDisposable } from '@tessera/base';
import { defineTopic, WorkItemService, type WorkItem } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';

// Demo item 6: the WorkItem event log. sample.tasks publishes every change three times (global, descendants, workItem). This
// panel subscribes at four WorkItem nodes and shows which publication reached which node: the CAB EventBroker scopes.
interface TaskChanged {
  readonly kind: string;
  readonly open: number;
  readonly published: 'global' | 'workItem' | 'descendants';
}
const TasksChanged = defineTopic<TaskChanged>('tasks.changed');
const NODES = ['root', 'root/tasks', 'root/tasks/project-a', 'root/tasks/project-b'];

interface Line {
  readonly n: number;
  readonly node: string;
  readonly published: string;
  readonly kind: string;
  readonly open: number;
}

export function EventLog({ services }: { readonly services: ScopeReader }): ReactElement {
  const [lines, setLines] = useState<readonly Line[]>([]);
  useEffect(() => {
    const items = services.get(WorkItemService);
    const subscriptions = new Map<string, IDisposable>();
    let n = 0;
    const attach = (item: WorkItem): void => {
      if (!NODES.includes(item.path) || subscriptions.has(item.path)) return;
      subscriptions.set(
        item.path,
        item.events.subscribe(TasksChanged, (event) => setLines((all) => [{ n: ++n, node: item.path, published: event.published, kind: event.kind, open: event.open }, ...all].slice(0, 60))),
      );
    };
    attach(items.root);
    for (const path of NODES) {
      const found = items.find(path);
      if (found) attach(found);
    }
    const created = items.onDidCreate(attach);
    return () => {
      created.dispose();
      for (const s of subscriptions.values()) s.dispose();
    };
  }, [services]);
  return (
    <details className="demo-events" data-demo-events open>
      <summary>WorkItem event log: tasks.changed ({lines.length})</summary>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>node</th>
            <th>publish scope</th>
            <th>change</th>
            <th>open</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.n} data-node={l.node} data-published={l.published}>
              <td>{l.n}</td>
              <td>{l.node}</td>
              <td>{l.published}</td>
              <td>{l.kind}</td>
              <td>{l.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

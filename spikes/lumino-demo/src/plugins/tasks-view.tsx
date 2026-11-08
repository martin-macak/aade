// The React view of the sample tasks plugin. Loaded lazily (dynamic import) the first time a placement is created.
// It uses two Radix UI components: Popover (renders in a portal) and Checkbox (renders a hidden form input and measures itself).
import * as Checkbox from '@radix-ui/react-checkbox';
import * as Popover from '@radix-ui/react-popover';
import { useEffect } from 'react';
import { useLocal, usePlacement, useSignal } from '../cap1-shared-view.tsx';
import { ICommands, ICurrentWorkItem, IWorkspaces } from '../tokens.ts';
import { ITasks } from './task-store.ts';
import { type TaskListLocal } from './tasks.ts';

export default function TasksList() {
  const placement = usePlacement<TaskListLocal>();
  const { store } = placement.scope.get(ITasks); // shared state: one store for every placement
  const tasks = useSignal(store.changed, () => store.tasks);
  const selectedId = useSignal(store.changed, () => store.selectedId);
  const [local, patch] = useLocal<TaskListLocal>(); // per-placement state
  const workItem = placement.scope.tryGet(ICurrentWorkItem);
  const project = workItem?.parent ? workItem.id : null; // a view below a project WorkItem shows only that project
  const shown = tasks.filter((t) => (project ? t.project === project : true) && t.title.toLowerCase().includes(local.query.toLowerCase()));

  useEffect(() => {
    placement.widget.title.closable = !local.pinned; // local state reaches the Lumino tab
  }, [placement, local.pinned]);

  return (
    <section className="tasks" data-testid={`tasks-${placement.id}`}>
      <header>
        <input aria-label="Filter" placeholder="Filter (this view)" value={local.query} onChange={(e) => patch({ query: e.target.value })} />
        <label className="pinned">
          <Checkbox.Root className="checkbox" checked={local.pinned} onCheckedChange={(v) => patch({ pinned: v === true })} aria-label="Pinned">
            <Checkbox.Indicator>x</Checkbox.Indicator>
          </Checkbox.Root>
          Pinned
        </label>
        <Popover.Root>
          <Popover.Trigger className="details">Details</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="popover" sideOffset={4} data-testid="popover">
              <p>{tasks.length} tasks in the shared store</p>
              <p>Placement {placement.id}</p>
              <p>Workspace {placement.scope.get(IWorkspaces).whereIs(placement.widget) ?? 'none'}</p>
              <Popover.Close className="close">Close</Popover.Close>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button onClick={() => void placement.scope.get(ICommands).execute('tasks.add', project ? { project } : {})}>Add</button>
      </header>
      <ul>
        {shown.map((t) => (
          <li key={t.id} className={`${t.done ? 'done' : ''} ${t.id === selectedId ? 'selected' : ''}`} onClick={() => store.select(t.id === selectedId ? null : t.id)}>
            {t.title} <small>{t.project}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

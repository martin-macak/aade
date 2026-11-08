import { useLayoutEffect, useRef } from 'react';
import { defineReactUi, defineReactView, type ReactUiModule, type ReactViewProps } from '@tessera/react/ui';
import type { TaskListIntents, TaskListState } from './task-list.ts';

// The React view of tasks.list. It reads `state` and calls `intents`, nothing else (poc-plan C26): no store, no command
// service, no business rule. The only state it owns is purely visual (the scroll position it reports and restores).

function TaskListView({ state, intents }: ReactViewProps<TaskListState, TaskListIntents>) {
  const scroller = useRef<HTMLDivElement>(null);

  // restore the stored scroll position once, when the view is mounted (a remounted view keeps its place)
  const initialTop = useRef(state.scrollTop);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = initialTop.current;
  }, []);

  return (
    <div className="tasks-view" data-testid="tasks-view">
      <div className="tasks-toolbar">
        <label>
          Filter (shared)
          <input type="text" aria-label="Shared filter" value={state.sharedFilter} onChange={(e) => intents.setSharedFilter(e.target.value)} />
        </label>
        <label>
          Filter (this view)
          <input type="text" aria-label="Local filter" value={state.localFilter} onChange={(e) => intents.setLocalFilter(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" aria-label="Pin this view" checked={state.pinned} onChange={(e) => intents.setPinned(e.target.checked)} /> Pinned
        </label>
        <button type="button" onClick={() => void intents.add()}>
          Add task
        </button>
      </div>
      <div
        className="tasks-scroll"
        ref={scroller}
        style={{ overflow: 'auto', maxHeight: '100%' }}
        onScroll={(e) => intents.scrolled(Math.round(e.currentTarget.scrollTop))}
      >
        {state.groups.length === 0 ? <p className="tasks-empty">No tasks match.</p> : null}
        {state.groups.map((group) => (
          <section key={group.project} className="tasks-group">
            <h3>
              <button type="button" aria-expanded={group.expanded} onClick={() => intents.toggleGroup(group.project)}>
                {group.expanded ? '▾' : '▸'} {group.title}
              </button>
              <span className="tasks-count"> ({group.rows.length})</span>
            </h3>
            {group.expanded ? (
              <ul role="listbox" aria-label={group.title}>
                {group.rows.map((row) => (
                  <li
                    key={row.id}
                    role="option"
                    aria-selected={row.selected}
                    data-task-id={row.id}
                    className={row.selected ? 'task task-selected' : 'task'}
                    style={{ textDecoration: row.done ? 'line-through' : 'none', fontWeight: row.selected ? 600 : 400, cursor: 'pointer' }}
                    onClick={() => intents.select(row.selected ? undefined : row.id)}
                  >
                    <span>{row.title}</span>{' '}
                    {row.done ? null : (
                      <button
                        type="button"
                        aria-label={`Complete ${row.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void intents.complete(row.id);
                        }}
                      >
                        Done
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
      <p className="tasks-summary" aria-live="polite">
        {state.remaining} of {state.total} open
      </p>
    </div>
  );
}

const ui: ReactUiModule = defineReactUi([defineReactView<TaskListState, TaskListIntents>('tasks.list', TaskListView)]);

export default ui;

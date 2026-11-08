// The sample tasks plugin (domain code): token, commands, view type, WorkItems, events, local-state migration.
// It declares its commands and views in the manifest (visible before its code runs) and registers handlers in `activate`.
import { DisposableDelegate } from '@lumino/disposable';
import { type PluginManifest } from '../cap4-plugins.ts';
import { IContextKeys, IRootEvents, IWorkItems } from '../tokens.ts';
import { ITasks, TaskStore, TasksChanged, type TaskChange, type TasksModule } from './task-store.ts';

export interface TaskListLocal {
  query: string;
  pinned: boolean;
}

export const tasksPlugin: PluginManifest<TasksModule> = {
  id: 'sample.tasks',
  provides: ITasks,
  commands: [
    { id: 'tasks.add', label: 'Add Task', menu: 'Tasks', palette: 'Tasks', keys: ['Accel Alt T'] },
    { id: 'tasks.complete', label: 'Complete Task', menu: 'Tasks', palette: 'Tasks', enabledWhen: (keys) => keys.get('tasks.hasSelection') === true },
  ],
  views: [
    {
      id: 'tasks.list',
      title: 'Tasks',
      defaultLocal: { query: '', pinned: false } satisfies TaskListLocal,
      stateVersion: 2,
      // v1 kept the filter text in `filter`; v2 renamed it to `query` and added `pinned`.
      migrateState: (from, state): TaskListLocal => {
        const old = (state ?? {}) as { filter?: string; query?: string; pinned?: boolean };
        return from < 2 ? { query: old.filter ?? '', pinned: false } : { query: old.query ?? '', pinned: old.pinned ?? false };
      },
      load: () => import('./tasks-view.tsx'),
    },
  ],
  activate(ctx) {
    const root = ctx.scope.get(IRootEvents);
    const keys = ctx.scope.get(IContextKeys);
    // The plugin owns its WorkItems: tasks, with project-a and project-b below it. They end when the plugin deactivates.
    const tasksItem = ctx.own(ctx.scope.get(IWorkItems).create('tasks'));
    const projects = new Map([
      ['project-a', tasksItem.createChild('project-a')],
      ['project-b', tasksItem.createChild('project-b')],
    ]);
    // Every change is published three times: global (every node), descendants (from `tasks` down), workItem (the project only).
    const store: TaskStore = new TaskStore((change: TaskChange) => {
      root.publish(TasksChanged, { ...change, published: 'global' }, 'global');
      tasksItem.events.publish(TasksChanged, { ...change, published: 'descendants' }, 'descendants');
      (projects.get(change.task.project)?.events ?? tasksItem.events).publish(TasksChanged, { ...change, published: 'workItem' }, 'workItem');
    });
    const onChanged = (): void => keys.set('tasks.hasSelection', store.selectedId !== null);
    store.changed.connect(onChanged);
    ctx.own(
      new DisposableDelegate(() => {
        store.changed.disconnect(onChanged);
        keys.set('tasks.hasSelection', false);
      }),
    );
    ctx.handle('tasks.add', (args) => store.add(typeof args['title'] === 'string' ? args['title'] : `Task ${store.tasks.length + 1}`, typeof args['project'] === 'string' ? args['project'] : undefined).id);
    ctx.handle('tasks.complete', (args) => {
      const id = typeof args['id'] === 'number' ? args['id'] : store.selectedId;
      if (id === null) throw new Error('Select a task first');
      return store.complete(id);
    });
    return { store, root: tasksItem, projects };
  },
};

import {
  CommandService,
  SelectionService,
  definePlugin,
  inject,
  transact,
  TesseraError,
} from '@tessera/plugin-api';
import type { PluginContext, PluginModule, ViewProvider, PluginWorkItem } from '@tessera/plugin-api';
import { AddTask, ClearCompleted, CompleteTask } from './commands.ts';
import { TaskListPresenter, TaskListViewModel, TaskSelection, localSchema, sharedSchema, type TaskListLocal, type TaskListShared } from './task-list.ts';
import { MementoTaskStore, TaskStore, TasksChanged, storedTasksSchema, type ProjectId, type TaskChange } from './task-store.ts';

export { TaskSelection, TasksChanged, TaskStore };
export { AddTask, ClearCompleted, CompleteTask } from './commands.ts';
export type { ProjectId, Task, TaskChange } from './task-store.ts';

/** sample.tasks (poc-plan section 3): WorkItems, the TaskStore token, the tasks.list view type, commands and events. */
const plugin: PluginModule = definePlugin({
  activate(ctx: PluginContext): void {
    // WorkItems: tasks, and tasks/project-a and tasks/project-b below it. The plugin owns them: they end when it deactivates.
    const tasksItem: PluginWorkItem = ctx.workItems.create('tasks');
    const projectItems = new Map<ProjectId, PluginWorkItem>([
      ['project-a', tasksItem.createChild('project-a')],
      ['project-b', tasksItem.createChild('project-b')],
    ]);

    // Every change is published three times: global (every node), descendants (from tasks down) and workItem (the project only).
    const announce = (change: Omit<TaskChange, 'published'>): void => {
      transact(() => {
        ctx.api.events.publish(TasksChanged, { ...change, published: 'global' });
        tasksItem.events.publish(TasksChanged, { ...change, published: 'descendants' }, { scope: 'descendants' });
        (projectItems.get(change.project) ?? tasksItem).events.publish(TasksChanged, { ...change, published: 'workItem' }, { scope: 'workItem' });
      });
    };

    // The domain model: persisted in the project storage scope, provided through the token.
    const store = new MementoTaskStore(ctx.storage.project.memento('tasks', storedTasksSchema), announce);
    ctx.services.provide(TaskStore, () => store);

    // Commands. Declared in the manifest (visible in palette and menus before this code runs); handlers are registered here.
    ctx.api.commands.registerHandler(AddTask, {
      run(args, command) {
        const task = store.add(args?.title ?? `Task ${store.tasks.peek().length + 1}`, args?.project);
        command.pushUndo({
          label: `Add task "${task.title}"`,
          code: 'tasks.add',
          resource: 'sample.tasks',
          undo: () => void store.remove(task.id),
          redo: () => void store.add(task.title, task.project, task.id),
        });
        return { id: task.id };
      },
    });
    ctx.api.commands.registerHandler(CompleteTask, {
      run(args, command) {
        const id = args?.id ?? command.services.get(SelectionService).of(TaskSelection).peek()[0]?.id;
        if (id === undefined) throw new TesseraError('command.invalidArgs', 'Select a task first');
        if (!store.complete(id)) return { id, changed: false };
        command.pushUndo({ label: 'Complete task', code: 'tasks.complete', resource: 'sample.tasks', undo: () => void store.reopen(id), redo: () => void store.complete(id) });
        return { id, changed: true };
      },
    });
    ctx.api.commands.registerHandler(ClearCompleted, { run: () => ({ removed: store.clearCompleted() }) });

    // The view type. The view model runs in the view DI scope (inject works there), the presenter in the placement DI scope.
    const provider: ViewProvider<TaskListViewModel, unknown, unknown, TaskListShared, TaskListLocal> = {
      viewType: 'tasks.list',
      sharedState: sharedSchema,
      localState: localSchema,
      createViewModel: (vmCtx) => new TaskListViewModel(inject(TaskStore), vmCtx.shared),
      createPresenter: (pCtx) => {
        const commands = inject(CommandService);
        return new TaskListPresenter({
          viewModel: pCtx.viewModel,
          local: pCtx.local,
          context: pCtx.context,
          selection: pCtx.selection,
          // commands run in this placement's context, so enablement reads this placement's context keys
          commands: { run: (command, args) => commands.run(command, args, { source: 'view', context: pCtx.context, placementId: pCtx.placement.id }) },
        });
      },
    };
    ctx.views.registerProvider(provider);
  },
});

export default plugin;

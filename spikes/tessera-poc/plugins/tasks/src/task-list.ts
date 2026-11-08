import { computed, effect, selectionType } from '@tessera/plugin-api';
import type { CommandDef, IDisposable, Observable, Presenter, SelectionPublisher, SelectionType, State, StateSchema } from '@tessera/plugin-api';
import { PROJECTS, type ProjectId, type Task, type TaskStore } from './task-store.ts';
import { isRecord, stateSchema } from './schemas.ts';
import { AddTask, CompleteTask } from './commands.ts';

// The tasks.list view type as MVP (Presentation Model): a view model shared by every placement of the instance, and one
// presenter per placement. Nothing here imports a renderer, the DOM or Electron: presenters test in Node.

/** Typed selection (contracts.md 15.10): what the focused tasks.list placement has selected. */
export const TaskSelection: SelectionType<Task> = selectionType<Task>('sample.tasks/Task');

// ----- state schemas -----------------------------------------------------------------------------

/** Shared by every placement of the instance. */
export interface TaskListShared {
  readonly selectedId: string | undefined;
  readonly filter: string;
}
export const sharedSchema: StateSchema<TaskListShared> = stateSchema<TaskListShared>(
  1,
  (i) => (isRecord(i) && typeof i['filter'] === 'string' ? undefined : 'expected { filter: string }'),
  () => ({ selectedId: undefined, filter: '' }),
);

/** Local to one placement. Version 2 added localFilter and pinned. Version 1 had scrollTop and expandedGroups only. */
export interface TaskListLocal {
  readonly scrollTop: number;
  readonly expandedGroups: readonly ProjectId[];
  readonly localFilter: string;
  /** A pinned placement cannot be closed: sample.audit vetoes workbench.closePlacement for it. */
  readonly pinned: boolean;
}
export interface TaskListLocalV1 {
  readonly scrollTop: number;
  readonly expandedGroups: readonly ProjectId[];
}
export const LOCAL_STATE_VERSION = 2;
export const localSchema: StateSchema<TaskListLocal> = stateSchema<TaskListLocal>(
  LOCAL_STATE_VERSION,
  (i) =>
    isRecord(i) && typeof i['scrollTop'] === 'number' && Array.isArray(i['expandedGroups']) && typeof i['localFilter'] === 'string' && typeof i['pinned'] === 'boolean'
      ? undefined
      : 'expected { scrollTop, expandedGroups, localFilter, pinned }',
  () => ({ scrollTop: 0, expandedGroups: [...PROJECTS], localFilter: '', pinned: false }),
  [{ from: 1, migrate: (data) => ({ ...(data as TaskListLocalV1), localFilter: '', pinned: false }) satisfies TaskListLocal }],
);

// ----- view model (shared) ----------------------------------------------------------------------

export class TaskListViewModel {
  readonly selectedId: Observable<string | undefined>;
  readonly sharedFilter: Observable<string>;
  /** Tasks that match the shared filter. Computed once for all placements. */
  readonly visibleTasks: Observable<readonly Task[]>;
  readonly selectedTask: Observable<Task | undefined>;
  readonly store: TaskStore;
  readonly #shared: State<TaskListShared>;

  constructor(store: TaskStore, shared: State<TaskListShared>) {
    this.store = store;
    this.#shared = shared;
    this.selectedId = computed(() => shared.get().selectedId, { name: 'taskList.selectedId' });
    this.sharedFilter = computed(() => shared.get().filter, { name: 'taskList.sharedFilter' });
    this.visibleTasks = computed(
      () => {
        const filter = shared.get().filter.trim().toLowerCase();
        const all = store.tasks.get();
        return filter === '' ? all : all.filter((t) => t.title.toLowerCase().includes(filter));
      },
      { name: 'taskList.visibleTasks' },
    );
    this.selectedTask = computed(() => store.tasks.get().find((t) => t.id === shared.get().selectedId), { name: 'taskList.selectedTask' });
  }

  select(id: string | undefined): void {
    this.#shared.update((s) => ({ ...s, selectedId: id }));
  }

  setFilter(filter: string): void {
    this.#shared.update((s) => ({ ...s, filter }));
  }
}

// ----- presenter (one per placement) ------------------------------------------------------------

/** Display names of the projects. A project that is not listed shows its id. */
const PROJECT_TITLES: Readonly<Record<string, string>> = { 'project-a': 'Project A', 'project-b': 'Project B' };

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly selected: boolean;
}
export interface TaskGroup {
  readonly project: ProjectId;
  /** The label of the group: presentation data belongs to the view model side (MVP), so a second renderer does not copy a table. */
  readonly title: string;
  readonly expanded: boolean;
  readonly rows: readonly TaskRow[];
}
export interface TaskListState {
  readonly groups: readonly TaskGroup[];
  readonly selectedId: string | undefined;
  readonly remaining: number;
  readonly total: number;
  readonly scrollTop: number;
  readonly sharedFilter: string;
  readonly localFilter: string;
  readonly pinned: boolean;
}

export interface TaskListIntents {
  select(id: string | undefined): void;
  scrolled(top: number): void;
  toggleGroup(project: ProjectId): void;
  setLocalFilter(text: string): void;
  setSharedFilter(text: string): void;
  setPinned(pinned: boolean): void;
  add(title?: string): Promise<void>;
  complete(id?: string): Promise<void>;
}

/** What the presenter needs from the framework, as small ports. It makes the presenter testable without the workbench. */
export interface TaskListPorts {
  readonly viewModel: TaskListViewModel;
  readonly local: State<TaskListLocal>;
  /** The placement's context-key scope. */
  readonly context: { set(name: string, value: boolean | string | undefined): void };
  readonly selection: SelectionPublisher;
  /** The placement's command runner: typed handles in, typed results out. */
  readonly commands: { run<A, R>(command: CommandDef<A, R>, args: A): Promise<R> };
}

export class TaskListPresenter implements Presenter<TaskListState, TaskListIntents> {
  readonly viewState: Observable<TaskListState>;
  readonly intents: TaskListIntents;
  readonly title: Observable<string>;
  readonly #effects: IDisposable[] = [];
  readonly #ports: TaskListPorts;

  constructor(ports: TaskListPorts) {
    this.#ports = ports;
    const { viewModel: vm, local } = ports;
    // one computed builds the whole snapshot; its identity is stable while nothing changed (contracts.md 15.3 rule 4)
    this.viewState = computed<TaskListState>(
      () => {
        const l = local.get();
        const selectedId = vm.selectedId.get();
        const needle = l.localFilter.trim().toLowerCase();
        const tasks = vm.visibleTasks.get().filter((t) => needle === '' || t.title.toLowerCase().includes(needle));
        const groups = PROJECTS.map<TaskGroup>((project) => ({
          project,
          title: PROJECT_TITLES[project] ?? project,
          expanded: l.expandedGroups.includes(project),
          rows: tasks.filter((t) => t.project === project).map((t) => ({ id: t.id, title: t.title, done: t.done, selected: t.id === selectedId })),
        })).filter((g) => g.rows.length > 0);
        const all = vm.store.tasks.get();
        return {
          groups,
          selectedId,
          remaining: all.filter((t) => !t.done).length,
          total: all.length,
          scrollTop: l.scrollTop,
          sharedFilter: vm.sharedFilter.get(),
          localFilter: l.localFilter,
          pinned: l.pinned,
        };
      },
      { name: 'taskList.viewState' },
    );
    this.title = computed(() => `Tasks (${vm.store.openCount.get()})`, { name: 'taskList.title' });
    this.intents = {
      select: (id) => vm.select(id),
      scrolled: (top) => local.update((l) => (l.scrollTop === top ? l : { ...l, scrollTop: top })),
      toggleGroup: (project) =>
        local.update((l) => ({ ...l, expandedGroups: l.expandedGroups.includes(project) ? l.expandedGroups.filter((p) => p !== project) : [...l.expandedGroups, project] })),
      setLocalFilter: (text) => local.update((l) => ({ ...l, localFilter: text })),
      setSharedFilter: (text) => vm.setFilter(text),
      setPinned: (pinned) => local.update((l) => ({ ...l, pinned })),
      add: async (title) => void (await ports.commands.run(AddTask, title === undefined ? undefined : { title })),
      complete: async (id) => void (await ports.commands.run(CompleteTask, id === undefined ? undefined : { id })),
    };
    // view-specific context keys and the typed selection follow the shared selection
    this.#effects.push(
      effect(() => {
        const selected = vm.selectedTask.get();
        ports.context.set('tasks.hasSelection', selected !== undefined);
        if (selected) ports.selection.set(TaskSelection, [selected]);
        else ports.selection.clear(TaskSelection);
      }, { name: 'taskList.selectionKeys' }),
    );
  }

  dispose(): void {
    for (const e of this.#effects.splice(0).reverse()) e.dispose();
    this.#ports.context.set('tasks.hasSelection', undefined);
    this.#ports.selection.clear(TaskSelection);
  }
}

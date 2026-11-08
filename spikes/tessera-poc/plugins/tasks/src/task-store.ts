import { computed, defineTopic, token } from '@tessera/plugin-api';
import type { Memento, Observable, StateSchema, Token, Topic } from '@tessera/plugin-api';
import { isRecord, stateSchema } from './schemas.ts';

export type ProjectId = 'project-a' | 'project-b' | 'inbox';
export const PROJECTS: readonly ProjectId[] = ['project-a', 'project-b', 'inbox'];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly project: ProjectId;
}

export interface TaskChange {
  readonly kind: 'added' | 'completed' | 'reopened' | 'removed' | 'cleared';
  readonly taskId: string | undefined;
  readonly project: ProjectId;
  readonly open: number;
  /** Which of the three publications of this change this delivery is (global, workItem or descendants). */
  readonly published: 'global' | 'workItem' | 'descendants';
}

/** Published with all three publish scopes on every change (CAB EventBroker scopes). */
export const TasksChanged: Topic<TaskChange> = defineTopic<TaskChange>('tasks.changed', { description: 'The task list changed.' });

/** The domain model other plugins use through the token. The token id is the contract; other plugins create the same token by id. */
export interface TaskStore {
  readonly tasks: Observable<readonly Task[]>;
  readonly openCount: Observable<number>;
  get(id: string): Task | undefined;
  add(title: string, project?: ProjectId, id?: string): Task;
  complete(id: string): boolean;
  reopen(id: string): boolean;
  remove(id: string): boolean;
  clearCompleted(): number;
}
export const TaskStore: Token<TaskStore> = token<TaskStore>('sample.tasks/TaskStore');

export interface StoredTasks {
  readonly tasks: readonly Task[];
  readonly nextId: number;
}

export const storedTasksSchema: StateSchema<StoredTasks> = stateSchema<StoredTasks>(
  1,
  (input) => (isRecord(input) && Array.isArray(input['tasks']) && typeof input['nextId'] === 'number' ? undefined : 'expected { tasks, nextId }'),
  () => ({ tasks: [], nextId: 1 }),
);

/** TaskStore over a memento: the tasks live in the project storage scope and survive a restart. */
export class MementoTaskStore implements TaskStore {
  readonly tasks: Observable<readonly Task[]>;
  readonly openCount: Observable<number>;
  readonly #memento: Memento<StoredTasks>;
  readonly #announce: (change: Omit<TaskChange, 'published'>) => void;

  constructor(memento: Memento<StoredTasks>, announce: (change: Omit<TaskChange, 'published'>) => void) {
    this.#memento = memento;
    this.#announce = announce;
    this.tasks = computed(() => memento.value.get().tasks, { name: 'tasks.all' });
    this.openCount = computed(() => memento.value.get().tasks.filter((t) => !t.done).length, { name: 'tasks.open' });
  }

  get(id: string): Task | undefined {
    return this.#memento.get().tasks.find((t) => t.id === id);
  }

  add(title: string, project: ProjectId = 'inbox', id?: string): Task {
    const current = this.#memento.get();
    const task: Task = { id: id ?? `t${current.nextId}`, title, done: false, project };
    this.#memento.set({ tasks: [...current.tasks, task], nextId: id === undefined ? current.nextId + 1 : current.nextId });
    this.#announce({ kind: 'added', taskId: task.id, project, open: this.#open() });
    return task;
  }

  complete(id: string): boolean {
    return this.#setDone(id, true, 'completed');
  }

  reopen(id: string): boolean {
    return this.#setDone(id, false, 'reopened');
  }

  remove(id: string): boolean {
    const current = this.#memento.get();
    const task = current.tasks.find((t) => t.id === id);
    if (!task) return false;
    this.#memento.set({ ...current, tasks: current.tasks.filter((t) => t.id !== id) });
    this.#announce({ kind: 'removed', taskId: id, project: task.project, open: this.#open() });
    return true;
  }

  clearCompleted(): number {
    const current = this.#memento.get();
    const kept = current.tasks.filter((t) => !t.done);
    const removed = current.tasks.length - kept.length;
    if (removed === 0) return 0;
    this.#memento.set({ ...current, tasks: kept });
    this.#announce({ kind: 'cleared', taskId: undefined, project: 'inbox', open: this.#open() });
    return removed;
  }

  #setDone(id: string, done: boolean, kind: 'completed' | 'reopened'): boolean {
    const current = this.#memento.get();
    const task = current.tasks.find((t) => t.id === id);
    if (!task || task.done === done) return false;
    this.#memento.set({ ...current, tasks: current.tasks.map((t) => (t.id === id ? { ...t, done } : t)) });
    this.#announce({ kind, taskId: id, project: task.project, open: this.#open() });
    return true;
  }

  #open(): number {
    return this.#memento.get().tasks.filter((t) => !t.done).length;
  }
}

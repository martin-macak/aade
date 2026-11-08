// Domain code of the sample tasks plugin (not part of any capability count): the shared state of the tasks view.
import { Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { type WorkItem } from '../cap9-workitems.ts';

export interface Task {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
  readonly project: string;
}
export interface TaskChange {
  readonly kind: 'added' | 'completed' | 'removed';
  readonly task: Task;
  /** How the change was published on the WorkItem bus (capability 6). */
  readonly published?: string;
}

export const TasksChanged = new Token<TaskChange>('tasks.changed');

export class TaskStore {
  readonly changed = new Signal<this, void>(this);
  private current: readonly Task[] = [];
  private selected: number | null = null;
  private nextId = 1;

  constructor(private readonly announceChange: (change: TaskChange) => void = () => {}) {}

  get tasks(): readonly Task[] {
    return this.current;
  }
  get selectedId(): number | null {
    return this.selected;
  }

  /** `quiet` suppresses the announcement; a WorkItem unit of work announces after commit instead. */
  add(title: string, project = 'tasks', quiet = false): Task {
    const task: Task = { id: this.nextId++, title, done: false, project };
    this.current = [...this.current, task];
    this.changed.emit();
    if (!quiet) this.announceChange({ kind: 'added', task });
    return task;
  }
  complete(id: number): boolean {
    const task = this.current.find((t) => t.id === id);
    if (!task || task.done) return false;
    const done = { ...task, done: true };
    this.current = this.current.map((t) => (t.id === id ? done : t));
    this.changed.emit();
    this.announceChange({ kind: 'completed', task: done });
    return true;
  }
  remove(id: number, quiet = false): boolean {
    const task = this.current.find((t) => t.id === id);
    if (!task) return false;
    this.current = this.current.filter((t) => t.id !== id);
    if (this.selected === id) this.selected = null;
    this.changed.emit();
    if (!quiet) this.announceChange({ kind: 'removed', task });
    return true;
  }
  select(id: number | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.changed.emit();
  }
  announce(change: TaskChange): void {
    this.announceChange(change);
  }
}

/** What the plugin provides: the store plus the WorkItems that it created. */
export interface TasksModule {
  readonly store: TaskStore;
  readonly root: WorkItem;
  readonly projects: ReadonlyMap<string, WorkItem>;
}
export const ITasks = new Token<TasksModule>('tasks.module');

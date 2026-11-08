// Capability 9: WorkItems, a use-case scope that holds services, state, views and events, and that can commit or discard its
// changes as one unit.
//
// Lumino has nothing like it: no use-case scope, no tree of them, no transaction. A WorkItem here is composition of mechanisms
// that are already ours: a DI scope (capability 7), an event node (capability 6) and the views of capability 1, plus the unit of work.
// Commit and discard: changes are APPLIED immediately (so the views show them) and each one registers how to undo itself. Events
// that describe a change are held back until commit and dropped on discard. Discard runs the undo steps newest first.
import { type IDisposable } from '@lumino/disposable';
import { type EventNode } from './cap6-event-bus.ts';
import { type Placement } from './cap1-shared-view.tsx';
import { type Scope } from './cap7-di.ts';
import { ICurrentWorkItem } from './tokens.ts';

export class UnitOfWork {
  private undo: Array<() => void> = [];
  private held: Array<() => void> = [];

  get pending(): number {
    return this.undo.length;
  }
  /** Apply a change now and remember how to revert it. */
  apply<T>(change: () => T, revert: () => void): T {
    const result = change();
    this.undo.push(revert);
    return result;
  }
  /** Hold a side effect (usually an event publication) until commit. */
  afterCommit(effect: () => void): void {
    this.held.push(effect);
  }
  commit(): void {
    const effects = this.held;
    this.undo = [];
    this.held = [];
    effects.forEach((effect) => effect());
  }
  discard(): void {
    const undo = this.undo.reverse();
    this.undo = [];
    this.held = [];
    undo.forEach((revert) => revert());
  }
}

export class WorkItem implements IDisposable {
  readonly children = new Set<WorkItem>();
  readonly views = new Set<Placement>();
  readonly unit = new UnitOfWork();
  private disposed = false;

  private constructor(
    readonly id: string,
    readonly parent: WorkItem | null,
    /** DI scope of kind "workitem": child of the parent WorkItem's scope, or of the window scope for a root. */
    readonly scope: Scope,
    readonly events: EventNode,
  ) {
    parent?.children.add(this);
  }

  static create(id: string, parent: WorkItem | null, windowScope: Scope, rootEvents: EventNode): WorkItem {
    const scope = (parent?.scope ?? windowScope).createChild('workitem');
    const events = (parent?.events ?? rootEvents).createChild(id);
    const item = new WorkItem(id, parent, scope, events);
    scope.bind(ICurrentWorkItem, () => item); // a view below this scope finds "its" WorkItem through DI
    return item;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get path(): string {
    return this.parent ? `${this.parent.path}/${this.id}` : this.id;
  }

  createChild(id: string): WorkItem {
    return WorkItem.create(id, this, this.scope, this.events);
  }

  /** The WorkItem takes over the lifetime of a placement: it closes when the WorkItem ends. */
  adopt(placement: Placement): Placement {
    this.views.add(placement);
    placement.widget.disposed.connect(() => void this.views.delete(placement));
    return placement;
  }

  /** Children first, then views, then events and scope. Changes that were never committed are discarded. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of [...this.children]) child.dispose();
    this.unit.discard();
    for (const view of [...this.views]) view.widget.dispose();
    this.events.dispose();
    this.scope.dispose();
    this.parent?.children.delete(this);
  }
}

/** The factory the plugins use. Root WorkItems are owned by the window scope, so closing the window ends them in reverse order. */
export class WorkItems {
  constructor(
    private readonly windowScope: Scope,
    private readonly rootEvents: EventNode,
  ) {}
  create(id: string, parent: WorkItem | null = null): WorkItem {
    const item = WorkItem.create(id, parent, this.windowScope, this.rootEvents);
    if (!parent) this.windowScope.own(item);
    return item;
  }
}

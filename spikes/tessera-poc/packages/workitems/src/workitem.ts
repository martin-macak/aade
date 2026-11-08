import { Emitter, TesseraError, reportError, type StateSchema } from '@tessera/base';
import { batch, state, type Observable, type State } from '@tessera/reactive';
import type { Scope } from '@tessera/di';
import {
  CurrentWorkItem,
  EventNode,
  StorageService,
  WorkItemStatus,
  type ContextKeyScope,
  type EventBus,
  type EventNode as EventNodeType,
  type Memento,
  type WorkItem,
  type WorkItemOptions,
} from '@tessera/contracts';

/** What a WorkItem tells the service that owns the tree. Not public API. */
export interface WorkItemHost {
  readonly bus: EventBus;
  created(workItem: WorkItem): void;
  terminated(workItem: WorkItem): void;
  /** Statuses changed: recompute the active WorkItem. */
  changed(): void;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const ROOT_ID = 'root';

type Disposable = { dispose(): unknown };

export class WorkItemImpl implements WorkItem {
  readonly id: string;
  readonly path: string;
  readonly parent: WorkItemImpl | undefined;
  readonly scope: Scope;
  readonly events: EventNodeType;
  readonly context: ContextKeyScope;
  readonly owner: string | undefined;

  readonly #host: WorkItemHost;
  readonly #isRoot: boolean;
  /** The event node and context-key scope that terminate() must dispose. Undefined when the window owns them. */
  readonly #ownedNode: Disposable | undefined;
  readonly #ownedContext: Disposable | undefined;
  readonly #status: State<WorkItemStatus>;
  readonly #children: State<readonly WorkItemImpl[]>;
  readonly #controller: WorkItemOptions['controller'];
  readonly #activeKey: { set(value: boolean): void };
  readonly #onActiveChanged: Emitter<void>;
  #terminating: Promise<void> | undefined;

  private constructor(init: {
    id: string;
    path: string;
    parent: WorkItemImpl | undefined;
    scope: Scope;
    events: EventNodeType;
    context: ContextKeyScope;
    host: WorkItemHost;
    isRoot: boolean;
    ownedNode: Disposable | undefined;
    ownedContext: Disposable | undefined;
    options: WorkItemOptions | undefined;
  }) {
    this.id = init.id;
    this.path = init.path;
    this.parent = init.parent;
    this.scope = init.scope;
    this.events = init.events;
    this.context = init.context;
    this.owner = init.options?.owner;
    this.#host = init.host;
    this.#isRoot = init.isRoot;
    this.#ownedNode = init.ownedNode;
    this.#ownedContext = init.ownedContext;
    this.#controller = init.options?.controller;
    this.#status = state<WorkItemStatus>(init.isRoot ? WorkItemStatus.Active : WorkItemStatus.Inactive, { name: `workItem.status:${init.path}` });
    this.#children = state<readonly WorkItemImpl[]>([], { name: `workItem.children:${init.path}` });
    this.#activeKey = this.context.createKey('workItem.active', init.isRoot);
    this.#onActiveChanged = new Emitter<void>({ name: `workItem.active:${init.path}` });
  }

  /** The root WorkItem of a window: it uses the window's DI scope, event node and context-key scope, and owns none of them. */
  static createRoot(scope: Scope, events: EventNodeType, context: ContextKeyScope, host: WorkItemHost): WorkItemImpl {
    const root = new WorkItemImpl({
      id: ROOT_ID,
      path: ROOT_ID,
      parent: undefined,
      scope,
      events,
      context,
      host,
      isRoot: true,
      ownedNode: undefined,
      ownedContext: undefined,
      options: undefined,
    });
    // CurrentWorkItem for the window scope is provided by the module (lazily)
    return root;
  }

  get status(): Observable<WorkItemStatus> {
    return this.#status.asReadonly();
  }

  get children(): Observable<readonly WorkItem[]> {
    return this.#children.asReadonly();
  }

  /** Fires after this WorkItem was activated or deactivated. Used by the service to watch the tree. */
  get onDidChangeActive(): Emitter<void>['event'] {
    return this.#onActiveChanged.event;
  }

  child(id: string): WorkItem | undefined {
    return this.#children.peek().find((c) => c.id === id);
  }

  createChild(id: string, options?: WorkItemOptions): WorkItem {
    if (!ID_PATTERN.test(id)) {
      throw new TesseraError('validation', `WorkItem id "${id}" is invalid: use lower-case letters, digits, "." and "-", starting with a letter or digit`, { details: { id } });
    }
    this.#assertAlive('createChild');
    if (this.child(id)) {
      throw new TesseraError('workItem.duplicate', `WorkItem "${this.path}" already has a child "${id}"`, { details: { parent: this.path, id } });
    }
    const scope = this.scope.createChild('workItem', id);
    let node: (EventNodeType & Disposable) | undefined;
    let context: ContextKeyScope | undefined;
    try {
      node = this.#host.bus.createNode(this.events, scope.path);
      context = this.context.createChild(`${this.path}/${id}`);
      const child = new WorkItemImpl({
        id,
        path: `${this.path}/${id}`,
        parent: this,
        scope,
        events: node,
        context,
        host: this.#host,
        isRoot: false,
        ownedNode: node,
        ownedContext: context,
        options,
      });
      scope.provideValue(CurrentWorkItem, child, { owner: 'core' });
      scope.provideValue(EventNode, node, { owner: 'core' });
      options?.services?.(scope);
      this.#children.set([...this.#children.peek(), child]);
      this.#host.created(child);
      if (options?.activate) child.activate();
      child.#startController();
      return child;
    } catch (error) {
      // Nothing may leak when creation fails half way.
      this.#removeChild(id);
      context?.dispose();
      node?.dispose();
      void scope.dispose().catch((e: unknown) => reportError(e, { source: 'dispose', target: `workItem:${this.path}/${id}` }));
      throw error;
    }
  }

  activate(): void {
    this.#assertAlive('activate');
    if (this.#isRoot) return;
    batch(() => {
      this.parent!.activate();
      for (const sibling of this.parent!.#children.peek()) {
        if (sibling !== this && sibling.#status.peek() === WorkItemStatus.Active) sibling.#deactivateSelfAndDescendants();
      }
      this.#setActive(true);
    });
    this.#host.changed();
  }

  deactivate(): void {
    if (this.#isRoot || this.#status.peek() === WorkItemStatus.Terminated) return;
    batch(() => this.#deactivateSelfAndDescendants());
    this.#host.changed();
  }

  terminate(options?: { readonly discardState?: boolean }): Promise<void> {
    this.#terminating ??= this.#terminateNow(options?.discardState === true);
    return this.#terminating;
  }

  /** The mementos this WorkItem handed out: it releases them when it ends (the storage service keeps no memento of a dead WorkItem). */
  readonly #mementos: Array<Memento<never>> = [];

  memento<T>(key: string, schema: StateSchema<T>): Memento<T> {
    this.#assertAlive('memento');
    const memento = this.scope.get(StorageService).memento('project', `workItem:${this.path}:${key}`, schema);
    this.#mementos.push(memento as unknown as Memento<never>);
    return memento;
  }

  // ----- internals ------------------------------------------------------------------------

  #assertAlive(action: string): void {
    if (this.#terminating !== undefined || this.#status.peek() === WorkItemStatus.Terminated) {
      throw new TesseraError('workItem.terminated', `Cannot ${action}: WorkItem "${this.path}" is terminated`, { details: { path: this.path } });
    }
  }

  #setActive(active: boolean): void {
    const wanted = active ? WorkItemStatus.Active : WorkItemStatus.Inactive;
    if (this.#status.peek() === wanted) return;
    this.#status.set(wanted);
    this.#activeKey.set(active);
    const controller = this.#controller;
    if (controller) {
      try {
        const hook = active ? controller.onActivate : controller.onDeactivate;
        hook?.call(controller);
      } catch (error) {
        reportError(error, { source: 'unknown', target: `workItem:${this.path}`, details: { hook: active ? 'onActivate' : 'onDeactivate' } });
      }
    }
    this.#onActiveChanged.fire();
  }

  #deactivateSelfAndDescendants(): void {
    // deepest first: a child never stays active under an inactive parent
    for (const child of this.#children.peek()) {
      if (child.#status.peek() === WorkItemStatus.Active) child.#deactivateSelfAndDescendants();
    }
    if (!this.#isRoot) this.#setActive(false);
  }

  #startController(): void {
    const controller = this.#controller;
    if (!controller) return;
    const fail = (error: unknown): void => reportError(error, { source: 'unknown', target: `workItem:${this.path}`, details: { hook: 'start' } });
    try {
      const result = this.scope.run(() => controller.start(this));
      if (result instanceof Promise) result.catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  #removeChild(id: string): void {
    const children = this.#children.peek();
    if (children.some((c) => c.id === id)) this.#children.set(children.filter((c) => c.id !== id));
  }

  #releaseState(discardState: boolean): void {
    for (const memento of this.#mementos.splice(0)) memento.dispose?.();
    if (!discardState) return;
    const storage = this.scope.get(StorageService, { optional: true });
    if (!storage?.isReady) return;
    for (const key of storage.keys('project', `workItem:${this.path}:`)) storage.delete('project', key);
  }

  async #terminateNow(discardState: boolean): Promise<void> {
    const errors: unknown[] = [];
    // children first, deepest first, last created first
    for (const child of [...this.#children.peek()].reverse()) {
      try {
        await child.terminate(discardState ? { discardState } : undefined);
      } catch (error) {
        errors.push(error);
      }
    }
    batch(() => {
      this.#status.set(WorkItemStatus.Terminated);
      if (!this.#isRoot) this.#activeKey.set(false);
      if (this.parent) this.parent.#removeChild(this.id);
    });
    this.#host.changed();
    this.#host.terminated(this);
    this.#onActiveChanged.dispose();
    const steps: Array<() => unknown> = [
      // The state of a terminated WorkItem stays in storage (a plugin deactivation or a shutdown ends WorkItems too, and the next
      // session restores from it). Only an owner who says discardState deletes the keys. The mementos are released either way.
      () => this.#releaseState(discardState),
      () => this.#ownedNode?.dispose(),
      () => this.#ownedContext?.dispose(),
      // the root WorkItem uses the window DI scope: the shell disposes it
      () => (this.#isRoot ? undefined : this.scope.dispose()),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Errors while terminating WorkItem "${this.path}"`);
  }
}

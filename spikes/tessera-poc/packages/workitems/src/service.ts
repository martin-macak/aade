import { Emitter, type Event, type IDisposable } from '@tessera/base';
import { computed, state, type Observable, type State } from '@tessera/reactive';
import type { Scope } from '@tessera/di';
import type { ContextKeyScope, EventBus, EventNode, WorkItem, WorkItemService } from '@tessera/contracts';
import { WorkItemImpl, type WorkItemHost } from './workitem.ts';

/** The WorkItem tree of one window. Provided in the window DI scope. */
export class DefaultWorkItemService implements WorkItemService, IDisposable {
  readonly root: WorkItem;
  readonly active: Observable<WorkItem | undefined>;
  readonly onDidCreate: Event<WorkItem>;
  readonly onDidTerminate: Event<WorkItem>;

  readonly #created = new Emitter<WorkItem>({ name: 'workItems.created' });
  readonly #terminated = new Emitter<WorkItem>({ name: 'workItems.terminated' });
  readonly #byPath = new Map<string, WorkItemImpl>();
  readonly #tick: State<number>;
  readonly #windowContext: ContextKeyScope;
  #disposing: Promise<void> | undefined;

  constructor(bus: EventBus, windowScope: Scope, windowNode: EventNode, windowContext: ContextKeyScope) {
    this.onDidCreate = this.#created.event;
    this.onDidTerminate = this.#terminated.event;
    this.#tick = state(0, { name: 'workItems.tick' });
    this.#windowContext = windowContext;
    const host: WorkItemHost = {
      bus,
      created: (workItem) => {
        this.#byPath.set(workItem.path, workItem as WorkItemImpl);
        this.#created.fire(workItem);
      },
      terminated: (workItem) => {
        this.#byPath.delete(workItem.path);
        this.#terminated.fire(workItem);
      },
      // `this.root` is set before any WorkItem can call this
      changed: () => {
        this.#tick.set(this.#tick.peek() + 1);
        this.#windowContext.set('activeWorkItem', deepestActive(this.root)?.path ?? this.root.path);
      },
    };
    const root = WorkItemImpl.createRoot(windowScope, windowNode, windowContext, host);
    this.root = root;
    this.#byPath.set(root.path, root);
    this.active = computed(
      () => {
        this.#tick.get();
        return deepestActive(root);
      },
      { name: 'workItems.active' },
    );
    // `activeWorkItem` (window context key) is the path of the deepest active WorkItem
    this.#windowContext.set('activeWorkItem', root.path);
  }

  find(path: string): WorkItem | undefined {
    return this.#byPath.get(path);
  }

  /** Terminates the whole tree, then the window context-key scope that this service created. */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      const errors: unknown[] = [];
      try {
        await this.root.terminate();
      } catch (error) {
        errors.push(error);
      }
      this.#windowContext.dispose();
      this.#created.dispose();
      this.#terminated.dispose();
      if (errors.length > 0) throw new AggregateError(errors, 'Errors while disposing the WorkItem service');
    })();
    return this.#disposing;
  }
}

function deepestActive(root: WorkItem): WorkItem | undefined {
  let current: WorkItem = root;
  for (;;) {
    const next = current.children.peek().find((c) => c.status.peek() === 'active');
    if (!next) return current;
    current = next;
  }
}

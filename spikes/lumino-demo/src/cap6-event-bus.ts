// Capability 6: an event bus scoped to WorkItems. A publisher picks the reach of one publication:
//   global       every node in the tree
//   workItem     only the publishing node
//   descendants  the publishing node and everything below it
//
// Lumino's `Signal` is the delivery primitive (one Signal per node), and it also gives subscriber isolation for free: a slot that
// throws is caught and sent to Signal's exception handler, so the other subscribers still run. Lumino has no topics, no tree and
// no scoped reach, so those parts are ours.
import { type Token } from '@lumino/coreutils';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';

export type PublishScope = 'global' | 'workItem' | 'descendants';
export interface BusEvent<T = unknown> {
  readonly topic: Token<T>;
  readonly payload: T;
  readonly scope: PublishScope;
  readonly origin: EventNode;
}
/** Wraps the delivery of one publication. The interceptor chain of capability 3 plugs in here. */
export type DeliveryHook = (event: BusEvent, deliver: () => void) => void;

export class EventNode implements IDisposable {
  readonly children = new Set<EventNode>();
  private readonly delivered = new Signal<EventNode, BusEvent>(this);
  private disposed = false;

  constructor(
    readonly name: string,
    readonly parent: EventNode | null = null,
    private readonly hook: DeliveryHook = parent?.hook ?? ((_, deliver) => deliver()),
  ) {
    parent?.children.add(this);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get root(): EventNode {
    return this.parent ? this.parent.root : this;
  }

  createChild(name: string): EventNode {
    return new EventNode(name, this);
  }

  subscribe<T>(topic: Token<T>, handler: (payload: T, event: BusEvent<T>) => void): IDisposable {
    const slot = (_: EventNode, event: BusEvent): void => {
      if (event.topic === topic) handler(event.payload as T, event as BusEvent<T>);
    };
    this.delivered.connect(slot);
    return new DisposableDelegate(() => void this.delivered.disconnect(slot));
  }

  publish<T>(topic: Token<T>, payload: T, scope: PublishScope = 'global'): void {
    if (this.disposed) return;
    const event: BusEvent<T> = { topic, payload, scope, origin: this };
    const targets = scope === 'global' ? [...this.root.walk()] : scope === 'workItem' ? [this] : [...this.walk()];
    this.hook(event as BusEvent, () => targets.forEach((node) => node.delivered.emit(event as BusEvent)));
  }

  *walk(): Generator<EventNode> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of [...this.children]) child.dispose();
    Signal.clearData(this);
    this.parent?.children.delete(this);
  }
}

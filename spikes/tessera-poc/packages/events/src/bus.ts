import {
  TesseraError,
  abortable,
  getScheduler,
  isDevMode,
  parseOrThrow,
  reportError,
  toDisposable,
  transactionGate,
  type Event,
  type IDisposable,
  type ListenOptions,
  type Delivery,
} from '@tessera/base';
import {
  type EventBus,
  type EventBusStats,
  type EventHandler,
  type EventMeta,
  type EventNode,
  type EventRelay,
  type PublishOptions,
  type PublishScope,
  type SubscribeOptions,
  type Topic,
} from '@tessera/contracts';
import type { InterceptorRegistry } from '@tessera/interceptors';
import { state, type State, type Observable } from '@tessera/reactive';

interface Publication {
  readonly topic: Topic<unknown>;
  readonly payload: unknown;
  readonly meta: EventMeta;
  readonly source: NodeImpl;
  /** False while the publication waits in the queue. A sticky replay serves processed publications only (a pending one arrives live). */
  processed: boolean;
}

interface Queued {
  readonly payload: unknown;
  readonly meta: EventMeta;
}

class SubscriptionImpl {
  readonly queue: Queued[] = [];
  active = true;
  scheduled: IDisposable | undefined;
  inOverflowBurst = false;
  readonly node: NodeImpl;
  readonly topic: Topic<unknown>;
  readonly handler: EventHandler<unknown>;
  readonly delivery: Delivery;
  readonly filter: ((payload: unknown, meta: EventMeta) => boolean) | undefined;
  readonly maxQueue: number;
  readonly overflow: 'dropOldest' | 'dropNewest';
  readonly owner: string | undefined;

  constructor(
    node: NodeImpl,
    topic: Topic<unknown>,
    handler: EventHandler<unknown>,
    delivery: Delivery,
    filter: ((payload: unknown, meta: EventMeta) => boolean) | undefined,
    maxQueue: number,
    overflow: 'dropOldest' | 'dropNewest',
    owner: string | undefined,
  ) {
    this.node = node;
    this.topic = topic;
    this.handler = handler;
    this.delivery = delivery;
    this.filter = filter;
    this.maxQueue = maxQueue;
    this.overflow = overflow;
    this.owner = owner;
  }
}

/** Does a publication at `source` with `scope` reach a subscription on `subscriber`? (contracts.md 10.2) */
function reaches(source: NodeImpl, scope: PublishScope, subscriber: NodeImpl): boolean {
  if (scope === 'global') return true;
  if (scope === 'workItem') return subscriber === source;
  for (let n: NodeImpl | undefined = subscriber; n; n = n.parentImpl) if (n === source) return true;
  return false;
}

class NodeImpl implements EventNode, IDisposable {
  readonly children: NodeImpl[] = [];
  readonly subscriptions: SubscriptionImpl[] = [];
  /** Retained sticky publications published at this node, by topic id and scope. */
  readonly retained: Map<string, Publication> = new Map();
  disposed = false;

  readonly bus: DefaultEventBus;
  readonly id: string;
  readonly parentImpl: NodeImpl | undefined;

  constructor(bus: DefaultEventBus, id: string, parentImpl: NodeImpl | undefined) {
    this.bus = bus;
    this.id = id;
    this.parentImpl = parentImpl;
  }

  get parent(): EventNode | undefined {
    return this.parentImpl;
  }

  publish<T>(topic: Topic<T>, payload: T, options?: PublishOptions): void {
    this.bus.publishFrom(this, topic as Topic<unknown>, payload, options?.scope ?? 'global', 'local');
  }

  /** Internal path of the plugin facade: the publication carries `EventMeta.publisher`. */
  publishAs<T>(publisher: string, topic: Topic<T>, payload: T, options?: PublishOptions): void {
    this.bus.publishFrom(this, topic as Topic<unknown>, payload, options?.scope ?? 'global', 'local', undefined, publisher);
  }

  subscribe<T>(topic: Topic<T>, handler: EventHandler<T>, options?: SubscribeOptions<T>): IDisposable {
    return this.bus.subscribeOn(this, topic as Topic<unknown>, handler as EventHandler<unknown>, options as SubscribeOptions<unknown> | undefined);
  }

  on<T>(topic: Topic<T>, options?: SubscribeOptions<T>): Event<T> {
    return (listener, listenOptions?: ListenOptions) => {
      // A sync sticky replay calls the handler before subscribe() returns: `subscription` is not assigned yet then.
      const ref: { subscription?: IDisposable } = {};
      let fired = false;
      const wrapped: EventHandler<T> = (payload) => {
        // once: end the subscription before the listener runs, so a listener that throws is not called again
        if (listenOptions?.once) {
          if (fired) return;
          fired = true;
          ref.subscription?.dispose();
        }
        listener(payload);
      };
      const created = this.subscribe(topic, wrapped, options);
      ref.subscription = created;
      if (fired) created.dispose();
      // the handle removes its abort listener when it is disposed first (a plugin signal lives as long as the plugin)
      const handle = abortable(created, listenOptions?.signal);
      listenOptions?.store?.add(handle);
      return handle;
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.bus.disposeNode(this);
  }
}

/** Preorder walk: the node, then its children in creation order. */
function* preorder(node: NodeImpl): Generator<NodeImpl> {
  yield node;
  for (const child of node.children) yield* preorder(child);
}

/** More publications than this in one outermost drain are a feedback loop: the rest of the queue is dropped (bus.cascade). */
export const DEFAULT_MAX_CASCADE = 10_000;

export class DefaultEventBus implements EventBus {
  readonly root: EventNode;
  readonly #rootImpl: NodeImpl;
  readonly #nodes = new Map<string, NodeImpl>();
  readonly #topics = new Map<string, Topic<unknown>>();
  readonly #stats: State<EventBusStats> = state<EventBusStats>({ published: 0, delivered: 0, dropped: 0, handlerErrors: 0 }, { name: 'events.stats' });
  readonly #interceptors: InterceptorRegistry | undefined;
  readonly #maxCascade: number;
  #relay: EventRelay | undefined;
  #relaySubscription: IDisposable | undefined;
  #seq = 0;
  readonly #pending: Publication[] = [];
  #delivering = false;
  #counters = { published: 0, delivered: 0, dropped: 0, handlerErrors: 0 };
  #statsDirty = false;
  /** Publications per topic made from microtask or idle handlers in the current macrotask (feedback loops that never share one drain). */
  readonly #asyncCounts = new Map<string, number>();
  #asyncResetTimer: IDisposable | undefined;
  #asyncDepth = 0;
  readonly #reportedCascade = new Set<string>();

  constructor(options?: { readonly rootId?: string; readonly interceptors?: InterceptorRegistry; readonly maxCascade?: number }) {
    this.#interceptors = options?.interceptors;
    this.#maxCascade = options?.maxCascade ?? DEFAULT_MAX_CASCADE;
    this.#rootImpl = new NodeImpl(this, options?.rootId ?? 'application', undefined);
    this.#nodes.set(this.#rootImpl.id, this.#rootImpl);
    this.root = this.#rootImpl;
  }

  get stats(): Observable<EventBusStats> {
    return this.#stats.asReadonly();
  }

  createNode(parent: EventNode, id: string): EventNode & IDisposable {
    const parentImpl = parent as NodeImpl;
    if (!(parentImpl instanceof NodeImpl) || parentImpl.bus !== this || parentImpl.disposed) {
      throw new TesseraError('bus.invalidParent', `Cannot create event node "${id}": the parent is not a live node of this bus`);
    }
    if (this.#nodes.has(id)) throw new TesseraError('bus.duplicateNode', `Event node "${id}" already exists`);
    const node = new NodeImpl(this, id, parentImpl);
    parentImpl.children.push(node);
    this.#nodes.set(id, node);
    return node;
  }

  node(id: string): EventNode | undefined {
    return this.#nodes.get(id);
  }

  setRelay(relay: EventRelay): IDisposable {
    if (this.#relay) throw new TesseraError('bus.relayInstalled', 'An event relay is already installed');
    this.#relay = relay;
    this.#relaySubscription = relay.onRemote((message) => this.#receiveRemote(message));
    return toDisposable(() => {
      if (this.#relay !== relay) return;
      this.#relaySubscription?.dispose();
      this.#relaySubscription = undefined;
      this.#relay = undefined;
    });
  }

  // ----- publish ---------------------------------------------------------------------------

  publishFrom(source: NodeImpl, topic: Topic<unknown>, payload: unknown, scope: PublishScope, origin: 'local' | 'remote', traceId?: string, publisher?: string): void {
    if (source.disposed) return;
    this.#topics.set(topic.id, topic);
    // 1. validate (dev mode, and always for remote payloads, which the caller validated already)
    if (isDevMode() && topic.schema) parseOrThrow(topic.schema, payload, `Payload of topic "${topic.id}"`);
    // 2. transaction: delivery waits for the outermost commit and is dropped if the transaction fails
    transactionGate.defer(() => {
      if (source.disposed) return;
      if (this.#asyncDepth > 0 && !this.#countAsync(topic.id, publisher)) return;
      // 3. stamp
      const meta: EventMeta = {
        topicId: topic.id,
        scope,
        sourceNodeId: source.id,
        seq: ++this.#seq,
        publishedAt: getScheduler().now(),
        origin,
        replayed: false,
        traceId,
        ...(publisher !== undefined ? { publisher } : {}),
      };
      const publication: Publication = { topic, payload, meta, source, processed: false };
      // 3b. retain at enqueue: a value that the cascade guard drops later is still the current value of a sticky topic
      if (topic.sticky) source.retained.set(`${topic.id}|${meta.scope}`, publication);
      this.#pending.push(publication);
      this.#drainPublications();
    });
  }

  /** Counts one publication made from an async handler. Returns false (and reports once) when the topic loops across microtasks or idle callbacks. */
  #countAsync(topicId: string, owner: string | undefined): boolean {
    const count = (this.#asyncCounts.get(topicId) ?? 0) + 1;
    this.#asyncCounts.set(topicId, count);
    if (!this.#asyncResetTimer) {
      this.#asyncResetTimer = getScheduler().timeout(() => {
        this.#asyncResetTimer = undefined;
        this.#asyncCounts.clear();
        this.#reportedCascade.clear();
      }, 0);
    }
    if (count <= this.#maxCascade) return true;
    this.#counters.dropped++;
    this.#statsDirty = true;
    if (!this.#reportedCascade.has(topicId)) {
      this.#reportedCascade.add(topicId);
      reportError(new TesseraError('bus.cascade', `More than ${this.#maxCascade} publications of topic "${topicId}" from asynchronous subscribers in one task: a subscriber publishes in a loop. Further publications of this topic are dropped until the next task`, { details: { limit: this.#maxCascade, topicId } }), {
        source: 'subscriber',
        ...(owner !== undefined ? { pluginId: owner } : {}),
      });
    }
    return false;
  }

  /** 7. Re-entrancy: one publication is delivered at a time; later ones wait in this queue. */
  #drainPublications(): void {
    if (this.#delivering) return;
    this.#delivering = true;
    const counts = new Map<string, number>();
    const looping = new Set<string>();
    try {
      while (this.#pending.length > 0) {
        const publication = this.#pending.shift() as Publication;
        const id = publication.topic.id;
        if (looping.has(id)) {
          this.#dropPublication(publication);
          continue;
        }
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        if (count > this.#maxCascade) {
          // Only the looping topic is cut off. Other queued publications are delivered.
          looping.add(id);
          let dropped = 1;
          this.#dropPublication(publication);
          for (let i = this.#pending.length - 1; i >= 0; i--) {
            const queued = this.#pending[i] as Publication;
            if (queued.topic.id === id) {
              this.#pending.splice(i, 1);
              this.#dropPublication(queued);
              dropped++;
            }
          }
          reportError(new TesseraError('bus.cascade', `More than ${this.#maxCascade} publications of topic "${id}" in one delivery: a subscriber publishes in a loop. Dropped ${dropped} queued publications of this topic`, { details: { limit: this.#maxCascade, dropped, topicId: id } }), {
            source: 'subscriber',
            // the publisher stamped at publishFrom/publishAs, or no plugin at all: the last subscriber is not the one that loops
            ...(publication.meta.publisher !== undefined ? { pluginId: publication.meta.publisher } : {}),
          });
          continue;
        }
        this.#process(publication);
      }
    } finally {
      this.#delivering = false;
      this.#flushStats();
    }
  }

  #dropPublication(publication: Publication): void {
    publication.processed = true; // a retained sticky value stays served by replay
    this.#counters.dropped++;
    this.#statsDirty = true;
  }

  #process(publication: Publication): void {
    const { topic, payload, meta, source } = publication;
    publication.processed = true;
    this.#counters.published++;
    this.#statsDirty = true;
    // 4. observe (sync observers; they cannot change or stop the publication)
    if (this.#interceptors) {
      const ctx = this.#interceptors.createContext('event', topic.id, { topicId: topic.id, payload, scope: meta.scope, nodeId: source.id, origin: meta.origin }, { source: 'event-bus' });
      this.#interceptors.observe(ctx);
    }
    // 5. retention happened at enqueue (publishFrom)
    // 6. select
    const start = meta.scope === 'global' ? this.#rootImpl : source;
    const recipients: SubscriptionImpl[] = [];
    for (const node of preorder(start)) {
      if (node.disposed) continue;
      if (meta.scope === 'workItem' && node !== source) continue;
      for (const subscription of node.subscriptions) {
        if (!subscription.active || subscription.topic.id !== topic.id) continue;
        if (subscription.filter && !this.#safeFilter(subscription, payload, meta)) continue;
        recipients.push(subscription);
      }
    }
    // 8. deliver
    for (const subscription of recipients) this.#deliver(subscription, payload, meta);
    // 9. relay
    if (meta.scope === 'global' && topic.crossProcess && meta.origin === 'local' && this.#relay) {
      try {
        this.#relay.forward(topic.id, payload, meta);
      } catch (error) {
        reportError(error, { source: 'ipc', target: topic.id });
      }
    }
  }

  #safeFilter(subscription: SubscriptionImpl, payload: unknown, meta: EventMeta): boolean {
    try {
      return subscription.filter?.(payload, meta) ?? true;
    } catch (error) {
      this.#handlerFailed(subscription, error);
      return false;
    }
  }

  #deliver(subscription: SubscriptionImpl, payload: unknown, meta: EventMeta): void {
    if (subscription.delivery === 'sync') {
      this.#call(subscription, payload, meta);
      return;
    }
    if (subscription.queue.length >= subscription.maxQueue) {
      this.#counters.dropped++;
      this.#statsDirty = true;
      if (!subscription.inOverflowBurst) {
        subscription.inOverflowBurst = true;
        reportError(
          new TesseraError('bus.overflow', `Subscriber queue for topic "${subscription.topic.id}" is full (${subscription.maxQueue}); dropping ${subscription.overflow === 'dropOldest' ? 'the oldest' : 'the newest'} items`),
          { source: 'subscriber', target: subscription.topic.id, ...(subscription.owner !== undefined ? { pluginId: subscription.owner } : {}) },
        );
      }
      if (subscription.overflow === 'dropNewest') return;
      subscription.queue.shift();
    }
    // A replay that is still queued is older than this live item: drop it, so the last value delivered is the live one.
    const staleReplay = subscription.queue.findIndex((q) => q.meta.replayed);
    if (staleReplay >= 0) subscription.queue.splice(staleReplay, 1);
    subscription.queue.push({ payload, meta });
    this.#schedule(subscription);
  }

  #schedule(subscription: SubscriptionImpl): void {
    if (subscription.scheduled || !subscription.active) return;
    const scheduler = getScheduler();
    if (subscription.delivery === 'microtask') {
      const token = { dispose: () => {} };
      subscription.scheduled = token;
      scheduler.microtask(() => {
        subscription.scheduled = undefined;
        this.#drain(subscription, undefined);
      });
    } else {
      subscription.scheduled = scheduler.idle(
        (deadline) => {
          subscription.scheduled = undefined;
          this.#drain(subscription, deadline);
        },
        { timeoutMs: 1000 },
      );
    }
  }

  #drain(subscription: SubscriptionImpl, deadline: { timeRemaining(): number; readonly didTimeout: boolean } | undefined): void {
    while (subscription.active && subscription.queue.length > 0) {
      if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 1) {
        this.#schedule(subscription); // idle drains stop when the budget is gone and continue in the next idle callback
        return;
      }
      const item = subscription.queue.shift() as Queued;
      this.#asyncDepth++;
      try {
        this.#call(subscription, item.payload, item.meta);
      } finally {
        this.#asyncDepth--;
      }
    }
    if (subscription.queue.length === 0) subscription.inOverflowBurst = false;
    this.#flushStats();
  }

  #call(subscription: SubscriptionImpl, payload: unknown, meta: EventMeta): void {
    if (!subscription.active) return;
    this.#counters.delivered++;
    this.#statsDirty = true;
    try {
      const result: unknown = subscription.handler(payload, meta);
      // An async handler: its rejection is a subscriber failure too (isolation holds for promises, not only for throws).
      if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, (error: unknown) => this.#handlerFailed(subscription, error));
      }
    } catch (error) {
      this.#handlerFailed(subscription, error);
    }
  }

  #handlerFailed(subscription: SubscriptionImpl, error: unknown): void {
    this.#counters.handlerErrors++;
    this.#statsDirty = true;
    reportError(error, {
      source: 'subscriber',
      target: subscription.topic.id,
      ...(subscription.owner !== undefined ? { pluginId: subscription.owner } : {}),
    });
  }

  #flushStats(): void {
    if (!this.#statsDirty || this.#delivering) return;
    this.#statsDirty = false;
    this.#stats.set({ ...this.#counters });
  }

  // ----- subscribe -------------------------------------------------------------------------

  subscribeOn(node: NodeImpl, topic: Topic<unknown>, handler: EventHandler<unknown>, options?: SubscribeOptions<unknown>): IDisposable {
    if (node.disposed) return toDisposable(() => {});
    this.#topics.set(topic.id, topic);
    const subscription = new SubscriptionImpl(
      node,
      topic,
      handler,
      options?.delivery ?? topic.delivery,
      options?.filter,
      options?.maxQueue ?? 1000,
      options?.overflow ?? 'dropOldest',
      options?.owner,
    );
    node.subscriptions.push(subscription);
    const handle = toDisposable(() => {
      if (!subscription.active) return;
      subscription.active = false;
      subscription.queue.length = 0;
      subscription.scheduled?.dispose();
      subscription.scheduled = undefined;
      const index = node.subscriptions.indexOf(subscription);
      if (index >= 0) node.subscriptions.splice(index, 1);
    });
    const returned = abortable(handle, options?.signal);
    if (topic.sticky && (options?.replay ?? true) && subscription.active) this.#replay(subscription);
    return returned;
  }

  /**
   * Sticky replay: the latest retained publication that reaches the subscriber. A sync subscription gets it at subscribe time,
   * so no live publication can overtake it. A microtask subscription gets it in a microtask, an idle one when idle; a replay
   * that is still queued is dropped when a newer item arrives.
   */
  #replay(subscription: SubscriptionImpl): void {
    let best: Publication | undefined;
    for (const node of this.#nodes.values()) {
      if (node.disposed) continue;
      for (const publication of node.retained.values()) {
        if (publication.topic.id !== subscription.topic.id || !publication.processed) continue;
        if (!reaches(publication.source, publication.meta.scope, subscription.node)) continue;
        if (!best || publication.meta.seq > best.meta.seq) best = publication;
      }
    }
    if (!best) return;
    const replayed: EventMeta = { ...best.meta, replayed: true };
    if (subscription.filter && !this.#safeFilter(subscription, best.payload, replayed)) return;
    if (subscription.delivery === 'sync') {
      this.#call(subscription, best.payload, replayed);
      this.#flushStats();
      return;
    }
    subscription.queue.push({ payload: best.payload, meta: replayed });
    const scheduler = getScheduler();
    const run = (): void => {
      subscription.scheduled = undefined;
      this.#drain(subscription, undefined);
    };
    if (subscription.delivery === 'idle') {
      subscription.scheduled = scheduler.idle(run, { timeoutMs: 1000 });
    } else {
      subscription.scheduled = { dispose: () => {} };
      scheduler.microtask(run);
    }
  }

  // ----- nodes -----------------------------------------------------------------------------

  disposeNode(node: NodeImpl): void {
    if (node.disposed) return;
    for (const child of [...node.children].reverse()) this.disposeNode(child);
    node.disposed = true;
    for (const subscription of [...node.subscriptions]) {
      subscription.active = false;
      subscription.queue.length = 0;
      subscription.scheduled?.dispose();
    }
    node.subscriptions.length = 0;
    node.retained.clear();
    if (node.parentImpl) {
      const index = node.parentImpl.children.indexOf(node);
      if (index >= 0) node.parentImpl.children.splice(index, 1);
    }
    this.#nodes.delete(node.id);
  }

  // ----- relay -----------------------------------------------------------------------------

  #receiveRemote(message: { readonly topicId: string; readonly payload: unknown; readonly traceId: string | undefined }): void {
    const topic = this.#topics.get(message.topicId);
    if (!topic) return; // no local publisher or subscriber ever used this topic: nobody can listen
    if (!topic.crossProcess || !topic.schema) {
      reportError(new TesseraError('bus.remoteRejected', `Remote message for topic "${topic.id}" refused: the topic is not crossProcess with a schema`, { details: { topicId: topic.id } }), { source: 'ipc', target: topic.id });
      return;
    }
    if (topic.schema) {
      const parsed = topic.schema.safeParse(message.payload);
      if (!parsed.success) {
        reportError(new TesseraError('validation', `Remote payload of topic "${topic.id}" is invalid`), { source: 'ipc', target: topic.id });
        return;
      }
      this.publishFrom(this.#rootImpl, topic, parsed.data, 'global', 'remote', message.traceId);
      return;
    }
    this.publishFrom(this.#rootImpl, topic, message.payload, 'global', 'remote', message.traceId);
  }
}


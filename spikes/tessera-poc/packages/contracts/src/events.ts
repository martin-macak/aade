import { TesseraError, type Delivery, type Event, type IDisposable, type Schema } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import type { CommandExecutedEvent } from './commands.ts';
import type { PlacementRef, PluginState } from './ids.ts';
import type { LifecyclePhase } from './lifecycle.ts';
import { token, type Token } from '@tessera/di';

declare const topicType: unique symbol;

export interface TopicOptions<T> {
  readonly description?: string;
  /** Validates payloads in dev mode on publish, and always on cross-process receive. */
  /** @inProcessOnly A schema object. Out of process, topics are named by id. */
  readonly schema?: Schema<T>;
  /** Keep the last publication per source node for late subscribers. Default false. */
  readonly sticky?: boolean;
  /** Forward global publications to other windows. Requires schema. Default false. */
  readonly crossProcess?: boolean;
  /** Default delivery for subscribers that do not choose. Default 'sync'. */
  readonly delivery?: Delivery;
}

export interface Topic<T> {
  readonly [topicType]?: T;                      // phantom type
  readonly id: string;
  readonly description: string | undefined;
  readonly schema: Schema<T> | undefined;
  readonly sticky: boolean;
  readonly crossProcess: boolean;
  readonly delivery: Delivery;
}
/** Pure factory: returns a frozen Topic. crossProcess without schema throws. The bus learns topics on first publish or subscribe. */
export function defineTopic<T>(id: string, options?: TopicOptions<T>): Topic<T> {
  if (options?.crossProcess && options.schema === undefined) {
    throw new TesseraError('validation', `Topic "${id}" is crossProcess and needs a schema: payloads from other windows are untrusted`);
  }
  return Object.freeze({
    id,
    description: options?.description,
    schema: options?.schema,
    sticky: options?.sticky ?? false,
    crossProcess: options?.crossProcess ?? false,
    delivery: options?.delivery ?? 'sync',
  }) as Topic<T>;
}

/** CAB PublicationScope. */
export type PublishScope = 'global' | 'workItem' | 'descendants';

export interface PublishOptions {
  readonly scope?: PublishScope;                 // default 'global'
}

export interface EventMeta {
  readonly topicId: string;
  readonly scope: PublishScope;
  readonly sourceNodeId: string;
  readonly seq: number;                          // realm-wide, increasing
  readonly publishedAt: number;                  // scheduler.now()
  readonly origin: 'local' | 'remote';
  readonly replayed: boolean;                    // true for sticky replay
  readonly traceId: string | undefined;
  /** Plugin id of the publisher when a plugin published through its facade. Absent for core publications. */
  readonly publisher?: string | undefined;
}

/**
 * A handler returns nothing, or a promise (an async handler). The bus ignores other return values. A rejected promise is reported
 * as a subscriber failure of its owner, like a throw (it never reaches the global handler).
 */
export type EventHandler<T> = (payload: T, meta: EventMeta) => unknown;

export interface SubscribeOptions<T> {
  readonly delivery?: Delivery;                  // default topic.delivery
  /** Sticky topics only. Default true. */
  readonly replay?: boolean;
  /** @inProcessOnly A function. The v2 remote API uses a `when`-style expression. */
  readonly filter?: (payload: T, meta: EventMeta) => boolean;
  /** Queue limit for microtask and idle delivery. Default 1000. */
  readonly maxQueue?: number;
  readonly overflow?: 'dropOldest' | 'dropNewest';   // default 'dropOldest'
  /** @inProcessOnly Out of process, the returned disposable cancels. */
  readonly signal?: AbortSignal;
  /** Plugin id, for error attribution. The plugin facade sets it. */
  readonly owner?: string;
}

export interface EventNode {
  /** Equals the DI scope path of the owner: application, window or WorkItem. */
  readonly id: string;
  readonly parent: EventNode | undefined;
  publish<T>(topic: Topic<T>, payload: T, options?: PublishOptions): void;
  /** Internal path of the plugin facade: like publish(), and the delivered EventMeta carries `publisher`. */
  publishAs?<T>(publisher: string, topic: Topic<T>, payload: T, options?: PublishOptions): void;
  subscribe<T>(topic: Topic<T>, handler: EventHandler<T>, options?: SubscribeOptions<T>): IDisposable;
  /** The same subscription as an Event<T>, for bridges such as fromEvent(). */
  on<T>(topic: Topic<T>, options?: SubscribeOptions<T>): Event<T>;
}

export interface EventBusStats {
  readonly published: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly handlerErrors: number;
}

export interface EventRelay {
  /** Called for global publications of crossProcess topics with origin 'local'. */
  forward(topicId: string, payload: unknown, meta: EventMeta): void;
  readonly onRemote: Event<{ readonly topicId: string; readonly payload: unknown; readonly traceId: string | undefined }>;
}

export interface EventBus {
  readonly root: EventNode;
  createNode(parent: EventNode, id: string): EventNode & IDisposable;
  node(id: string): EventNode | undefined;
  readonly stats: Observable<EventBusStats>;
  /** Hosts install a relay to other windows. One relay at a time. */
  setRelay(relay: EventRelay): IDisposable;
}
export const EventBus: Token<EventBus> = token<EventBus>('tessera.eventBus');
/** The nearest event node. Provided in the application, window and every workItem DI scope. */
export const EventNode: Token<EventNode> = token<EventNode>('tessera.eventNode');


export const CoreTopics: {
  readonly lifecyclePhase: Topic<{ readonly phase: LifecyclePhase }>;
  readonly pluginState: Topic<{ readonly pluginId: string; readonly state: PluginState }>;
  readonly commandExecuted: Topic<CommandExecutedEvent>;
  readonly placementOpened: Topic<{ readonly placement: PlacementRef }>;
  readonly placementClosed: Topic<{ readonly placement: PlacementRef }>;
  readonly workbenchRestored: Topic<{ readonly placements: number }>;
} = {
  lifecyclePhase: defineTopic<{ readonly phase: LifecyclePhase }>('tessera.lifecycle.phase', { sticky: true, description: 'The lifecycle phase changed.' }),
  pluginState: defineTopic<{ readonly pluginId: string; readonly state: PluginState }>('tessera.plugin.state', { description: 'A plugin changed state.' }),
  commandExecuted: defineTopic<CommandExecutedEvent>('tessera.command.executed', { description: 'A command finished (any outcome).' }),
  placementOpened: defineTopic<{ readonly placement: PlacementRef }>('tessera.workbench.placementOpened', { description: 'A placement was opened.' }),
  placementClosed: defineTopic<{ readonly placement: PlacementRef }>('tessera.workbench.placementClosed', { description: 'A placement was closed.' }),
  workbenchRestored: defineTopic<{ readonly placements: number }>('tessera.workbench.restored', { sticky: true, description: 'The workbench model was restored.' }),
};

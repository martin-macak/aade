import type { Event, IDisposable, Schema, SerializedError } from '@tessera/base';
import type { InterceptorRegistry } from '@tessera/interceptors';
import type { Observable } from '@tessera/reactive';

// contracts.md section 17.2: RPC interfaces. The protocol itself is implemented by @tessera/rpc.

type MethodKeys<T> = { [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never }[keyof T] & string;
type EventKeys<T> = { [K in keyof T]: T[K] extends Event<unknown> ? K : never }[keyof T] & string;
type EventPayload<E> = E extends Event<infer P> ? P : never;
/** Parameters without a trailing AbortSignal. */
type WireArgs<F> = F extends (...args: infer A) => Promise<unknown> ? (A extends [...infer Head, AbortSignal?] ? Head : A) : never;

export interface RpcMethodSpec<A extends readonly unknown[], R> {
  /** Validates the wire arguments (a tuple). */
  readonly args: Schema<A>;
  readonly result: Schema<R>;
}

/** An interface that can cross a process boundary. T has only async methods and Event properties. */
export interface RpcInterface<T> {
  /** 'tessera.main.storage'. */
  readonly id: string;
  /** Integer. Both sides must agree, else calls reject 'rpc.versionMismatch'. */
  readonly version: number;
  readonly methods: { readonly [K in MethodKeys<T>]: RpcMethodSpec<WireArgs<T[K]>, Awaited<ReturnType<Extract<T[K], (...args: never[]) => unknown>>>> };
  readonly events: { readonly [K in EventKeys<T>]: Schema<EventPayload<T[K]>> };
}

export function defineRpcInterface<T>(id: string, version: number, spec: Pick<RpcInterface<T>, 'methods' | 'events'>): RpcInterface<T> {
  return Object.freeze({ id, version, methods: spec.methods, events: spec.events });
}

/** The caller's view: the same methods and events. */
export type Remote<T> = { readonly [K in MethodKeys<T> | EventKeys<T>]: T[K] };

export type RpcState = 'open' | 'unresponsive' | 'closed';

export interface RpcCallOptions {
  /** The ack timeout of this call (marks the peer 'unresponsive'). Default: RpcOptions.ackTimeoutMs. */
  readonly timeoutMs?: number;
  /** The most time this call may take until its result. Default: the interface override, else RpcOptions.callDeadlineMs (30 s). Rejects with 'rpc.callTimeout'. */
  readonly deadlineMs?: number;
}

export interface RpcConnection extends IDisposable {
  readonly name: string;
  readonly state: Observable<RpcState>;
  getProxy<T>(iface: RpcInterface<T>, options?: RpcCallOptions): Remote<T>;
  register<T>(iface: RpcInterface<T>, implementation: T): IDisposable;
  readonly onDidClose: Event<{ readonly reason: string }>;
}

export type RpcFrame =
  | { readonly t: 'hello'; readonly protocol: 1; readonly name: string; readonly interfaces: ReadonlyArray<{ readonly id: string; readonly version: number }>; /** Optional features the sender supports (reserved: 'stream' arrives with RISK-RPC-STREAM). A peer ignores names it does not know. */ readonly features?: readonly string[] }
  | { readonly t: 'req'; readonly id: number; readonly iface: string; readonly method: string; readonly args: readonly unknown[]; readonly trace?: string }
  | { readonly t: 'ack'; readonly id: number }
  | { readonly t: 'ok'; readonly id: number; readonly value: unknown }
  | { readonly t: 'err'; readonly id: number; readonly error: SerializedError }
  | { readonly t: 'cancel'; readonly id: number }
  | { readonly t: 'sub'; readonly id: number; readonly iface: string; readonly event: string }
  | { readonly t: 'evt'; readonly id: number; readonly payload: unknown }
  | { readonly t: 'unsub'; readonly id: number }
  | { readonly t: 'bye'; readonly reason: string };

export interface RpcTransport extends IDisposable {
  send(frame: RpcFrame, transfer?: readonly Transferable[]): void;
  readonly onFrame: Event<RpcFrame>;
  readonly onClose: Event<void>;
}

export interface RpcOptions {
  readonly name: string;
  /** Default 3000. A request without ack for this long marks the peer 'unresponsive'. */
  readonly ackTimeoutMs?: number;
  /** Runs kind 'ipc' interceptors on both sides. A getter, because the main connection exists before the shell creates the registry. */
  readonly interceptors?: () => InterceptorRegistry | undefined;
  /** Default true. Validate results on the caller side. */
  readonly validateResults?: boolean;
  /** Default 30000. The deadline of a call until its result; on expiry the call rejects with 'rpc.callTimeout' and a cancel frame goes out. */
  readonly callDeadlineMs?: number;
  /** Deadline per interface id (overrides callDeadlineMs). */
  readonly interfaceDeadlinesMs?: Readonly<Record<string, number>>;
  /** Default 1048576 (1 MB). A frame above this is refused: 'rpc.frameTooLarge' (outgoing: the call rejects, incoming: dropped and reported). */
  readonly maxFrameBytes?: number;
  /** Default 1000. Most calls waiting for a result on the caller side, and most requests running on the callee side. Above it: 'rpc.tooManyPending'. */
  readonly maxPending?: number;
  /** Off by default. When set, a request that runs longer on the callee side is aborted, its slot is freed and the caller gets 'rpc.callTimeout'. */
  readonly calleeDeadlineMs?: number;
}

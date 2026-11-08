import type { Event, IDisposable } from '@tessera/base';

/** Empty here. @tessera/contracts adds the six kinds by declaration merging (contracts.md 9.4). */
// oxlint-disable-next-line typescript/no-empty-object-type
export interface InvocationKinds {}
export type InvocationKind = Extract<keyof InvocationKinds, string>;

export interface InvocationContext<K extends InvocationKind = InvocationKind> {
  readonly kind: K;
  /** Command id, topic id, 'tokenId.method', plugin id, 'write:project', 'iface.method'. */
  readonly target: string;
  /** Immutable. Use with() to pass a changed copy downstream. */
  readonly data: Readonly<InvocationKinds[K]>;
  readonly signal: AbortSignal;
  /** Who started it: 'palette', 'keybinding', a plugin id, 'rpc:<connection>'. */
  readonly source: string;
  /** 0 for a top-level invocation. parent.depth + 1 otherwise. */
  readonly depth: number;
  readonly parent: InvocationContext | undefined;
  /** W3C trace id, propagated across RPC. */
  readonly traceId: string;
  /** The only mutable part: interceptors share notes here (timing, auth decisions). */
  readonly meta: Map<symbol, unknown>;
  with(patch: { readonly data?: InvocationKinds[K]; readonly target?: string }): InvocationContext<K>;
}

export type Next<K extends InvocationKind, R> = (ctx?: InvocationContext<K>) => Promise<R>;

export const InterceptorPhase = {
  Outer: 'outer',
  Guard: 'guard',
  Transform: 'transform',
  Resilience: 'resilience',
  Inner: 'inner',
} as const;
export type InterceptorPhase = (typeof InterceptorPhase)[keyof typeof InterceptorPhase];
export type InterceptorMode = 'guard' | 'observer';

/** Async around-advice. */
export interface Interceptor<K extends InvocationKind = InvocationKind, R = unknown> {
  readonly id: string;
  readonly kinds: readonly K[];
  /** Glob on target (matchGlob) or a predicate. Absent: matches every target of its kinds. */
  readonly match?: string | ((ctx: InvocationContext<K>) => boolean);
  readonly phase?: InterceptorPhase;
  readonly order?: number;
  readonly mode?: InterceptorMode;
  readonly owner?: string;
  /**
   * Guards only: the most time the guard itself may take before it calls next() (the time behind next() is not counted).
   * On expiry the invocation rejects with 'interceptor.guardTimeout'. Absent: no limit.
   */
  readonly timeoutMs?: number;
  /**
   * The interceptor sees the invocation data through a deep read-only view (writes throw `interceptor.readOnly`). The plugin runtime sets it
   * for every plugin-owned interceptor: a plugin changes data only through ctx.with({ data }) and next() in a guard.
   */
  readonly readOnlyData?: boolean;
  intercept(ctx: InvocationContext<K>, next: Next<K, R>): Promise<R>;
}

/** Sync observer, for kinds that cannot await (events). Cannot change or stop the invocation. */
export interface SyncObserver<K extends InvocationKind = InvocationKind> {
  readonly id: string;
  readonly kinds: readonly K[];
  readonly match?: string | ((ctx: InvocationContext<K>) => boolean);
  readonly order?: number;
  readonly owner?: string;
  /** See Interceptor.readOnlyData. */
  readonly readOnlyData?: boolean;
  observe(ctx: InvocationContext<K>): void;
}

export interface InterceptorInfo {
  readonly id: string;
  readonly kinds: readonly string[];
  readonly phase: InterceptorPhase;
  readonly order: number;
  readonly mode: InterceptorMode | 'sync-observer';
  readonly owner: string | undefined;
}

export interface CreateContextOptions {
  readonly signal?: AbortSignal;
  readonly source?: string;
  readonly parent?: InvocationContext;
}

export interface InterceptorRegistry {
  register<K extends InvocationKind, R>(interceptor: Interceptor<K, R>): IDisposable;
  registerObserver<K extends InvocationKind>(observer: SyncObserver<K>): IDisposable;
  createContext<K extends InvocationKind>(kind: K, target: string, data: InvocationKinds[K], options?: CreateContextOptions): InvocationContext<K>;
  /** Runs matching interceptors around terminal. No match: calls terminal directly. */
  run<K extends InvocationKind, R>(ctx: InvocationContext<K>, terminal: (ctx: InvocationContext<K>) => Promise<R>): Promise<R>;
  /** Runs matching sync observers. Never throws. */
  observe<K extends InvocationKind>(ctx: InvocationContext<K>): void;
  list(kind?: InvocationKind): readonly InterceptorInfo[];
  readonly onDidChange: Event<void>;
}

import { abortable, isDevMode, reportError, TesseraError, transactionGate, type Event, type IDisposable, toDisposable, CancellationError } from '@tessera/base';
import { useEngine } from './engine.ts';
import type { EngineComputed, EngineState } from './engine.ts';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface Observable<T> {
  readonly name: string | undefined;
  /** Tracked read: inside computed() or effect(), the reader depends on this value. */
  get(): T;
  /** Untracked read. React's getSnapshot uses it. */
  peek(): T;
  /** Called on change only (not with the initial value), after the outermost batch settles. */
  subscribe(listener: (value: T, previous: T) => void): IDisposable;
}

export interface State<T> extends Observable<T> {
  set(value: T): void;
  update(fn: (current: T) => T): void;
  asReadonly(): Observable<T>;
}

export interface ReactiveOptions<T> {
  /** Shown in traces and in reactiveDebug.nodes(). Name every long-lived node. */
  readonly name?: string;
  /** Default Object.is. For state: equal writes are skipped. For computed: an equal result keeps the old identity. */
  readonly equals?: (a: T, b: T) => boolean;
}

export interface ReactiveDebug {
  /** Turns the node registry on or off (`nodes()` lists nodes created while it is on). Default off. */
  enable(on?: boolean): void;
  liveSubscriptions(): number;
  liveEffects(): number;
  nodes(): ReadonlyArray<{ readonly name: string | undefined; readonly kind: 'state' | 'computed' | 'effect' }>;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

type NodeKind = 'state' | 'computed' | 'effect';
interface NodeInfo {
  readonly name: string | undefined;
  readonly kind: NodeKind;
}

let liveSubs = 0;
let liveFx = 0;
const nodeRefs = new Set<WeakRef<NodeInfo>>();

/** Set by reactiveDebug.enable(): registers nodes in production too (a debugging session). */
let debugRegistry = false;
const nodeCleanup = new FinalizationRegistry<WeakRef<NodeInfo>>((ref) => void nodeRefs.delete(ref));

/** Nodes are listed only in dev mode or with the debug flag: a production app that creates millions of nodes keeps no registry. */
function registerNode(info: NodeInfo): WeakRef<NodeInfo> | undefined {
  if (!debugRegistry && !isDevMode()) return undefined;
  const ref = new WeakRef(info);
  nodeRefs.add(ref);
  nodeCleanup.register(info, ref); // when the node is collected, its WeakRef leaves the set
  return ref;
}

export const reactiveDebug: ReactiveDebug = {
  enable(on = true) {
    debugRegistry = on;
  },
  liveSubscriptions: () => liveSubs,
  liveEffects: () => liveFx,
  nodes() {
    const out: NodeInfo[] = [];
    for (const ref of nodeRefs) {
      const info = ref.deref();
      if (info === undefined) nodeRefs.delete(ref);
      else out.push(info);
    }
    return out.map((i) => ({ name: i.name, kind: i.kind }));
  },
};

// ---------------------------------------------------------------------------------------------
// Guards: writes in computed, cycles
// ---------------------------------------------------------------------------------------------

/** Number of computed functions running right now. */
let computing = 0;

/** True while a computed function runs (reads and render passes inside it must not write state). */
export function isComputing(): boolean {
  return computing > 0;
}
/** Depth of facade-level writes. An outermost write starts a new "tick". */
let tickDepth = 0;
let tickRuns = new Map<object, number>();
const MAX_RUNS_PER_TICK = 100;
/** Work that waits for the end of the outermost tick (after the subscribers ran): the transaction gate of a transact() inside a batch. */
let afterTick: Array<() => void> = [];

function inTick<R>(fn: () => R): R {
  if (tickDepth === 0) tickRuns = new Map();
  tickDepth++;
  try {
    return fn();
  } catch (error) {
    throw normalizeEngineError(error);
  } finally {
    tickDepth--;
    if (tickDepth === 0) {
      try {
        flushSubscribers();
      } finally {
        // The hooks (the commit of a transact() inside a batch) run even when the subscriber flush failed, each on its own.
        const hooks = afterTick;
        afterTick = [];
        for (const hook of hooks) {
          try {
            hook();
          } catch (error) {
            reportError(error, { source: 'subscriber' });
          }
        }
      }
    }
  }
}

/** Engines report a runaway update in their own words (preact: "Cycle detected"). Callers see reactive.cycle. */
function normalizeEngineError(error: unknown): unknown {
  if (error instanceof Error && !(error instanceof TesseraError) && /cycle detected/i.test(error.message)) {
    return new TesseraError('reactive.cycle', `Reactive cycle: ${error.message}. An effect writes a value it reads.`, { cause: error });
  }
  return error;
}

/** Returns false when the effect ran too often in one tick (a cycle). It is then reported once and left inert. */
function allowRun(handle: object, label: string | undefined): boolean {
  const runs = (tickRuns.get(handle) ?? 0) + 1;
  tickRuns.set(handle, runs);
  if (runs <= MAX_RUNS_PER_TICK) return true;
  if (runs === MAX_RUNS_PER_TICK + 1) {
    reportError(
      new TesseraError('reactive.cycle', `Reactive cycle: effect${label ? ` "${label}"` : ''} ran more than ${MAX_RUNS_PER_TICK} times in one update. It writes a value it reads.`),
      { source: 'effect', ...(label !== undefined ? { target: label } : {}) },
    );
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Dev mode: deep-freeze
// ---------------------------------------------------------------------------------------------

function isPlain(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Object.isFrozen(value) || !isPlain(value)) return;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
}

// ---------------------------------------------------------------------------------------------
// Observable implementations
// ---------------------------------------------------------------------------------------------

class ObservableImpl<T> implements Observable<T> {
  readonly name: string | undefined;
  protected readonly info: NodeInfo;
  readonly #read: () => T;
  readonly #peek: () => T;

  constructor(kind: NodeKind, name: string | undefined, read: () => T, peek: () => T) {
    this.name = name;
    this.info = { name, kind };
    this.#read = read;
    this.#peek = peek;
    registerNode(this.info);
  }

  get(): T {
    return this.#read();
  }

  peek(): T {
    return this.#peek();
  }

  subscribe(listener: (value: T, previous: T) => void): IDisposable {
    return subscribeTo(this, listener);
  }
}

class StateImpl<T> extends ObservableImpl<T> implements State<T> {
  readonly #node: EngineState<T>;
  readonly #equals: ((a: T, b: T) => boolean) | undefined;
  #readonlyView: Observable<T> | undefined;

  constructor(node: EngineState<T>, name: string | undefined, equals: ((a: T, b: T) => boolean) | undefined) {
    super('state', name, () => node.read(), () => node.peek());
    this.#node = node;
    this.#equals = equals;
  }

  set(value: T): void {
    if (computing > 0) {
      throw new TesseraError('reactive.writeInComputed', `State${this.name ? ` "${this.name}"` : ''} was written inside a computed. Computed values must be pure.`);
    }
    const current = this.#node.peek();
    if (this.#equals ? this.#equals(current, value) : Object.is(current, value)) return;
    if (isDevMode()) deepFreeze(value);
    inTick(() => this.#node.write(value));
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.#node.peek()));
  }

  asReadonly(): Observable<T> {
    this.#readonlyView ??= new ObservableImpl('computed', this.name, () => this.get(), () => this.peek());
    return this.#readonlyView;
  }
}

// Subscribers are not run by the engine. The engine effect only marks the subscription as pending; the facade
// delivers after the outermost update settled, in subscription order, so all engines behave alike.
/** `last` of a subscription whose source threw when it was read. */
const ERRORED: unique symbol = Symbol('errored');
interface Subscription<T = unknown> {
  readonly seq: number;
  readonly source: Observable<T>;
  readonly listener: (value: T, previous: T | undefined) => void;
  last: T | typeof ERRORED;
  /** The source threw at the last read and the error was reported. Cleared by the next good read. */
  failed: boolean;
  active: boolean;
}
const pendingSubscriptions = new Set<Subscription>();
let subscriptionSeq = 0;
let flushingSubscribers = false;

/** Reads a subscription's source for a subscriber. A throwing computed is reported once and skipped until it recovers. */
function readForSubscriber<T>(subscription: Subscription<T>): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  try {
    const value = subscription.source.peek();
    subscription.failed = false;
    return { ok: true, value };
  } catch (error) {
    if (!subscription.failed) {
      subscription.failed = true;
      reportError(normalizeEngineError(error), { source: 'subscriber', ...(subscription.source.name !== undefined ? { target: subscription.source.name } : {}) });
    }
    return { ok: false };
  }
}

function flushSubscribers(): void {
  if (flushingSubscribers) return;
  flushingSubscribers = true;
  const engine = useEngine();
  const deliveries = new Map<Subscription, number>();
  try {
    // One pass: sort the pending subscriptions once by subscription order (O(P log P)), deliver them, and loop for the ones that listeners queued.
    while (pendingSubscriptions.size > 0) {
      const pass = [...pendingSubscriptions].sort((a, b) => a.seq - b.seq);
      pendingSubscriptions.clear();
      for (const next of pass) {
        if (!next.active) continue;
        const read = readForSubscriber(next);
        if (!read.ok) continue;
        const value = read.value;
        if (Object.is(value, next.last)) continue; // a write that was reverted before delivery is not a change
        const count = (deliveries.get(next) ?? 0) + 1;
        deliveries.set(next, count);
        if (count > MAX_RUNS_PER_TICK) {
          if (count === MAX_RUNS_PER_TICK + 1) {
            reportError(
              new TesseraError('reactive.cycle', `Reactive cycle: a subscriber of${next.source.name ? ` "${next.source.name}"` : ' a value'} keeps changing the value it listens to.`),
              { source: 'subscriber', ...(next.source.name !== undefined ? { target: next.source.name } : {}) },
            );
          }
          continue;
        }
        const previous = (next.last === ERRORED ? undefined : next.last) as unknown;
        next.last = value;
        const { listener } = next;
        engine.untracked(() => {
          try {
            listener(value, previous);
          } catch (error) {
            reportError(error, { source: 'subscriber', ...(next.source.name !== undefined ? { target: next.source.name } : {}) });
          }
        });
      }
    }
  } finally {
    flushingSubscribers = false;
  }
}

function subscribeTo<T>(source: Observable<T>, listener: (value: T, previous: T) => void): IDisposable {
  const engine = useEngine();
  liveSubs++;
  const subscription: Subscription<T> = { seq: subscriptionSeq++, source, listener: listener as Subscription<T>['listener'], last: ERRORED, failed: false, active: true };
  const initial = readForSubscriber(subscription);
  if (initial.ok) subscription.last = initial.value;
  let first = true;
  const stop = inTick(() =>
    engine.effect(() => {
      try {
        source.get(); // tracked: this is the dependency
      } catch {
        // The computed threw. The writer must not see it: the flush reads it again, reports it once and skips it.
        if (first) {
          first = false;
          return;
        }
        if (subscription.active) pendingSubscriptions.add(subscription as Subscription);
        return;
      }
      if (first) {
        first = false;
        return;
      }
      if (subscription.active) pendingSubscriptions.add(subscription as Subscription);
    }),
  );
  return toDisposable(() => {
    if (!subscription.active) return;
    subscription.active = false;
    pendingSubscriptions.delete(subscription as Subscription);
    liveSubs--;
    stop();
  });
}

// ---------------------------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------------------------

export function state<T>(initial: T, options?: ReactiveOptions<T>): State<T> {
  const engine = useEngine();
  if (isDevMode()) deepFreeze(initial);
  return new StateImpl(engine.state(initial), options?.name, options?.equals);
}

/** What a computed stores when its function threw. The engine never sees the exception, so a throwing computed cannot break a write (or a flush) of its inputs. */
class Failure {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

export function computed<T>(fn: () => T, options?: ReactiveOptions<T>): Observable<T> {
  const engine = useEngine();
  const equals = options?.equals;
  const name = options?.name;
  let previous: { readonly value: T } | undefined;
  let evaluating = false;
  const cycle = (): TesseraError =>
    new TesseraError('reactive.cycle', `Reactive cycle: computed${name ? ` "${name}"` : ''} reads itself, directly or through other computed values.`);
  const node: EngineComputed<T | Failure> = engine.computed<T | Failure>(() => {
    if (evaluating) return new Failure(cycle());
    evaluating = true;
    computing++;
    try {
      const next = fn();
      if (equals && previous !== undefined && equals(previous.value, next)) return previous.value;
      if (isDevMode()) deepFreeze(next);
      previous = { value: next };
      return next;
    } catch (error) {
      return new Failure(error);
    } finally {
      computing--;
      evaluating = false;
    }
  });
  // Engines differ on self-reading computeds (preact throws, alien returns NaN), so the facade checks it itself.
  const guard = (read: () => T | Failure): T => {
    if (evaluating) throw cycle();
    let value: T | Failure;
    try {
      value = read();
    } catch (error) {
      throw normalizeEngineError(error);
    }
    if (value instanceof Failure) throw normalizeEngineError(value.error);
    return value;
  };
  return new ObservableImpl('computed', name, () => guard(() => node.read()), () => guard(() => node.peek()));
}

/** fn runs now and again after each relevant change. It may return a cleanup. */
export function effect(fn: () => void | (() => void), options?: { readonly name?: string }): IDisposable {
  const engine = useEngine();
  const name = options?.name;
  const info: NodeInfo = { name, kind: 'effect' };
  const nodeRef = registerNode(info);
  liveFx++;
  let cleanup: (() => void) | undefined;
  let disposed = false;
  const handle = {};
  const runCleanup = (): void => {
    const c = cleanup;
    cleanup = undefined;
    if (c === undefined) return;
    engine.untracked(() => {
      try {
        c();
      } catch (error) {
        reportError(error, { source: 'effect', ...(name !== undefined ? { target: name } : {}) });
      }
    });
  };
  const stop = inTick(() =>
    engine.effect(() => {
      if (disposed) return;
      if (!allowRun(handle, name)) return;
      runCleanup();
      try {
        const result = fn();
        if (typeof result === 'function') cleanup = result;
      } catch (error) {
        // An effect that threw stays alive and runs again on the next change.
        reportError(normalizeEngineError(error), { source: 'effect', ...(name !== undefined ? { target: name } : {}) });
      }
    }),
  );
  return toDisposable(() => {
    if (disposed) return;
    disposed = true;
    liveFx--;
    if (nodeRef !== undefined) nodeRefs.delete(nodeRef); // O(1): the effect keeps its own WeakRef
    stop();
    runCleanup();
  });
}

export function batch<R>(fn: () => R): R {
  const engine = useEngine();
  return inTick(() => engine.batch(fn));
}

/**
 * batch() plus the transaction gate: events fired inside are delivered after commit. Inside an enclosing batch or write the
 * commit waits for the end of the outermost tick, so state subscribers run before event subscribers (the doc's order).
 * fn must be synchronous: in dev mode a thenable result throws 'reactive.asyncTransaction' (the transaction would commit before the await ends).
 */
export function transact<R>(fn: () => R): R {
  transactionGate.begin();
  let ok = false;
  let deferred = false;
  try {
    const result = batch(fn);
    if (isDevMode() && typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
      throw new TesseraError('reactive.asyncTransaction', 'transact() got a promise from fn. A transaction ends when fn returns, so it cannot wait for async work: do the async part outside and transact the writes.');
    }
    ok = true;
    if (tickDepth > 0) {
      deferred = true;
      afterTick.push(() => transactionGate.end(true));
    }
    return result;
  } finally {
    if (!deferred) transactionGate.end(ok);
  }
}

export function untracked<R>(fn: () => R): R {
  return useEngine().untracked(fn);
}

export function isObservable(value: unknown): value is Observable<unknown> {
  return value instanceof ObservableImpl;
}

export function constant<T>(value: T): Observable<T> {
  return new ObservableImpl('computed', undefined, () => value, () => value);
}

/**
 * Bridge, event to state. The observable subscribes to `event` on first access and unsubscribes on dispose().
 * Each event is a change signal: `read` runs again afterwards.
 */
export function fromEvent<T>(event: Event<unknown>, read: () => T, options?: ReactiveOptions<T>): Observable<T> & IDisposable {
  const version = state(0);
  let subscription: IDisposable | undefined;
  let disposed = false;
  const ensure = (): void => {
    if (subscription === undefined && !disposed) {
      subscription = event(() => {
        version.update((v) => v + 1);
      });
    }
  };
  const derived = computed(
    () => {
      version.get();
      return read();
    },
    options,
  );
  const result = new ObservableImpl<T>(
    'computed',
    options?.name,
    () => {
      ensure();
      return derived.get();
    },
    () => {
      ensure();
      return derived.peek();
    },
  );
  return Object.assign(result, {
    dispose() {
      disposed = true;
      subscription?.dispose();
      subscription = undefined;
    },
  });
}

/** Bridge, state to event. Fires (value) on each settled change. */
export function changes<T>(source: Observable<T>): Event<T> {
  return (listener, options) => {
    // One subscription that ends itself after the first change when `once` is set (no second inner subscription that could leak).
    const holder: { subscription?: IDisposable } = {};
    let fired = false;
    holder.subscription = source.subscribe((value) => {
      if (options?.once) {
        if (fired) return;
        fired = true;
      }
      try {
        listener(value);
      } finally {
        if (options?.once) holder.subscription?.dispose();
      }
    });
    const handle = abortable(holder.subscription, options?.signal);
    options?.store?.add(handle);
    return handle;
  };
}

/** Resolves when the observable is true. Rejects with CancellationError on abort. */
export function whenTrue(source: Observable<boolean>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancellationError());
  if (source.peek()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const subscription = source.subscribe((value) => {
      if (!value) return;
      cleanup();
      resolve();
    });
    const onAbort = (): void => {
      cleanup();
      reject(new CancellationError());
    };
    const cleanup = (): void => {
      subscription.dispose();
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

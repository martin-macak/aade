import {
  Emitter,
  markDisposed,
  reportError,
  toDisposable,
  trackDisposable,
  type DisposableLike,
  type Event,
  type IAsyncDisposable,
  type IDisposable,
  getScheduler,
  TesseraError,
} from '@tessera/base';
import { ResolutionError } from './errors.ts';
import type { MultiToken, Token } from './token.ts';

// ---------------------------------------------------------------------------------------------
// Public types (contracts.md section 7.2)
// ---------------------------------------------------------------------------------------------

export const ScopeKind = {
  Application: 'application',
  Window: 'window',
  WorkItem: 'workItem',
  View: 'view',
  Placement: 'placement',
  Plugin: 'plugin',
  Test: 'test',
} as const;
export type ScopeKind = (typeof ScopeKind)[keyof typeof ScopeKind];

export type ScopeState = 'active' | 'disposing' | 'disposed';

export interface ScopeDisposeOptions {
  /** Absolute time (scheduler.now() clock) after which the scope stops waiting for disposers. */
  readonly deadline?: number;
}

/** Longest wait for one async disposer or child scope. */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5000;

/** singleton: one per registering scope. scoped: one per resolving scope. transient: new per request. */
export type Lifetime = 'singleton' | 'scoped' | 'transient';

/** Runs inside an injection context, so it may call inject(). Must be synchronous. */
export type Factory<T> = () => T;

export interface ProvideOptions {
  readonly lifetime?: Lifetime;
  /** Opt-in interception of the listed async methods (section 7.5). */
  readonly intercept?: { readonly methods: readonly string[] };
  /** Diagnostics and cleanup: the plugin id that owns this registration. */
  readonly owner?: string;
  /** Allows replacing a registration of the same id in the same scope. Composition root and tests only. */
  readonly replace?: boolean;
}

export interface ScopeReader {
  get<T>(token: Token<T>): T;
  get<T>(token: Token<T>, options: { readonly optional: true }): T | undefined;
  getAll<T>(token: MultiToken<T>): readonly T[];
  has(token: Token<unknown> | MultiToken<unknown>): boolean;
}

export interface Scope extends ScopeReader, IAsyncDisposable {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parent: Scope | undefined;
  /** 'application/window/workItem:tasks/view:tasks.list/placement:p-1f3a' */
  readonly path: string;
  readonly state: ScopeState;

  provide<T>(token: Token<T>, factory: Factory<T>, options?: ProvideOptions): IDisposable;
  /** ctor is called with no arguments inside an injection context. */
  provideClass<T>(token: Token<T>, ctor: new () => T, options?: ProvideOptions): IDisposable;
  /** The scope does not dispose a provided value unless dispose is true. */
  provideValue<T>(token: Token<T>, value: T, options?: { readonly owner?: string; readonly dispose?: boolean }): IDisposable;
  provideMany<T>(
    token: MultiToken<T>,
    factory: Factory<T>,
    options?: { readonly lifetime?: Lifetime; readonly owner?: string; readonly order?: number },
  ): IDisposable;

  /**
   * The owner (plugin id) of every registration of this token id that a get() or getAll() from here would see.
   * `undefined` marks a registration without an owner: core code. Empty when nothing is registered. The plugin gate reads it.
   */
  ownersOf(tokenId: string): readonly (string | undefined)[];

  /**
   * Fires when a registration of the multi token is added or removed in this scope or any scope of the tree (it may not change what
   * getAll() returns from here: re-read it). The version signal behind `PluginServices.observeAll`.
   */
  onDidChangeAll(token: MultiToken<unknown>): Event<void>;

  createChild(kind: ScopeKind, id: string): Scope;
  /** Runs fn with this scope as the injection context. */
  run<R>(fn: () => R): R;
  /** new ctor(...args) inside an injection context. The scope does not own the result unless track() is called. */
  createInstance<A extends unknown[], T>(ctor: new (...args: A) => T, ...args: A): T;
  /** Adopts a disposable: this scope disposes it. Returns value. */
  track<T extends object>(value: T): T;

  readonly onWillDispose: Event<Scope>;
  /** Children first (reverse creation order), then owned instances in reverse creation order. */
  /**
   * Disposes children (newest first), then owned values (newest first). Every child and every async disposer is bounded by
   * `disposeTimeoutMs` (default 5000) and by `options.deadline` (absolute, in scheduler.now() time) when given: a hung disposer is reported
   * (di.disposeTimeout) and skipped, and the scope still ends in state 'disposed'. A second call returns the first call's promise.
   */
  dispose(options?: ScopeDisposeOptions): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ServiceCall {
  readonly tokenId: string;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly scopePath: string;
}

/** Installed on the root scope by the shell. It forwards to the interceptor pipeline (kind 'service'). */
export type ServiceInterceptionHook = (call: ServiceCall, invoke: (args: readonly unknown[]) => Promise<unknown>) => Promise<unknown>;

/**
 * Narrows what inject(), injectAll() and injectLazy() may resolve while a function runs (see runFiltered). The runtime of
 * one plugin installs it, so the manifest decides what the plugin code can reach. Tokens compare by id.
 */
export interface InjectionFilter {
  /** Throws to refuse the token. */
  check(tokenId: string): void;
  /** May replace the resolved value, for example with a per-plugin facade. */
  wrap?<T>(tokenId: string, value: T): T;
}

export interface Lazy<T> {
  readonly value: T;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface Registration {
  readonly tokenId: string;
  readonly multi: boolean;
  readonly factory: Factory<unknown>;
  readonly lifetime: Lifetime;
  readonly owner: string | undefined;
  readonly intercept: readonly string[] | undefined;
  readonly order: number;
  readonly seq: number;
  /** Provided values are not disposed by the scope unless the caller asks for it. */
  readonly disposesValue: boolean;
  readonly scope: ScopeImpl;
  removed: boolean;
  /** Singleton cache (home scope = registering scope). */
  singleton: { readonly value: unknown } | undefined;
  /** Every instance created from this registration, in any scope, with its creation sequence. */
  readonly instances: Array<{ readonly scope: ScopeImpl; readonly value: unknown; readonly seq: number }>;
}

interface Owned {
  readonly value: unknown;
  readonly seq: number;
  readonly registration: Registration | undefined;
}

interface Frame {
  readonly scope: ScopeImpl;
  /** Lifetime of the registration whose factory is running, or undefined for run()/createInstance(). */
  readonly lifetime: Lifetime | undefined;
  /** Set by runFiltered(): the plugin code that runs here may resolve only what the filter allows. A nested factory frame has no filter. */
  readonly filter?: InjectionFilter;
}

let frame: Frame | undefined;
/** Entries 'tokenId@scopePath' of the factories that are running now. One synchronous resolution at a time. */
const resolving: string[] = [];
let sequence = 0;

/** State shared by the whole scope tree of one root. */
interface TreeState {
  readonly interception: ServiceInterceptionHook | undefined;
  readonly disposeTimeoutMs: number;
  /** Token id -> kind and number of live registrations, to detect Token/MultiToken clashes. */
  readonly kinds: Map<string, { multi: boolean; count: number }>;
  /** Fires with the token id whenever a multi registration is added or removed anywhere in the tree (the change signal of observeAll). */
  readonly multiChanged: Emitter<string>;
}

function segmentOf(kind: ScopeKind, id: string): string {
  return kind === 'application' || kind === 'window' ? kind : `${kind}:${id}`;
}

function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
}

function hasDisposeProtocol(value: unknown): value is DisposableLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const v = value as Record<PropertyKey, unknown>;
  return typeof v['dispose'] === 'function' || typeof v[Symbol.dispose] === 'function' || typeof v[Symbol.asyncDispose] === 'function';
}

/** Starts disposal by the same protocol order as disposeLike(). Returns the promise of an async disposer, or nothing for a sync one. */
function startDispose(value: DisposableLike): Promise<void> | void {
  const v = value as Record<PropertyKey, unknown>;
  if (typeof v[Symbol.asyncDispose] === 'function') return (v[Symbol.asyncDispose] as () => Promise<void>).call(value);
  if (typeof v['dispose'] === 'function') {
    const result = (v['dispose'] as () => void | Promise<void>).call(value);
    return isThenable(result) ? (result as Promise<void>) : undefined;
  }
  if (typeof v[Symbol.dispose] === 'function') (v[Symbol.dispose] as () => void).call(value);
  return undefined;
}

/** Synchronous disposal for registration handles: asyncDispose-only values are started and their failure reported. */
function disposeSync(value: DisposableLike): void {
  const v = value as Record<PropertyKey, unknown>;
  if (typeof v['dispose'] === 'function') {
    const result = (v['dispose'] as () => unknown).call(value);
    if (isThenable(result)) void (result as Promise<unknown>).catch((error: unknown) => reportError(error, { source: 'dispose' }));
  } else if (typeof v[Symbol.dispose] === 'function') {
    (v[Symbol.dispose] as () => void).call(value);
  } else if (typeof v[Symbol.asyncDispose] === 'function') {
    void (v[Symbol.asyncDispose] as () => Promise<void>).call(value).catch((error: unknown) => reportError(error, { source: 'dispose' }));
  }
}

class ScopeImpl implements Scope {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parent: ScopeImpl | undefined;
  readonly path: string;
  readonly #tree: TreeState;
  readonly #single = new Map<string, Registration>();
  readonly #multi = new Map<string, Registration[]>();
  readonly #scopedCache = new Map<Registration, { readonly value: unknown }>();
  readonly #owned: Owned[] = [];
  readonly #children: ScopeImpl[] = [];
  readonly #willDispose = new Emitter<Scope>({ name: 'scope.willDispose', deferInTransaction: false });
  #state: ScopeState = 'active';
  #disposing: Promise<void> | undefined;

  constructor(kind: ScopeKind, id: string, parent: ScopeImpl | undefined, tree: TreeState) {
    this.kind = kind;
    this.id = id;
    this.parent = parent;
    this.#tree = tree;
    this.path = parent ? `${parent.path}/${segmentOf(kind, id)}` : segmentOf(kind, id);
    if (parent) parent.#children.push(this);
    trackDisposable(this, { kind: 'scope', name: this.path });
  }

  get state(): ScopeState {
    return this.#state;
  }

  get onWillDispose(): Event<Scope> {
    return this.#willDispose.event;
  }

  // ----- registration -----------------------------------------------------------------------

  provide<T>(token: Token<T>, factory: Factory<T>, options?: ProvideOptions): IDisposable {
    return this.#register(token.id, false, factory, options?.lifetime ?? 'singleton', options?.owner, options?.intercept?.methods, 0, options?.replace === true, true);
  }

  provideClass<T>(token: Token<T>, ctor: new () => T, options?: ProvideOptions): IDisposable {
    return this.provide(token, () => new ctor(), options);
  }

  provideValue<T>(token: Token<T>, value: T, options?: { readonly owner?: string; readonly dispose?: boolean }): IDisposable {
    return this.#register(token.id, false, () => value, 'singleton', options?.owner, undefined, 0, false, options?.dispose === true);
  }

  provideMany<T>(token: MultiToken<T>, factory: Factory<T>, options?: { readonly lifetime?: Lifetime; readonly owner?: string; readonly order?: number }): IDisposable {
    return this.#register(token.id, true, factory, options?.lifetime ?? 'singleton', options?.owner, undefined, options?.order ?? 0, false, true);
  }

  #register(
    tokenId: string,
    multi: boolean,
    factory: Factory<unknown>,
    lifetime: Lifetime,
    owner: string | undefined,
    intercept: readonly string[] | undefined,
    order: number,
    replace: boolean,
    disposesValue: boolean,
  ): IDisposable {
    this.#assertAlive(`provide ${tokenId}`);
    const kinds = this.#tree.kinds;
    const known = kinds.get(tokenId);
    if (known && known.multi !== multi) {
      throw new ResolutionError('di.tokenKindClash', `Token id "${tokenId}" is registered as a ${known.multi ? 'MultiToken' : 'Token'} and cannot also be a ${multi ? 'MultiToken' : 'Token'}`);
    }
    if (!multi) {
      const existing = this.#single.get(tokenId);
      if (existing) {
        if (!replace) throw new ResolutionError('di.duplicate', `Token "${tokenId}" is already registered in scope "${this.path}"`);
        this.#removeRegistration(existing);
      }
    }
    const registration: Registration = {
      tokenId,
      multi,
      factory,
      lifetime,
      owner,
      intercept,
      order,
      seq: sequence++,
      disposesValue,
      scope: this,
      removed: false,
      singleton: undefined,
      instances: [],
    };
    if (multi) {
      const list = this.#multi.get(tokenId) ?? [];
      list.push(registration);
      this.#multi.set(tokenId, list);
      this.#tree.multiChanged.fire(tokenId);
    } else {
      this.#single.set(tokenId, registration);
    }
    const entry = kinds.get(tokenId);
    if (entry) entry.count++;
    else kinds.set(tokenId, { multi, count: 1 });
    return toDisposable(() => this.#removeRegistration(registration, true));
  }

  /** Removes a registration and disposes every instance created from it, in any scope (newest first). */
  #removeRegistration(registration: Registration, throwErrors = false): void {
    if (registration.removed) return;
    registration.removed = true;
    if (registration.multi) {
      const list = this.#multi.get(registration.tokenId);
      if (list) {
        const next = list.filter((r) => r !== registration);
        if (next.length === 0) this.#multi.delete(registration.tokenId);
        else this.#multi.set(registration.tokenId, next);
        this.#tree.multiChanged.fire(registration.tokenId);
      }
    } else if (this.#single.get(registration.tokenId) === registration) {
      this.#single.delete(registration.tokenId);
    }
    const entry = this.#tree.kinds.get(registration.tokenId);
    if (entry && --entry.count <= 0) this.#tree.kinds.delete(registration.tokenId);

    const instances = registration.instances.splice(0, registration.instances.length).toSorted((a, b) => b.seq - a.seq);
    const errors: unknown[] = [];
    for (const instance of instances) {
      instance.scope.#forget(registration, instance.value);
      if (registration.disposesValue && hasDisposeProtocol(instance.value)) {
        try {
          disposeSync(instance.value);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    registration.singleton = undefined;
    if (errors.length > 0) {
      if (throwErrors) throw new AggregateError(errors, `Errors while disposing instances of "${registration.tokenId}"`);
      for (const error of errors) reportError(error, { source: 'dispose', target: registration.tokenId });
    }
  }

  #forget(registration: Registration, value: unknown): void {
    this.#scopedCache.delete(registration);
    const index = this.#owned.findIndex((o) => o.registration === registration && o.value === value);
    if (index >= 0) this.#owned.splice(index, 1);
  }

  // ----- resolution -------------------------------------------------------------------------

  get<T>(token: Token<T>): T;
  get<T>(token: Token<T>, options: { readonly optional: true }): T | undefined;
  get<T>(token: Token<T>, options?: { readonly optional?: boolean }): T | undefined {
    this.#assertAlive(`get ${token.id}`);
    const registration = this.#find(token.id);
    if (!registration) {
      if (options?.optional) return undefined;
      throw new ResolutionError('di.noProvider', `No provider for ${token} from scope "${this.path}"`, [...resolving, `${token.id}@${this.path}`]);
    }
    if (frame?.lifetime === 'singleton' && registration.lifetime === 'scoped') {
      throw new ResolutionError(
        'di.captive',
        `Captive dependency: a singleton factory resolves the scoped ${token}. The singleton would keep one scope's instance alive for the whole application.`,
        [...resolving, `${token.id}@${this.path}`],
      );
    }
    return this.#instanceOf(registration, this) as T;
  }

  onDidChangeAll(token: MultiToken<unknown>): Event<void> {
    return (listener, options) => this.#tree.multiChanged.event((id) => id === token.id && listener(), options);
  }

  getAll<T>(token: MultiToken<T>): readonly T[] {
    this.#assertAlive(`getAll ${token.id}`);
    const out: T[] = [];
    for (const s of this.#lineage().reverse()) {
      const list = s.#multi.get(token.id);
      if (!list) continue;
      const ordered = list.toSorted((a, b) => a.order - b.order || a.seq - b.seq);
      for (const registration of ordered) out.push(this.#instanceOf(registration, this) as T);
    }
    return out;
  }

  has(token: Token<unknown> | MultiToken<unknown>): boolean {
    return this.#lineage().some((s) => s.#single.has(token.id) || s.#multi.has(token.id));
  }

  ownersOf(tokenId: string): readonly (string | undefined)[] {
    const single = this.#find(tokenId);
    if (single) return [single.owner];
    const owners: Array<string | undefined> = [];
    for (const s of this.#lineage()) for (const registration of s.#multi.get(tokenId) ?? []) owners.push(registration.owner);
    return owners;
  }

  #find(tokenId: string): Registration | undefined {
    for (const s of this.#lineage()) {
      const found = s.#single.get(tokenId);
      if (found) return found;
    }
    return undefined;
  }

  /** This scope, then its parent, up to the root. */
  #lineage(): ScopeImpl[] {
    const out: ScopeImpl[] = [this];
    for (let s = this.parent; s; s = s.parent) out.push(s);
    return out;
  }

  /** `resolver` is the scope `get` was called on (or the injection context scope). */
  #instanceOf(registration: Registration, resolver: ScopeImpl): unknown {
    const home = registration.lifetime === 'singleton' ? registration.scope : resolver;
    if (registration.lifetime === 'singleton' && registration.singleton) return registration.singleton.value;
    if (registration.lifetime === 'scoped') {
      const cached = home.#scopedCache.get(registration);
      if (cached) return cached.value;
    }
    if (home.#state !== 'active') {
      throw new ResolutionError('di.disposed', `Scope "${home.path}" is ${home.#state}; cannot create ${registration.tokenId}`);
    }
    const key = `${registration.tokenId}@${home.path}`;
    if (resolving.includes(key)) {
      throw new ResolutionError('di.cycle', `Circular dependency on ${registration.tokenId}. Break it with injectLazy().`, [...resolving, key]);
    }
    resolving.push(key);
    const previous = frame;
    frame = { scope: home, lifetime: registration.lifetime };
    let value: unknown;
    try {
      value = registration.factory();
      if (isThenable(value)) {
        throw new ResolutionError('di.asyncFactory', `Factory of ${registration.tokenId} returned a promise. Factories are synchronous: do async setup in a lifecycle contribution or plugin activate().`, [...resolving]);
      }
    } finally {
      frame = previous;
      resolving.pop();
    }
    if (registration.intercept && registration.intercept.length > 0 && this.#root().#tree.interception) {
      value = wrapForInterception(value, registration.tokenId, registration.intercept, home.path, this.#root().#tree.interception as ServiceInterceptionHook);
    }
    if (registration.removed) return value; // removed while it was being created: the caller keeps it, nobody owns it
    if (registration.lifetime === 'singleton') registration.singleton = { value };
    else if (registration.lifetime === 'scoped') home.#scopedCache.set(registration, { value });
    if (registration.disposesValue && hasDisposeProtocol(value)) {
      const seq = sequence++;
      home.#owned.push({ value, seq, registration });
      registration.instances.push({ scope: home, value, seq });
    }
    return value;
  }

  #root(): ScopeImpl {
    return this.#lineage().at(-1) as ScopeImpl;
  }

  // ----- tree -------------------------------------------------------------------------------

  createChild(kind: ScopeKind, id: string): Scope {
    this.#assertAlive(`createChild ${kind}:${id}`);
    return new ScopeImpl(kind, id, this, this.#tree);
  }

  run<R>(fn: () => R): R {
    this.#assertAlive('run');
    const previous = frame;
    frame = { scope: this, lifetime: undefined };
    try {
      return fn();
    } finally {
      frame = previous;
    }
  }

  createInstance<A extends unknown[], T>(ctor: new (...args: A) => T, ...args: A): T {
    return this.run(() => new ctor(...args));
  }

  track<T extends object>(value: T): T {
    this.#assertAlive('track');
    if (hasDisposeProtocol(value)) this.#owned.push({ value, seq: sequence++, registration: undefined });
    return value;
  }

  #assertAlive(action: string): void {
    if (this.#state !== 'active') {
      throw new ResolutionError('di.disposed', `Cannot ${action}: scope "${this.path}" is ${this.#state}`);
    }
  }

  // ----- disposal ---------------------------------------------------------------------------

  dispose(options?: ScopeDisposeOptions): Promise<void> {
    this.#disposing ??= this.#disposeNow(options?.deadline);
    return this.#disposing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  /**
   * Waits for `work` at most until the earlier of the per-disposer limit and the caller deadline. A timeout is reported and the
   * wait ends; the work itself keeps running (it cannot be cancelled), but nobody waits for it.
   */
  async #bounded(work: () => Promise<void> | void, deadline: number | undefined, describe: { readonly token?: string; readonly owner?: string; readonly what: string; readonly child?: boolean }): Promise<void> {
    const scheduler = getScheduler();
    const now = scheduler.now();
    // A child scope bounds its own disposers, so the parent waits for it only until the caller deadline.
    const own = describe.child === true ? Infinity : this.#tree.disposeTimeoutMs;
    const limit = Math.min(own, deadline === undefined ? Infinity : deadline - now);
    const result = work(); // a synchronous disposer needs no timer
    if (!isThenable(result)) return;
    const promise = result as Promise<void>;
    let timer: IDisposable | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      if (limit <= 0) resolve('timeout');
      else if (limit !== Infinity) timer = scheduler.timeout(() => resolve('timeout'), limit);
    });
    try {
      const outcome = await Promise.race([promise.then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        promise.catch(() => undefined); // a late rejection of the abandoned disposer is not an unhandled rejection
        reportError(
          new TesseraError('di.disposeTimeout', `Disposing ${describe.what} in scope "${this.path}" did not finish within ${limit <= 0 ? 'the caller deadline' : `${limit} ms`}; it is skipped`, {
            details: { path: this.path, ...(describe.token !== undefined ? { token: describe.token } : {}), ...(describe.owner !== undefined ? { owner: describe.owner } : {}) },
          }),
          { source: 'dispose', ...(describe.token !== undefined ? { target: describe.token } : {}), ...(describe.owner !== undefined ? { pluginId: describe.owner } : {}) },
        );
      }
    } finally {
      timer?.dispose();
    }
  }

  async #disposeNow(deadline: number | undefined): Promise<void> {
    this.#state = 'disposing';
    const errors: unknown[] = [];
    try {
      this.#willDispose.fire(this);
    } catch (error) {
      errors.push(error);
    }
    for (const child of [...this.#children].reverse()) {
      try {
        await this.#bounded(() => child.dispose(deadline === undefined ? undefined : { deadline }), deadline, { what: `child scope "${child.path}"`, child: true });
      } catch (error) {
        errors.push(error);
      }
    }
    const owned = this.#owned.toSorted((a, b) => b.seq - a.seq);
    this.#owned.length = 0;
    for (const entry of owned) {
      try {
        if (hasDisposeProtocol(entry.value)) {
          await this.#bounded(() => startDispose(entry.value as DisposableLike), deadline, {
            what: entry.registration ? `service "${entry.registration.tokenId}"` : 'an owned value',
            ...(entry.registration ? { token: entry.registration.tokenId } : {}),
            ...(entry.registration?.owner !== undefined ? { owner: entry.registration.owner } : {}),
          });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    for (const list of [...this.#single.values(), ...[...this.#multi.values()].flat()]) {
      list.removed = true;
      list.singleton = undefined;
      list.instances.length = 0;
      const entry = this.#tree.kinds.get(list.tokenId);
      if (entry && --entry.count <= 0) this.#tree.kinds.delete(list.tokenId);
    }
    this.#single.clear();
    this.#multi.clear();
    this.#scopedCache.clear();
    this.#willDispose.dispose();
    this.#state = 'disposed';
    if (this.parent) this.parent.#detach(this);
    markDisposed(this);
    if (errors.length > 0) throw new AggregateError(errors, `Errors while disposing scope "${this.path}"`);
  }

  #detach(child: ScopeImpl): void {
    const index = this.#children.indexOf(child);
    if (index >= 0) this.#children.splice(index, 1);
  }

  // ----- injection context access (used by inject functions) --------------------------------

  static contextScope(fn: string): ScopeImpl {
    if (!frame) {
      throw new ResolutionError('di.noContext', `${fn}() was called outside an injection context. An injection context exists only synchronously inside a factory, a constructor created by the container, scope.run() or scope.createInstance(). After an await it is gone: capture injectScope() first.`);
    }
    return frame.scope;
  }

  static contextFilter(): InjectionFilter | undefined {
    return frame?.filter;
  }

  static hasContext(): boolean {
    return frame !== undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Interception proxy (section 7.5)
// ---------------------------------------------------------------------------------------------

function wrapForInterception(value: unknown, tokenId: string, methods: readonly string[], scopePath: string, hook: ServiceInterceptionHook): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const target = value as Record<PropertyKey, unknown>;
  const listed = new Set(methods);
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(t, prop) {
      if (cache.has(prop)) return cache.get(prop);
      const member = Reflect.get(t, prop, t);
      if (typeof member !== 'function') return member;
      let wrapped: unknown;
      if (typeof prop === 'string' && listed.has(prop)) {
        wrapped = (...args: unknown[]): Promise<unknown> => {
          const call: ServiceCall = { tokenId, method: prop, args, scopePath };
          return hook(call, (finalArgs) => {
            const result = (member as (...a: unknown[]) => unknown).apply(t, [...finalArgs]);
            if (!isThenable(result)) {
              throw new ResolutionError('di.interceptSync', `${tokenId}.${prop} is listed for interception and must return a Promise, but returned a ${typeof result}`);
            }
            return result as Promise<unknown>;
          });
        };
      } else {
        wrapped = (member as (...a: unknown[]) => unknown).bind(t);
      }
      cache.set(prop, wrapped);
      return wrapped;
    },
    set(t, prop, newValue) {
      cache.delete(prop);
      return Reflect.set(t, prop, newValue, t);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Root scope and injection functions (sections 7.2 and 7.3)
// ---------------------------------------------------------------------------------------------

export function createRootScope(options?: {
  readonly id?: string;
  readonly kind?: ScopeKind;
  readonly interception?: ServiceInterceptionHook;
  /** Longest wait for one async disposer or child scope while disposing. Default 5000. */
  readonly disposeTimeoutMs?: number;
}): Scope {
  const tree: TreeState = { interception: options?.interception, disposeTimeoutMs: options?.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS, kinds: new Map(), multiChanged: new Emitter<string>({ name: 'di.multiChanged', deferInTransaction: false }) };
  return new ScopeImpl(options?.kind ?? 'application', options?.id ?? 'root', undefined, tree);
}

export function inject<T>(token: Token<T>): T;
export function inject<T>(token: Token<T>, options: { readonly optional: true }): T | undefined;
export function inject<T>(token: Token<T>, options?: { readonly optional: true }): T | undefined {
  const scope = ScopeImpl.contextScope('inject');
  const filter = ScopeImpl.contextFilter();
  filter?.check(token.id);
  const value = options ? scope.get(token, options) : scope.get(token);
  return filter?.wrap && value !== undefined ? filter.wrap(token.id, value) : value;
}

export function injectAll<T>(token: MultiToken<T>): readonly T[] {
  const scope = ScopeImpl.contextScope('injectAll');
  ScopeImpl.contextFilter()?.check(token.id);
  return scope.getAll(token);
}

/** Captures the current scope now. Resolves on first .value. Breaks cycles. */
export function injectLazy<T>(token: Token<T>): Lazy<T> {
  const scope = ScopeImpl.contextScope('injectLazy');
  const filter = ScopeImpl.contextFilter();
  let resolved: { readonly value: T } | undefined;
  return {
    get value(): T {
      if (!resolved) {
        filter?.check(token.id);
        const value = scope.get(token);
        resolved = { value: filter?.wrap ? filter.wrap(token.id, value) : value };
      }
      return resolved.value;
    },
  };
}

/** The home scope of the current injection context. Capture it before an await. */
export function injectScope(): Scope {
  if (ScopeImpl.contextFilter()) {
    throw new ResolutionError('di.filtered', 'injectScope() is not available to filtered code (plugin code): it would give access to the whole container. Use inject() with declared tokens.');
  }
  return ScopeImpl.contextScope('injectScope');
}

/**
 * Runs fn in the current injection context (same scope, same lifetime) with a filter on inject(), injectAll() and
 * injectLazy(). Factories that fn triggers run in their own frames and are not filtered. Without a context, fn runs as it is.
 */
export function runFiltered<R>(filter: InjectionFilter, fn: () => R): R {
  if (!frame) return fn();
  const previous = frame;
  frame = { scope: previous.scope, lifetime: previous.lifetime, filter };
  try {
    return fn();
  } finally {
    frame = previous;
  }
}

export function isInInjectionContext(): boolean {
  return ScopeImpl.hasContext();
}

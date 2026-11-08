import {
  DeferredPromise,
  Emitter,
  MigrationStatus,
  TesseraError,
  getScheduler,
  isDevMode,
  migrateValue,
  reportError,
  type Event,
  type IDisposable,
  type MigrationResult,
  type StateSchema,
  type StoredValue,
} from '@tessera/base';
import type { InterceptorRegistry, Memento, StorageBackend, StorageFlushOptions, StorageFlushResult, StorageScope, StorageService } from '@tessera/contracts';
import { state, transact, type Observable, type State } from '@tessera/reactive';

export const WRITE_DEBOUNCE_MS = 500;
export const WRITE_MAX_DELAY_MS = 2000;
export const WRITE_RETRY_MS = 1000;
/** A backend write that takes longer fails with storage.writeTimeout (keys stay dirty). */
export const WRITE_TIMEOUT_MS = 10_000;
/** A value above this serialized size is quarantined with storage.tooLarge. */
export const MAX_VALUE_BYTES = 1_048_576;
/** Dev-mode warnings (storage.writeLarge): per key and per scope batch. */
export const WARN_KEY_BYTES: number = 64 * 1024;
export const WARN_SCOPE_BYTES = 1_048_576;
/**
 * Load retries before the degraded in-memory mode (back-off in ms): three attempts, two waits. With the per-attempt
 * timeout the worst case is 3 x 1000 + 250 + 500 = 3750 ms, inside the Starting budget.
 */
export const LOAD_BACKOFF_MS: readonly number[] = [250, 500];
/** A load attempt that does not settle in this time fails with storage.loadTimeout (so a hang takes the retry, then degraded, path). */
export const LOAD_TIMEOUT_MS = 1000;

export interface StorageServiceOptions {
  readonly maxValueBytes?: number;
  readonly writeTimeoutMs?: number;
  readonly loadBackoffMs?: readonly number[];
  readonly loadTimeoutMs?: number;
}

/** The plugin id of a `plugin:<id>:<key>` storage key. */
function ownerOfKey(key: string): string | undefined {
  const match = /^plugin:([^:]+):/.exec(key);
  return match?.[1];
}

const SCOPES: readonly StorageScope[] = ['application', 'project'];

interface Dirty {
  readonly set: Map<string, unknown>;
  readonly del: Set<string>;
  /** Write counter per key: every change bumps it. A write clears a key only when the counter is still the one it sent (not the value identity). */
  readonly n: Map<string, number>;
}

/** The one State of a `scope:key` that every Memento of the key shares (contracts.md 16.1: one key, one value). */
interface SharedState {
  readonly state: State<unknown>;
  readonly schema: StateSchema<unknown>;
  refs: number;
}

/** Freezes a value and everything below it (dev mode: a later mutation of a stored value throws, so dev and release store the same data). */
function deepFreeze(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
}

class MementoImpl<T> implements Memento<T> {
  readonly scope: StorageScope;
  readonly key: string;
  readonly value: Observable<T>;
  readonly #shared: SharedState;
  readonly #schema: StateSchema<T>;
  readonly #service: DefaultStorageService;
  #disposed = false;

  constructor(scope: StorageScope, key: string, schema: StateSchema<T>, service: DefaultStorageService, shared: SharedState) {
    this.scope = scope;
    this.key = key;
    this.#schema = schema;
    this.#service = service;
    this.#shared = shared;
    this.value = (shared.state as State<T>).asReadonly();
  }

  get(): T {
    return (this.#shared.state as State<T>).peek();
  }

  set(value: T): void {
    // The service writes the key and updates the one shared State in the same transaction: every Memento of the key sees it.
    transact(() => {
      this.#service.setVersioned(this.scope, this.key, value, this.#schema);
      (this.#shared.state as State<T>).set(value);
    });
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.get()));
  }

  reset(): void {
    this.#service.delete(this.scope, this.key);
    (this.#shared.state as State<T>).set(this.#schema.initial());
  }

  /** Leaves the service registry. The last handle of a key drops the shared State. The key stays in storage (deleting it is an owner decision). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#service.releaseMemento(this.scope, this.key);
  }
}

/**
 * Storage with synchronous reads from memory and write-behind batching (contracts.md section 16.1).
 * Dirty keys are written 500 ms after the last change and at most 2 s after the first.
 */
export class DefaultStorageService implements StorageService, IDisposable {
  readonly onDidChange: Event<{ readonly scope: StorageScope; readonly keys: ReadonlySet<string>; readonly external: boolean; readonly reason?: 'recovered' }>;

  readonly #backend: StorageBackend;
  readonly #interceptors: InterceptorRegistry | undefined;
  readonly #changed = new Emitter<{ readonly scope: StorageScope; readonly keys: ReadonlySet<string>; readonly external: boolean; readonly reason?: 'recovered' }>({ name: 'storage.change' });
  readonly #data: Record<StorageScope, Map<string, unknown>> = { application: new Map(), project: new Map() };
  readonly #dirty: Record<StorageScope, Dirty> = {
    application: { set: new Map(), del: new Set(), n: new Map() },
    project: { set: new Map(), del: new Set(), n: new Map() },
  };
  /** One shared State per live `scope:key`; the Mementos of the key are handles over it. */
  readonly #shared = new Map<string, SharedState>();
  /** Per scope: external reloads run one at a time, with one trailing merged run. */
  readonly #lanes: Record<StorageScope, { running: boolean; pending: Set<string> | undefined; applied: number; seq: number }> = {
    application: { running: false, pending: undefined, applied: 0, seq: 0 },
    project: { running: false, pending: undefined, applied: 0, seq: 0 },
  };
  /** The abort hook of the backend write in flight, so a final flush can give up on a hung write at once. */
  #inflight: { abort(): void } | undefined;
  /** Set by a final flush: attempts of earlier writers fail at once, so the final write is not queued behind them. */
  #finalSince = 0;
  readonly #external: IDisposable;
  readonly #ready = new DeferredPromise<void>();
  #loadStarted = false;
  #isReady = false;
  #debounce: IDisposable | undefined;
  #maxTimer: IDisposable | undefined;
  #retryTimer: IDisposable | undefined;
  #writing: Promise<unknown> = Promise.resolve();
  #disposed = false;
  readonly #maxValueBytes: number;
  readonly #writeTimeoutMs: number;
  readonly #loadBackoff: readonly number[];
  readonly #loadTimeoutMs: number;
  /** Write generation: every backend write attempt gets a higher number; a backend ignores a write older than one it applied. */
  #generation = 0;
  readonly #degraded: State<boolean> = state<boolean>(false, { name: 'storage.degraded' });
  /** Keys that cannot be written (not serializable, too large, or rejected alone). They stay in memory until set again. */
  readonly #quarantined = new Map<string, string>();
  /** Keys whose write failed in the last round and that are still dirty. */
  #stuck = new Set<string>();
  readonly #warnedLarge = new Set<string>();
  readonly #pendingBak = new Map<string, { readonly scope: StorageScope; readonly key: string; readonly raw: unknown }>();
  readonly #backedUp = new Set<string>();
  readonly degraded: Observable<boolean>;

  constructor(backend: StorageBackend, interceptors?: InterceptorRegistry, options?: StorageServiceOptions) {
    this.#backend = backend;
    this.#interceptors = interceptors;
    this.#maxValueBytes = options?.maxValueBytes ?? MAX_VALUE_BYTES;
    this.#writeTimeoutMs = options?.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
    this.#loadBackoff = options?.loadBackoffMs ?? LOAD_BACKOFF_MS;
    this.#loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.degraded = this.#degraded.asReadonly();
    this.onDidChange = this.#changed.event;
    this.#external = backend.onDidChangeExternally((e) => void this.#reloadExternal(e.scope, e.keys));
  }

  // ----- loading -------------------------------------------------------------------------------

  whenReady(): Promise<void> {
    if (!this.#loadStarted) {
      this.#loadStarted = true;
      void this.#load();
    }
    return this.#ready.promise;
  }

  async #load(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#loadScopes();
        break;
      } catch (error) {
        const wait = this.#loadBackoff[attempt];
        if (wait === undefined || this.#disposed) {
          // Final failure: an in-memory degraded mode. Nothing is written to the backend until retryLoad() succeeds.
          reportError(new TesseraError('storage.loadFailed', 'Loading the storage failed; running in memory without persistence (degraded)', { cause: error }), { source: 'persistence', target: 'load' });
          this.#degraded.set(true);
          break;
        }
        await new Promise<void>((resolve) => getScheduler().timeout(resolve, wait));
      }
    }
    this.#isReady = true;
    this.#ready.resolve();
  }

  /** Loads one scope with the per-attempt timeout: a load that never settles fails with storage.loadTimeout. */
  async #loadBounded(scope: StorageScope): Promise<Readonly<Record<string, unknown>>> {
    const expired = new DeferredPromise<never>();
    const timer = getScheduler().timeout(
      () => expired.reject(new TesseraError('storage.loadTimeout', `Loading the ${scope} storage scope took longer than ${this.#loadTimeoutMs} ms`, { details: { scope, ms: this.#loadTimeoutMs } })),
      this.#loadTimeoutMs,
    );
    expired.promise.catch(() => undefined); // a rejection after the load won is not unhandled
    try {
      return await Promise.race([this.#backend.load(scope), expired.promise]);
    } finally {
      timer.dispose();
    }
  }

  /** Loads both scopes in parallel, each bounded. The first start fills the memory (nothing is dirty yet). */
  async #loadScopes(): Promise<void> {
    const loaded = await Promise.all(SCOPES.map((scope) => this.#loadBounded(scope)));
    SCOPES.forEach((scope, index) => {
      for (const [key, value] of Object.entries(loaded[index] ?? {})) this.#data[scope].set(key, value);
    });
  }

  /**
   * Degraded mode only: tries to load the backend again. The backend wins for every key it holds: what the session wrote in memory
   * would otherwise overwrite the real stored state with defaults. The in-memory value of such a key is kept under
   * `<key>.bak.degraded`. Keys the backend does not hold stay and are written. Consumers see an external change and re-read.
   */
  async retryLoad(): Promise<boolean> {
    if (!this.#degraded.peek()) return true;
    let loaded: Array<Readonly<Record<string, unknown>>>;
    try {
      loaded = await Promise.all(SCOPES.map((scope) => this.#loadBounded(scope)));
    } catch (error) {
      reportError(new TesseraError('storage.loadFailed', 'Loading the storage failed again', { cause: error }), { source: 'persistence', target: 'load' });
      return false;
    }
    const changes: Array<{ scope: StorageScope; keys: Set<string> }> = [];
    transact(() => {
      SCOPES.forEach((scope, index) => {
        const stored = loaded[index] ?? {};
        const dirty = this.#dirty[scope];
        const changed = new Set<string>();
        for (const [key, value] of Object.entries(stored)) {
          const local = this.#data[scope].has(key) ? this.#data[scope].get(key) : undefined;
          const touched = dirty.set.has(key) || dirty.del.has(key);
          if (touched && local !== undefined && JSON.stringify(local) !== JSON.stringify(value)) {
            // keep the session's value next to the key; the backup is written with the next flush
            this.#put(scope, `${key}.bak.degraded`, local);
            changed.add(`${key}.bak.degraded`);
          }
          if (touched || JSON.stringify(local) !== JSON.stringify(value)) changed.add(key);
          dirty.set.delete(key);
          dirty.del.delete(key);
          dirty.n.delete(key);
          this.#data[scope].set(key, value);
          this.#quarantined.delete(`${scope}:${key}`);
        }
        if (changed.size > 0) changes.push({ scope, keys: changed });
      });
      for (const { scope, keys } of changes) {
        for (const key of keys) this.#syncShared(scope, key);
      }
    });
    this.#degraded.set(false);
    for (const { scope, keys } of changes) this.#changed.fire({ scope, keys, external: true, reason: 'recovered' });
    if (this.#hasDirty()) this.#markDirty();
    return true;
  }

  get isReady(): boolean {
    return this.#isReady;
  }

  #assertReady(): void {
    if (!this.#isReady) throw new TesseraError('storage.notReady', 'StorageService is not ready: await whenReady() first (phase Starting)');
  }

  // ----- raw access ----------------------------------------------------------------------------

  get(scope: StorageScope, key: string): unknown {
    this.#assertReady();
    return this.#data[scope].get(key);
  }

  set(scope: StorageScope, key: string, value: unknown): void {
    this.#assertReady();
    if (value === undefined) {
      this.delete(scope, key);
      return;
    }
    if (isDevMode()) {
      // Dev and release store the same reference. Dev checks that the value is JSON-safe and freezes it (no copy): a later mutation by the caller throws.
      try {
        if (JSON.stringify(value) === undefined) throw new TypeError('the value serializes to undefined');
      } catch (error) {
        throw new TesseraError('storage.notSerializable', `Value for "${key}" is not JSON-safe`, { cause: error, details: { key, scope } });
      }
      deepFreeze(value);
    }
    transact(() => {
      this.#put(scope, key, value);
      this.#syncShared(scope, key);
    });
    this.#changed.fire({ scope, keys: new Set([key]), external: false });
  }

  #put(scope: StorageScope, key: string, stored: unknown): void {
    this.#data[scope].set(key, stored);
    this.#quarantined.delete(`${scope}:${key}`);
    const dirty = this.#dirty[scope];
    dirty.del.delete(key);
    dirty.set.set(key, stored);
    dirty.n.set(key, (dirty.n.get(key) ?? 0) + 1);
    this.#markDirty();
  }

  /** The shared State of a live key follows the stored value (raw set, delete, external change). */
  #syncShared(scope: StorageScope, key: string): void {
    const shared = this.#shared.get(`${scope}:${key}`);
    if (shared) shared.state.set(this.getVersioned(scope, key, shared.schema).value);
  }

  delete(scope: StorageScope, key: string): void {
    this.#assertReady();
    if (!this.#data[scope].has(key) && !this.#dirty[scope].set.has(key)) return;
    this.#data[scope].delete(key);
    this.#quarantined.delete(`${scope}:${key}`);
    const dirty = this.#dirty[scope];
    dirty.set.delete(key);
    dirty.del.add(key);
    dirty.n.set(key, (dirty.n.get(key) ?? 0) + 1);
    this.#markDirty();
    transact(() => this.#syncShared(scope, key));
    this.#changed.fire({ scope, keys: new Set([key]), external: false });
  }

  keys(scope: StorageScope, prefix?: string): readonly string[] {
    this.#assertReady();
    const all = [...this.#data[scope].keys()];
    return prefix === undefined ? all : all.filter((k) => k.startsWith(prefix));
  }

  // ----- versioned values ----------------------------------------------------------------------

  getVersioned<T>(scope: StorageScope, key: string, schema: StateSchema<T>): MigrationResult<T> {
    const raw = this.get(scope, key);
    let result: MigrationResult<T>;
    try {
      result = migrateValue(raw as StoredValue | undefined, schema);
    } catch (error) {
      result = { value: schema.initial(), status: MigrationStatus.ResetInvalid, fromVersion: undefined, error };
    }
    if ((result.status === MigrationStatus.ResetNewer || result.status === MigrationStatus.ResetInvalid || result.status === MigrationStatus.ResetNoPath) && raw !== undefined) {
      // A downgrade or a broken value must not lose data: keep a copy next to the key (contracts.md 16.1 rule 5).
      // A read does not write: the copy is queued once per key and session and written in a microtask, without a change event.
      const version = (raw as { v?: unknown } | null)?.v;
      const bakKey = `${key}.bak.v${typeof version === 'number' ? version : 'invalid'}`;
      const id = `${scope}:${bakKey}`;
      if (!this.#backedUp.has(id)) {
        this.#backedUp.add(id);
        this.#pendingBak.set(id, { scope, key: bakKey, raw });
        if (this.#pendingBak.size === 1) queueMicrotask(() => this.#writeBackups());
      }
    }
    return result;
  }

  setVersioned<T>(scope: StorageScope, key: string, value: T, schema: StateSchema<T>): void {
    this.set(scope, key, { v: schema.version, data: value } satisfies StoredValue);
  }

  memento<T>(scope: StorageScope, key: string, schema: StateSchema<T>): Memento<T> {
    this.#assertReady();
    const id = `${scope}:${key}`;
    let shared = this.#shared.get(id);
    if (!shared) {
      shared = { state: state<unknown>(this.getVersioned(scope, key, schema).value, { name: `memento:${id}` }), schema: schema as StateSchema<unknown>, refs: 0 };
      this.#shared.set(id, shared);
    }
    shared.refs++;
    return new MementoImpl<T>(scope, key, schema, this, shared);
  }

  /** Called by Memento.dispose(). The last handle of a key drops the shared State. */
  releaseMemento(scope: StorageScope, key: string): void {
    const id = `${scope}:${key}`;
    const shared = this.#shared.get(id);
    if (!shared) return;
    shared.refs--;
    if (shared.refs <= 0) this.#shared.delete(id);
  }

  /** Dev report: how many Memento handles are live (a leak of mementos shows here). */
  get mementoCount(): number {
    let count = 0;
    for (const shared of this.#shared.values()) count += shared.refs;
    return count;
  }

  // ----- write-behind --------------------------------------------------------------------------

  #hasDirty(): boolean {
    return SCOPES.some((s) => this.#dirty[s].set.size > 0 || this.#dirty[s].del.size > 0);
  }

  #writeBackups(): void {
    const pending = [...this.#pendingBak.values()];
    this.#pendingBak.clear();
    if (this.#disposed || !this.#isReady) return;
    // One generation, the newest: a second downgrade replaces the copy of the first (the older copy is the less useful one).
    for (const { scope, key, raw } of pending) {
      const current = this.#data[scope].has(key) ? this.#data[scope].get(key) : undefined;
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(raw)) this.#put(scope, key, raw);
    }
  }

  #markDirty(): void {
    if (this.#disposed) return;
    const scheduler = getScheduler();
    this.#debounce?.dispose();
    this.#debounce = scheduler.timeout(() => void this.#flushNow(), WRITE_DEBOUNCE_MS);
    this.#maxTimer ??= scheduler.timeout(() => void this.#flushNow(), WRITE_MAX_DELAY_MS);
  }

  #clearTimers(): void {
    this.#debounce?.dispose();
    this.#maxTimer?.dispose();
    this.#debounce = undefined;
    this.#maxTimer = undefined;
  }

  flush(options?: StorageFlushOptions): Promise<StorageFlushResult> {
    return options?.final === true ? this.#flushFinal(options.deadline) : this.#flushNow();
  }

  #flushResult(): StorageFlushResult {
    const failed = new Set([...this.#stuck, ...this.#quarantined.keys()]);
    // Degraded mode writes nothing: every dirty key is a key that is not on the backend.
    if (this.#degraded.peek()) for (const scope of SCOPES) for (const key of [...this.#dirty[scope].set.keys(), ...this.#dirty[scope].del]) failed.add(`${scope}:${key}`);
    return { failedKeys: [...failed] };
  }

  async #flushNow(): Promise<StorageFlushResult> {
    this.#clearTimers();
    if (this.#pendingBak.size > 0) this.#writeBackups();
    // Serialize writes: a flush waits for the write in flight, then writes what is dirty now.
    const run = this.#writing.then(() => this.#writeDirty());
    this.#writing = run.catch(() => undefined);
    await run;
    return this.#flushResult();
  }

  /**
   * The final flush (shutdown): does not queue behind a hung write. The attempt in flight is aborted and counts as failed, earlier
   * writers fail at once from now on, and the dirty set is written with what is left of the deadline.
   */
  async #flushFinal(deadline: number | undefined): Promise<StorageFlushResult> {
    this.#clearTimers();
    this.#retryTimer?.dispose();
    this.#retryTimer = undefined;
    if (this.#pendingBak.size > 0) this.#writeBackups();
    const mine = ++this.#finalSince;
    this.#inflight?.abort();
    // The aborted writer ends quickly (its remaining attempts fail at once); the final writer follows it.
    const run = this.#writing.then(() => this.#writeDirty({ finalId: mine, ...(deadline !== undefined ? { deadline } : {}) }));
    this.#writing = run.catch(() => undefined);
    await run;
    return this.#flushResult();
  }

  /** Serializes one value at write time. Returns the problem, or undefined when the value can be written. */
  #check(scope: StorageScope, key: string, value: unknown): TesseraError | undefined {
    let size: number;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError('the value serializes to undefined');
      size = json.length;
    } catch (error) {
      return new TesseraError('storage.notSerializable', `Value for "${key}" is not JSON-safe; the key is kept in memory and not written`, { cause: error, details: { key, scope } });
    }
    if (size > this.#maxValueBytes) {
      return new TesseraError('storage.tooLarge', `Value for "${key}" is ${size} bytes, above the ${this.#maxValueBytes} byte limit; the key is kept in memory and not written`, { details: { key, scope, size, limit: this.#maxValueBytes } });
    }
    if (isDevMode() && size > WARN_KEY_BYTES && !this.#warnedLarge.has(`${scope}:${key}`)) {
      this.#warnedLarge.add(`${scope}:${key}`);
      const pluginId = ownerOfKey(key);
      reportError(new TesseraError('storage.writeLarge', `Value for "${key}" is ${size} bytes (warning above ${WARN_KEY_BYTES})`, { details: { key, scope, size } }), { source: 'persistence', target: `write:${scope}`, ...(pluginId ? { pluginId } : {}) });
    }
    return undefined;
  }

  #quarantine(scope: StorageScope, key: string, error: TesseraError): void {
    this.#quarantined.set(`${scope}:${key}`, error.code);
    const dirty = this.#dirty[scope];
    dirty.set.delete(key);
    dirty.n.delete(key);
    const pluginId = ownerOfKey(key);
    reportError(error, { source: 'persistence', target: `write:${scope}`, ...(pluginId ? { pluginId } : {}), details: { key, scope } });
  }

  async #writeDirty(final?: { readonly finalId: number; readonly deadline?: number }): Promise<void> {
    this.#retryTimer?.dispose();
    this.#retryTimer = undefined;
    this.#stuck = new Set();
    if (this.#degraded.peek()) return; // nothing is written in degraded mode
    for (const scope of SCOPES) {
      const dirty = this.#dirty[scope];
      if (dirty.set.size === 0 && dirty.del.size === 0) continue;
      // Serialize every dirty key now, one by one: a bad key leaves the batch alone (quarantine).
      let scopeBytes = 0;
      for (const [key, value] of [...dirty.set]) {
        const problem = this.#check(scope, key, value);
        if (problem) this.#quarantine(scope, key, problem);
        else if (isDevMode()) scopeBytes += JSON.stringify(value).length;
      }
      if (scopeBytes > WARN_SCOPE_BYTES && !this.#warnedLarge.has(`${scope}:*`)) {
        this.#warnedLarge.add(`${scope}:*`);
        reportError(new TesseraError('storage.writeLarge', `The ${scope} batch is ${scopeBytes} bytes (warning above ${WARN_SCOPE_BYTES})`, { details: { scope, size: scopeBytes } }), { source: 'persistence', target: `write:${scope}` });
      }
      if (dirty.set.size === 0 && dirty.del.size === 0) continue;
      // The batch is the dirty set at this moment; later changes make new dirty entries.
      const sentSet = new Map(dirty.set);
      const sentDel = new Set(dirty.del);
      const sentN = new Map(dirty.n);
      const clearSent = (keys: Iterable<string>): void => {
        for (const key of keys) {
          // The counter, not the value identity, says whether the key changed while the write was in flight (a re-set of the same object counts).
          if (dirty.n.get(key) !== sentN.get(key)) continue;
          if (sentSet.has(key)) dirty.set.delete(key);
          if (sentDel.has(key)) dirty.del.delete(key);
          dirty.n.delete(key);
        }
      };
      const batch = { set: Object.fromEntries(sentSet), delete: [...sentDel] };
      const keys = [...sentSet.keys(), ...sentDel];
      let outcome = await this.#attempt(scope, batch, keys, final);
      if (outcome.ok) {
        clearSent(keys);
        continue;
      }
      if (outcome.timeout) {
        this.#failed(scope, keys, outcome.error);
        continue;
      }
      // One immediate retry of the whole batch, then split it per key. The retry is bounded.
      outcome = await this.#attempt(scope, batch, keys, final);
      if (outcome.ok) {
        clearSent(keys);
        continue;
      }
      if (outcome.timeout || keys.length <= 1) {
        this.#failed(scope, keys, outcome.error);
        continue;
      }
      const okKeys: string[] = [];
      const failedSets: Array<[string, unknown]> = [];
      for (const [key, value] of sentSet) {
        const single = await this.#attempt(scope, { set: { [key]: value }, delete: [] }, [key], final);
        if (single.ok) okKeys.push(key);
        else failedSets.push([key, single.error]);
      }
      if (sentDel.size > 0) {
        const deletes = await this.#attempt(scope, { set: {}, delete: [...sentDel] }, [...sentDel], final);
        if (deletes.ok) okKeys.push(...sentDel);
        else this.#failed(scope, [...sentDel], deletes.error);
      }
      clearSent(okKeys);
      if (okKeys.length === 0 && failedSets.length > 0) {
        // Nothing went through: the backend is down, not one bad key. Keep everything dirty and retry later.
        this.#failed(scope, keys, failedSets[0]?.[1]);
        continue;
      }
      for (const [key, error] of failedSets) {
        this.#quarantine(scope, key, new TesseraError('storage.writeFailed', `The backend rejected key "${key}" on its own; the key is kept in memory and not written`, { cause: error, details: { key, scope } }));
      }
    }
    this.#maxTimer?.dispose();
    this.#maxTimer = undefined;
    if (this.#hasDirty() && this.#debounce === undefined && this.#retryTimer === undefined && this.#stuck.size === 0) this.#markDirty();
  }

  #failed(scope: StorageScope, keys: readonly string[], error: unknown): void {
    for (const key of keys) this.#stuck.add(`${scope}:${key}`);
    const wrapped = error instanceof TesseraError && error.code === 'storage.writeTimeout' ? error : new TesseraError('storage.writeFailed', `Writing the ${scope} storage scope failed; the keys stay dirty`, { cause: error, details: { scope, keys } });
    reportError(wrapped, { source: 'persistence', target: `write:${scope}` });
    // Retried once after 1 s, then on the next flush.
    this.#scheduleRetry();
  }

  /**
   * One backend write, raced against the write timeout. A timeout aborts the signal and counts as a failure. A final flush
   * aborts the attempt in flight at once; a writer that is not the final one fails at once while a final flush runs.
   */
  async #attempt(scope: StorageScope, batch: { set: Record<string, unknown>; delete: string[] }, keys: string[], final?: { readonly finalId: number; readonly deadline?: number }): Promise<{ ok: true } | { ok: false; timeout: boolean; error: unknown }> {
    if (!final && this.#finalSince > 0) return { ok: false, timeout: true, error: new TesseraError('storage.writeTimeout', `Writing the ${scope} storage scope was abandoned by the final flush`, { details: { scope, keys } }) };
    const abort = new AbortController();
    const expired = new DeferredPromise<'timeout' | 'abandoned'>();
    const scheduler = getScheduler();
    const limit = final?.deadline === undefined ? this.#writeTimeoutMs : Math.max(0, Math.min(this.#writeTimeoutMs, final.deadline - scheduler.now()));
    const timer = scheduler.timeout(() => expired.resolve('timeout'), limit);
    const handle = { abort: () => expired.resolve('abandoned') };
    if (!final) this.#inflight = handle;
    const generation = ++this.#generation; // a late write of an abandoned attempt carries an older number and is ignored by the backend
    try {
      const outcome = await Promise.race([this.#writeThroughInterceptors(scope, batch, keys, abort.signal, generation).then(() => 'ok' as const), expired.promise]);
      if (outcome === 'timeout' || outcome === 'abandoned') {
        abort.abort();
        const why = outcome === 'abandoned' ? 'was abandoned by the final flush' : `took longer than ${limit} ms`;
        return { ok: false, timeout: true, error: new TesseraError('storage.writeTimeout', `Writing the ${scope} storage scope ${why}; the keys stay dirty`, { details: { scope, keys, ms: limit } }) };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, timeout: false, error };
    } finally {
      timer.dispose();
      if (this.#inflight === handle) this.#inflight = undefined;
    }
  }

  #retryCount = 0;
  #scheduleRetry(): void {
    if (this.#retryCount >= 1 || this.#disposed) {
      this.#retryCount = 0;
      return;
    }
    this.#retryCount++;
    this.#retryTimer = getScheduler().timeout(() => {
      this.#retryTimer = undefined;
      const run = this.#writing.then(() => this.#writeDirty());
      this.#writing = run.catch(() => undefined);
      void run.finally(() => {
        if (!this.#hasDirty()) this.#retryCount = 0;
      });
    }, WRITE_RETRY_MS);
  }

  async #writeThroughInterceptors(scope: StorageScope, batch: { set: Record<string, unknown>; delete: string[] }, keys: string[], signal: AbortSignal, generation: number): Promise<void> {
    const interceptors = this.#interceptors;
    if (!interceptors) {
      await this.#backend.write(scope, batch, { signal, generation });
      return;
    }
    const ctx = interceptors.createContext('persistence', `write:${scope}`, { op: 'write', storageScope: scope, keys }, { source: 'storage' });
    await interceptors.run(ctx, async () => this.#backend.write(scope, batch, { signal, generation }));
  }

  // ----- external changes ----------------------------------------------------------------------

  /**
   * Serialized per scope: one reload in flight and one trailing run that merges the keys of every event that came meanwhile. A result
   * older than the last one applied is dropped. With `backend.read` only the changed keys are read; without it the scope is loaded whole.
   */
  #reloadExternal(scope: StorageScope, keys: readonly string[]): void {
    if (this.#disposed || !this.#isReady) return;
    const lane = this.#lanes[scope];
    lane.pending ??= new Set();
    for (const key of keys) lane.pending.add(key);
    if (lane.running) return;
    lane.running = true;
    void (async () => {
      try {
        while (lane.pending && !this.#disposed) {
          const batch = [...lane.pending];
          lane.pending = undefined;
          await this.#reloadOnce(scope, batch, ++lane.seq, lane);
        }
      } finally {
        lane.running = false;
      }
    })();
  }

  async #reloadOnce(scope: StorageScope, keys: readonly string[], seq: number, lane: { applied: number }): Promise<void> {
    try {
      const loaded = this.#backend.read ? await this.#readBounded(scope, keys) : await this.#loadBounded(scope);
      if (seq < lane.applied || this.#disposed) return; // an older read must not overwrite a newer one
      lane.applied = seq;
      const changed = new Set<string>();
      transact(() => {
        for (const key of keys) {
          if (this.#dirty[scope].set.has(key) || this.#dirty[scope].del.has(key)) continue; // our own pending write wins
          if (key in loaded) this.#data[scope].set(key, loaded[key]);
          else this.#data[scope].delete(key);
          changed.add(key);
          this.#syncShared(scope, key);
        }
      });
      if (changed.size > 0) this.#changed.fire({ scope, keys: changed, external: true });
    } catch (error) {
      reportError(error, { source: 'persistence', target: `reload:${scope}` });
    }
  }

  /** Reads some keys with the load timeout. Only called when the backend has read(). */
  async #readBounded(scope: StorageScope, keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    const expired = new DeferredPromise<never>();
    const timer = getScheduler().timeout(() => expired.reject(new TesseraError('storage.loadTimeout', `Reading keys of the ${scope} storage scope took longer than ${this.#loadTimeoutMs} ms`, { details: { scope, ms: this.#loadTimeoutMs } })), this.#loadTimeoutMs);
    expired.promise.catch(() => undefined);
    try {
      return await Promise.race([(this.#backend.read as NonNullable<StorageBackend['read']>)(scope, keys), expired.promise]);
    } finally {
      timer.dispose();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
    this.#retryTimer?.dispose();
    this.#external.dispose();
    this.#changed.dispose();
    this.#shared.clear();
  }
}

import type { Event, MigrationResult, StateSchema } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';

/** 'project': the project opened in this window. Changing project reloads the window. */
export type StorageScope = 'application' | 'project';

export interface StorageBatch {
  readonly set: Readonly<Record<string, unknown>>;
  readonly delete: readonly string[];
}

/** Port. Electron: an RPC proxy to the main process, which writes files atomically. */
export interface StorageBackend {
  /** Every key of the scope. An empty object if nothing is stored. */
  load(scope: StorageScope): Promise<Readonly<Record<string, unknown>>>;
  /**
   * Atomic per call: the whole batch or nothing. The service aborts `signal` when the write exceeds its timeout
   * (10 s) and treats that as a failure. `generation` grows with every attempt of the service: a backend ignores a write whose
   * generation is lower than one it already applied for the scope (a late write of an abandoned attempt cannot overwrite newer data),
   * and it does not apply a write whose `signal` is already aborted.
   */
  write(scope: StorageScope, batch: StorageBatch, options?: { readonly signal?: AbortSignal; readonly generation?: number }): Promise<void>;
  /**
   * Optional. Reads only some keys of a scope (an external change names the keys; the service does not reload the whole scope).
   * A key the backend does not hold is absent from the result. Over RPC: `tessera.main.storage.read`.
   */
  read?(scope: StorageScope, keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  /** Keys written by another window. */
  readonly onDidChangeExternally: Event<{ readonly scope: StorageScope; readonly keys: readonly string[] }>;
}
export const StorageBackend: Token<StorageBackend> = token<StorageBackend>('tessera.storageBackend');

export interface Memento<T> {
  readonly scope: StorageScope;
  readonly key: string;
  /** Updates on set() and on external changes. */
  readonly value: Observable<T>;
  get(): T;
  set(value: T): void;
  update(fn: (current: T) => T): void;
  /** Stops the service from tracking this Memento (no more refresh on external changes). The stored key stays. */
  dispose(): void;
  /** Deletes the key. value becomes schema.initial(). */
  reset(): void;
}

/** Options of `StorageService.flush`. */
export interface StorageFlushOptions {
  /**
   * Shutdown mode: aborts the write in flight (a hung backend must not hold the quit) and writes the dirty set with what is left of
   * `deadline` (scheduler time in ms).
   */
  readonly final?: boolean;
  readonly deadline?: number;
}

/** What flush() reports: the keys that could not be written (quarantined or still dirty after a failure). */
export interface StorageFlushResult {
  /** `<scope>:<key>` of every key that is not on the backend because its write failed. */
  readonly failedKeys: readonly string[];
}

export interface StorageService {
  /** Both scopes loaded. */
  whenReady(): Promise<void>;
  /** True after whenReady() resolved (also in degraded mode). */
  readonly isReady: boolean;
  /** Raw JSON-safe value. Throws 'storage.notReady' before whenReady resolves. */
  get(scope: StorageScope, key: string): unknown;
  /** Reads a StoredValue envelope, migrates and validates. Never throws. */
  getVersioned<T>(scope: StorageScope, key: string, schema: StateSchema<T>): MigrationResult<T>;
  set(scope: StorageScope, key: string, value: unknown): void;
  /** Writes a StoredValue envelope { v: schema.version, data: value }. */
  setVersioned<T>(scope: StorageScope, key: string, value: T, schema: StateSchema<T>): void;
  delete(scope: StorageScope, key: string): void;
  keys(scope: StorageScope, prefix?: string): readonly string[];
  memento<T>(scope: StorageScope, key: string, schema: StateSchema<T>): Memento<T>;
  /**
   * Writes pending changes now. Registered as the WillShutdown join 'storage.flush'. Never rejects for a failed key:
   * the keys come back in `failedKeys` (a non-serializable or too large value, a key that the backend rejects).
   */
  flush(options?: StorageFlushOptions): Promise<StorageFlushResult>;
  /** True while the load failed and storage runs in memory only (nothing is written). Context key `storage.degraded`. */
  readonly degraded: Observable<boolean>;
  /** Degraded mode: tries the load again. On success the in-memory changes are written. */
  retryLoad(): Promise<boolean>;
  /** `reason: 'recovered'` marks the change set that retryLoad() brought in after degraded mode: the stored state replaced the session's. */
  readonly onDidChange: Event<{ readonly scope: StorageScope; readonly keys: ReadonlySet<string>; readonly external: boolean; readonly reason?: 'recovered' }>;
}
export const StorageService: Token<StorageService> = token<StorageService>('tessera.storage');

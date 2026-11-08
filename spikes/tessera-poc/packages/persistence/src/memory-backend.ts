import { Emitter, type IDisposable } from '@tessera/base';
import type { StorageBackend, StorageBatch, StorageScope } from '@tessera/contracts';

export interface MemoryStorageBackend extends StorageBackend, IDisposable {
  /** Every write() call, in order. */
  readonly writes: ReadonlyArray<{ readonly scope: StorageScope; readonly set: Readonly<Record<string, unknown>>; readonly delete: readonly string[] }>;
  /** Current content of a scope (a copy). */
  snapshot(scope: StorageScope): Readonly<Record<string, unknown>>;
  /** Simulates another window writing keys: changes the data and fires onDidChangeExternally. */
  writeExternally(scope: StorageScope, batch: StorageBatch): void;
  /** Makes the next n write() calls reject (tests of the retry rule). */
  failNextWrites(count: number): void;
}

/** The most write records the backend keeps for tests. Older ones are dropped (a long bench must not measure this log). */
export const MAX_RECORDED_WRITES = 1000;

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * A StorageBackend in memory. Values pass a JSON round trip, like the file backend of the product, so a test
 * cannot rely on object identity. Atomic per write(): the batch is applied whole or not at all.
 */
export function memoryStorageBackend(
  initial?: { readonly application?: Record<string, unknown>; readonly project?: Record<string, unknown> },
  backendOptions?: { /** Default true. false: `writes` stays empty (a heap bench, where the log would be the leak). */ readonly retainHistory?: boolean },
): MemoryStorageBackend {
  const data: Record<StorageScope, Record<string, unknown>> = {
    application: clone({ ...initial?.application }),
    project: clone({ ...initial?.project }),
  };
  const writes: Array<{ scope: StorageScope; set: Readonly<Record<string, unknown>>; delete: readonly string[] }> = [];
  const external = new Emitter<{ readonly scope: StorageScope; readonly keys: readonly string[] }>({ name: 'memoryStorage.external', deferInTransaction: false });
  let failures = 0;
  /** The highest write generation applied per scope. A write with a lower one is a late write of an abandoned attempt: ignored. */
  const applied: Record<StorageScope, number> = { application: 0, project: 0 };

  const apply = (scope: StorageScope, batch: StorageBatch): void => {
    const next = { ...data[scope] };
    for (const [key, value] of Object.entries(batch.set)) next[key] = clone(value);
    for (const key of batch.delete) delete next[key];
    data[scope] = next;
  };

  return {
    writes,
    async load(scope) {
      return clone(data[scope]);
    },
    async write(scope, batch, options) {
      if (failures > 0) {
        failures--;
        throw new Error('memoryStorageBackend: simulated write failure');
      }
      if (options?.signal?.aborted) return; // the service gave up on this write
      if (options?.generation !== undefined) {
        if (options.generation < applied[scope]) return;
        applied[scope] = options.generation;
      }
      if (backendOptions?.retainHistory !== false) {
        writes.push({ scope, set: clone(batch.set), delete: [...batch.delete] });
        if (writes.length > MAX_RECORDED_WRITES) writes.splice(0, writes.length - MAX_RECORDED_WRITES);
      }
      apply(scope, batch);
    },
    onDidChangeExternally: external.event,
    snapshot: (scope) => clone(data[scope]),
    writeExternally(scope, batch) {
      apply(scope, batch);
      external.fire({ scope, keys: [...Object.keys(batch.set), ...batch.delete] });
    },
    failNextWrites(count) {
      failures = count;
    },
    dispose() {
      external.dispose();
    },
  };
}

import { Emitter, TesseraError, reportError, type IDisposable } from '@tessera/base';
import type { StorageBackend, StorageBatch, StorageScope } from '@tessera/contracts';

export interface LocalStorageBackendOptions {
  /** Default: window.localStorage. */
  readonly storage?: Storage;
  /** The window that receives `storage` events from other tabs. Default: the global window. */
  readonly view?: Window;
  /** Key prefix. Default 'tessera'. */
  readonly prefix?: string;
  /** The project of 'project' scope. Default ''. */
  readonly projectId?: string;
}

export interface LocalStorageBackend extends StorageBackend, IDisposable {
  /** The localStorage key of one stored key. For tests and the demo's "reset" button. */
  keyOf(scope: StorageScope, key: string): string;
  /** Removes every key of this backend (both scopes) from the storage. */
  clearAll(): void;
}

/**
 * A StorageBackend over localStorage (the web host of the POC). One localStorage item per key, as JSON, under
 * `<prefix>/<scope>/<key>`. A project scope adds the project id. A write is atomic per call: when an item cannot be written
 * (quota), the items already written by that call are put back. Another tab's writes arrive as `storage` events.
 */
export function localStorageBackend(options: LocalStorageBackendOptions = {}): LocalStorageBackend {
  const storage = options.storage ?? globalThis.localStorage;
  const view = options.view ?? (globalThis as { window?: Window }).window;
  const prefix = options.prefix ?? 'tessera';
  const projectId = options.projectId ?? '';
  const scopePrefix = (scope: StorageScope): string => (scope === 'application' ? `${prefix}/application/` : `${prefix}/project/${projectId}/`);
  const external = new Emitter<{ readonly scope: StorageScope; readonly keys: readonly string[] }>({ name: 'localStorage.external', deferInTransaction: false });
  /** The highest write generation applied per scope: a late write of an abandoned attempt is ignored. */
  const applied: Record<StorageScope, number> = { application: 0, project: 0 };

  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== storage) return;
    if (event.key === null) return; // clear(): there is no key to name
    for (const scope of ['application', 'project'] as const) {
      const p = scopePrefix(scope);
      if (event.key.startsWith(p)) external.fire({ scope, keys: [event.key.slice(p.length)] });
    }
  };
  view?.addEventListener('storage', onStorage);

  return {
    keyOf: (scope, key) => `${scopePrefix(scope)}${key}`,
    async load(scope) {
      const p = scopePrefix(scope);
      const out: Record<string, unknown> = {};
      const names: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const full = storage.key(i);
        if (full !== null && full.startsWith(p)) names.push(full);
      }
      for (const full of names) {
        const raw = storage.getItem(full);
        if (raw === null) continue;
        try {
          out[full.slice(p.length)] = JSON.parse(raw) as unknown;
        } catch (cause) {
          // A damaged item is skipped (the StorageService treats the key as missing and will overwrite it), but its text is kept
          // under `<key>.corrupt` (as a JSON string) and the damage is reported, so a user can recover it.
          const key = full.slice(p.length);
          try {
            storage.setItem(`${full}.corrupt`, JSON.stringify(raw));
            out[`${key}.corrupt`] = raw;
          } catch {
            // no room for the copy: the report below still tells
          }
          reportError(new TesseraError('storage.itemCorrupt', `The stored item "${key}" is not valid JSON; it is ignored and its text is kept under "${key}.corrupt"`, { cause, details: { key, scope } }), {
            source: 'persistence',
            target: `load:${scope}`,
          });
        }
      }
      return out;
    },
    async write(scope: StorageScope, batch: StorageBatch, writeOptions?: { readonly signal?: AbortSignal; readonly generation?: number }) {
      if (writeOptions?.signal?.aborted) return; // the service gave up on this write
      if (writeOptions?.generation !== undefined) {
        if (writeOptions.generation < applied[scope]) return;
        applied[scope] = writeOptions.generation;
      }
      const p = scopePrefix(scope);
      const undo: Array<() => void> = [];
      try {
        for (const [key, value] of Object.entries(batch.set)) {
          const full = `${p}${key}`;
          const before = storage.getItem(full);
          storage.setItem(full, JSON.stringify(value));
          undo.push(() => (before === null ? storage.removeItem(full) : storage.setItem(full, before)));
        }
        for (const key of batch.delete) {
          const full = `${p}${key}`;
          const before = storage.getItem(full);
          storage.removeItem(full);
          undo.push(() => (before === null ? undefined : storage.setItem(full, before)));
        }
      } catch (error) {
        for (const revert of undo.reverse()) {
          try {
            revert();
          } catch {
            // best effort
          }
        }
        throw error;
      }
    },
    onDidChangeExternally: external.event,
    clearAll() {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(`${prefix}/`)) doomed.push(key);
      }
      for (const key of doomed) storage.removeItem(key);
    },
    dispose() {
      view?.removeEventListener('storage', onStorage);
      external.dispose();
    },
  };
}

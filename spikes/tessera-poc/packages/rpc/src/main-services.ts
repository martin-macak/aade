import { Emitter, TesseraError, reportError, type Event } from '@tessera/base';
import { defineRpcInterface, type PluginCatalog, type PluginDescription, type Remote, type RpcInterface, type StorageBackend, type StorageBatch, type StorageScope } from '@tessera/contracts';
import { z } from 'zod';
import { DEFAULT_MAX_FRAME_BYTES, sizeOf } from './connection.ts';

// The RPC interfaces of two main-process services (contracts.md 17.3). The main process is not built in the POC: these are the interface
// contracts, the main-side pagers, the renderer-side adapters that hide the paging, and an in-memory main stub for the tests.
// Bulk replies never ride in one frame: StorageBackend.load and PluginCatalog.list keep their shape (a Promise of everything), and the
// adapters assemble the pages. A page is packed to half the frame cap.

const any = z.unknown();
const scope = z.enum(['application', 'project']);
const cursor = z.string().optional();

export interface StoragePage {
  readonly entries: Readonly<Record<string, unknown>>;
  /** Absent on the last page. */
  readonly next?: string;
  /** Keys whose single entry is larger than a frame can carry: skipped by the main side, reported once. */
  readonly quarantined?: readonly string[];
}
export interface PluginPage {
  readonly items: readonly PluginDescription[];
  readonly next?: string;
  readonly quarantined?: readonly string[];
}

export interface MainStorageRpc {
  loadPage(scope: StorageScope, cursor?: string): Promise<StoragePage>;
  read(scope: StorageScope, keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  write(scope: StorageScope, batch: StorageBatch, generation?: number): Promise<void>;
  readonly onDidChangeExternally: Event<{ readonly scope: StorageScope; readonly keys: readonly string[] }>;
}
export const mainStorageInterface: RpcInterface<MainStorageRpc> = defineRpcInterface<MainStorageRpc>('tessera.main.storage', 1, {
  methods: {
    loadPage: { args: z.tuple([scope, cursor]) as never, result: any as never },
    read: { args: z.tuple([scope, z.array(z.string())]) as never, result: any as never },
    write: { args: z.tuple([scope, z.object({ set: z.record(z.string(), z.unknown()), delete: z.array(z.string()) }), z.number().optional()]) as never, result: any as never },
  },
  events: { onDidChangeExternally: any as never },
});

export interface MainPluginsRpc {
  listPage(cursor?: string): Promise<PluginPage>;
  readonly onDidChange: Event<void>;
}
export const mainPluginsInterface: RpcInterface<MainPluginsRpc> = defineRpcInterface<MainPluginsRpc>('tessera.main.plugins', 1, {
  methods: { listPage: { args: z.tuple([cursor]) as never, result: any as never } },
  events: { onDidChange: any as never },
});

export interface PagerOptions {
  /** The frame cap of the connection. Default 1 MB. Pages are packed to half of it. */
  readonly maxFrameBytes?: number;
}

/**
 * Packs `items` (in the given order) into pages of at most half the frame cap. A single item above the page budget but below the
 * frame cap travels alone; an item that no frame can carry is quarantined (skipped, named). The cursor is the index of the next item.
 */
export function packPage<T>(items: ReadonlyArray<readonly [string, T]>, from: number, options?: PagerOptions): { readonly page: Array<readonly [string, T]>; readonly next: number | undefined; readonly quarantined: string[] } {
  const cap = options?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const budget = Math.floor(cap / 2);
  const page: Array<readonly [string, T]> = [];
  const quarantined: string[] = [];
  let used = 0;
  let index = from;
  for (; index < items.length; index++) {
    const item = items[index] as readonly [string, T];
    const size = sizeOf(item, cap);
    if (size > Math.floor(cap * 0.9)) {
      quarantined.push(item[0]);
      continue;
    }
    if (page.length > 0 && used + size > budget) break;
    page.push(item);
    used += size;
  }
  return { page, next: index < items.length ? index : undefined, quarantined };
}

/** The main-side implementation of the paged storage reads, over a StorageBackend. Used by the main process (and by the tests as the stub). */
export function createMainStorageService(backend: StorageBackend, options?: PagerOptions): MainStorageRpc {
  const emitter = new Emitter<{ readonly scope: StorageScope; readonly keys: readonly string[] }>({ name: 'mainStorage.external', deferInTransaction: false });
  backend.onDidChangeExternally((e) => emitter.fire(e));
  const reported = new Set<string>();
  return {
    async loadPage(scopeId, cursorValue) {
      const all = Object.entries(await backend.load(scopeId)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const { page, next, quarantined } = packPage(all, cursorValue === undefined ? 0 : Number(cursorValue), options);
      for (const key of quarantined) {
        if (!reported.has(`${scopeId}:${key}`)) {
          reported.add(`${scopeId}:${key}`);
          reportError(new TesseraError('storage.tooLarge', `Key "${key}" of the ${scopeId} scope is larger than a frame can carry; it is skipped on load`, { details: { key, scope: scopeId } }), { source: 'persistence', target: `loadPage:${scopeId}` });
        }
      }
      return { entries: Object.fromEntries(page), ...(next !== undefined ? { next: String(next) } : {}), ...(quarantined.length > 0 ? { quarantined } : {}) };
    },
    async read(scopeId, keys) {
      if (backend.read) return backend.read(scopeId, keys);
      const all = await backend.load(scopeId);
      return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
    },
    write: (scopeId, batch, generation) => backend.write(scopeId, batch, generation === undefined ? undefined : { generation }),
    onDidChangeExternally: emitter.event,
  };
}

/** The main-side implementation of the paged catalog read. */
export function createMainPluginsService(catalog: PluginCatalog, options?: PagerOptions): MainPluginsRpc {
  return {
    async listPage(cursorValue) {
      const all = (await catalog.list()).map((d, i) => [`${(d.manifest as { id?: string }).id ?? '?'}#${i}`, d] as const);
      const { page, next, quarantined } = packPage(all, cursorValue === undefined ? 0 : Number(cursorValue), options);
      return { items: page.map(([, d]) => d), ...(next !== undefined ? { next: String(next) } : {}), ...(quarantined.length > 0 ? { quarantined } : {}) };
    },
    onDidChange: catalog.onDidChange,
  };
}

/** The renderer-side StorageBackend over the RPC proxy: `load` loops over the pages and returns everything, so the port contract is unchanged. */
export function remoteStorageBackend(remote: Remote<MainStorageRpc>): StorageBackend {
  return {
    async load(scopeId) {
      const result: Record<string, unknown> = {};
      let next: string | undefined;
      do {
        const page = await remote.loadPage(scopeId, next);
        Object.assign(result, page.entries);
        next = page.next;
      } while (next !== undefined);
      return result;
    },
    write: (scopeId, batch, options) => remote.write(scopeId, batch, options?.generation),
    read: (scopeId, keys) => remote.read(scopeId, keys),
    onDidChangeExternally: remote.onDidChangeExternally,
  };
}

/** The renderer-side PluginCatalog over the RPC proxy: `list` loops over the pages. */
export function remotePluginCatalog(remote: Remote<MainPluginsRpc>): PluginCatalog {
  return {
    async list() {
      const result: PluginDescription[] = [];
      let next: string | undefined;
      do {
        const page = await remote.listPage(next);
        result.push(...page.items);
        next = page.next;
      } while (next !== undefined);
      return result;
    },
    onDidChange: remote.onDidChange,
  };
}

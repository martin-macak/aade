import { afterEach, describe, expect, it } from 'vitest';
import type { IDisposable } from '@tessera/base';
import type { StorageBackend, StorageScope } from '@tessera/contracts';

export interface StorageBackendHarness {
  readonly backend: StorageBackend;
  /** Simulates another window writing: the backend data changes and onDidChangeExternally fires. */
  writeExternally?(scope: StorageScope, batch: { readonly set: Record<string, unknown>; readonly delete: readonly string[] }): void;
  dispose?(): void;
}

/**
 * Conformance suite for the StorageBackend port (contracts.md 16.1). Run it against every implementation:
 * memory, localStorage, file. Test names start with C22 because the persistence claim depends on it.
 */
export function storageBackendConformance(name: string, create: () => StorageBackendHarness | Promise<StorageBackendHarness>): void {
  describe(`C22: StorageBackend conformance: ${name}`, () => {
    const live: StorageBackendHarness[] = [];
    afterEach(() => {
      for (const h of live.splice(0)) h.dispose?.();
    });
    const make = async (): Promise<StorageBackendHarness> => {
      const harness = await create();
      live.push(harness);
      return harness;
    };

    it('C22: load returns an empty object for a scope with nothing stored', async () => {
      const { backend } = await make();
      expect(await backend.load('application')).toEqual({});
      expect(await backend.load('project')).toEqual({});
    });

    it('C22: write stores sets and applies deletes in one batch', async () => {
      const { backend } = await make();
      await backend.write('application', { set: { a: 1, b: { x: [1, 2] }, c: 'gone' }, delete: [] });
      await backend.write('application', { set: { a: 2 }, delete: ['c'] });
      expect(await backend.load('application')).toEqual({ a: 2, b: { x: [1, 2] } });
    });

    it('C22: scopes are independent', async () => {
      const { backend } = await make();
      await backend.write('application', { set: { k: 'app' }, delete: [] });
      await backend.write('project', { set: { k: 'proj' }, delete: [] });
      expect(await backend.load('application')).toEqual({ k: 'app' });
      expect(await backend.load('project')).toEqual({ k: 'proj' });
    });

    it('C22: stored values are copies: changing the written object later does not change the store', async () => {
      const { backend } = await make();
      const value = { list: [1] };
      await backend.write('project', { set: { v: value }, delete: [] });
      value.list.push(2);
      expect(await backend.load('project')).toEqual({ v: { list: [1] } });
    });

    it('C22: a loaded object is a copy too', async () => {
      const { backend } = await make();
      await backend.write('project', { set: { v: { n: 1 } }, delete: [] });
      const first = (await backend.load('project'))['v'] as { n: number };
      first.n = 99;
      expect(await backend.load('project')).toEqual({ v: { n: 1 } });
    });

    it('C22: a key that is set and deleted in different batches ends up deleted', async () => {
      const { backend } = await make();
      await backend.write('application', { set: { k: 1 }, delete: [] });
      await backend.write('application', { set: {}, delete: ['k'] });
      expect(await backend.load('application')).toEqual({});
    });

    it('C22: a write with a lower generation than one already applied is ignored (a late write of an abandoned attempt)', async () => {
      const { backend } = await make();
      await backend.write('application', { set: { k: 'new' }, delete: [] }, { generation: 5 });
      await backend.write('application', { set: { k: 'stale', other: 1 }, delete: [] }, { generation: 4 });
      expect(await backend.load('application')).toEqual({ k: 'new' });
      await backend.write('application', { set: { k: 'newer' }, delete: [] }, { generation: 6 });
      expect(await backend.load('application')).toEqual({ k: 'newer' });
    });

    it('C22: a write whose signal is already aborted is not applied', async () => {
      const { backend } = await make();
      const abort = new AbortController();
      abort.abort();
      await backend.write('project', { set: { k: 1 }, delete: [] }, { signal: abort.signal });
      expect(await backend.load('project')).toEqual({});
    });

    it('C22: keys written by another window are announced on onDidChangeExternally', async () => {
      const harness = await make();
      if (!harness.writeExternally) return; // the implementation has no second window to simulate
      const seen: Array<{ scope: StorageScope; keys: readonly string[] }> = [];
      const sub: IDisposable = harness.backend.onDidChangeExternally((e) => seen.push({ scope: e.scope, keys: e.keys }));
      harness.writeExternally('project', { set: { other: 1 }, delete: [] });
      sub.dispose();
      expect(seen).toEqual([{ scope: 'project', keys: ['other'] }]);
      expect(await harness.backend.load('project')).toEqual({ other: 1 });
    });
  });
}

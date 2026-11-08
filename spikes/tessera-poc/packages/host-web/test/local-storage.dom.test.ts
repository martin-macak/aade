import { describe, expect, it } from 'vitest';
import { captureErrors, storageBackendConformance } from '@tessera/testing';
import { localStorageBackend } from '../src/index.ts';

// C22: the localStorage backend passes the same StorageBackend conformance suite as the memory backend.
let n = 0;
storageBackendConformance('localStorage (jsdom)', () => {
  const prefix = `conformance-${++n}`;
  const backend = localStorageBackend({ prefix, projectId: 'p1' });
  return {
    backend,
    writeExternally(scope, batch) {
      // another tab writes to the same storage: the browser tells this tab with a `storage` event
      const p = scope === 'application' ? `${prefix}/application/` : `${prefix}/project/p1/`;
      for (const [key, value] of Object.entries(batch.set)) {
        localStorage.setItem(`${p}${key}`, JSON.stringify(value));
        window.dispatchEvent(new StorageEvent('storage', { key: `${p}${key}`, storageArea: localStorage }));
      }
    },
    dispose() {
      backend.clearAll();
      backend.dispose();
    },
  };
});

describe('C22: localStorage backend details', () => {
  it('C22: a write that fails half way is rolled back (atomic per call)', async () => {
    const real = window.localStorage;
    const backend = localStorageBackend({ prefix: 'rollback' });
    await backend.write('application', { set: { a: 1, b: 2 }, delete: [] });
    let calls = 0;
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'setItem') {
          return (k: string, v: string) => {
            if (++calls === 2) throw new DOMException('quota', 'QuotaExceededError');
            target.setItem(k, v);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const flaky = localStorageBackend({ storage: failing, prefix: 'rollback' });
    await expect(flaky.write('application', { set: { a: 10, b: 20 }, delete: [] })).rejects.toThrow('quota');
    expect(await backend.load('application')).toEqual({ a: 1, b: 2 }); // the first set was put back
    backend.clearAll();
    backend.dispose();
    flaky.dispose();
  });

  it('C22: a damaged item is skipped on load; keys of other prefixes and projects are not seen', async () => {
    localStorage.setItem('damaged/application/bad', '{not json');
    localStorage.setItem('damaged/application/good', '1');
    localStorage.setItem('other/application/x', '2');
    const backend = localStorageBackend({ prefix: 'damaged' });
    const errors = captureErrors();
    // the damaged text is kept next to the key and the damage is reported (storage.itemCorrupt)
    expect(await backend.load('application')).toEqual({ good: 1, 'bad.corrupt': '{not json' });
    const reported = errors.drain();
    errors.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'storage.itemCorrupt', details: { key: 'bad', scope: 'application' } });
    expect(localStorage.getItem('damaged/application/bad')).toBe('{not json'); // the original stays until the service overwrites it
    expect(JSON.parse(localStorage.getItem('damaged/application/bad.corrupt') as string)).toBe('{not json');
    expect(await backend.load('project')).toEqual({});
    backend.clearAll();
    localStorage.removeItem('other/application/x');
    backend.dispose();
  });
});

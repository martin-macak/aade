import { afterEach, describe, expect, it } from 'vitest';
import { isDevMode, setDevMode, type StateSchema } from '@tessera/base';
import type { StorageBackend } from '@tessera/contracts';
import { captureErrors, createTestScope } from '@tessera/testing';
import { DefaultStorageService, memoryStorageBackend, type MemoryStorageBackend } from '@tessera/persistence';

async function ticks(count = 30): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const numberSchema: StateSchema<number> = {
  version: 1,
  schema: { safeParse: (i) => (typeof i === 'number' ? { success: true, data: i } : { success: false, error: { issues: [{ path: [], message: 'not a number' }] } }) },
  initial: () => 0,
};

async function setup(wrap?: (inner: MemoryStorageBackend) => StorageBackend, initial?: Parameters<typeof memoryStorageBackend>[0]) {
  const t = createTestScope({ flat: true });
  const inner = memoryStorageBackend(initial);
  const backend = wrap ? wrap(inner) : inner;
  const storage = new DefaultStorageService(backend);
  await storage.whenReady();
  t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
  return { t, inner, backend, storage };
}

const previousDev = isDevMode();
afterEach(() => setDevMode(previousDev));

describe('round 3: one key, one value (memento-siblings-diverge)', () => {
  it('I31: two mementos of one key see each other, update stores the sum, and a raw set reaches both', async () => {
    const { inner, storage } = await setup();
    const a = storage.memento('application', 'k', numberSchema);
    const b = storage.memento('application', 'k', numberSchema);
    a.set(5);
    expect(b.get()).toBe(5);
    b.update((n) => n + 1);
    expect(a.get()).toBe(6);
    await storage.flush();
    expect(inner.snapshot('application')['k']).toEqual({ v: 1, data: 6 });
    storage.setVersioned('application', 'k', 9, numberSchema);
    expect(a.get()).toBe(9);
    expect(b.get()).toBe(9);
    storage.delete('application', 'k');
    expect(a.get()).toBe(0);
    expect(b.value.peek()).toBe(0);
  });

  it('I31: the last dispose drops the shared state; an earlier dispose keeps it', async () => {
    const { storage } = await setup();
    const a = storage.memento('application', 'k', numberSchema);
    const b = storage.memento('application', 'k', numberSchema);
    expect(storage.mementoCount).toBe(2);
    a.dispose();
    a.dispose(); // twice is harmless
    expect(storage.mementoCount).toBe(1);
    a.set(3);
    expect(b.get()).toBe(3);
    b.dispose();
    expect(storage.mementoCount).toBe(0);
  });

  it('I31: an external change updates the one state', async () => {
    const { inner, storage } = await setup();
    const a = storage.memento('application', 'k', numberSchema);
    const b = storage.memento('application', 'k', numberSchema);
    inner.writeExternally('application', { set: { k: { v: 1, data: 42 } }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    await ticks();
    expect(a.get()).toBe(42);
    expect(b.get()).toBe(42);
  });
});

describe('round 3: dirty clear by write counter (storage-dirty-clear-by-identity)', () => {
  it('I31: release mode: a re-set of the same mutated object during an in-flight write reaches the backend', async () => {
    setDevMode(false);
    const held: Array<() => void> = [];
    const { t, inner, storage } = await setup((m) => ({
      ...m,
      write: (scope, batch, options) =>
        new Promise<void>((resolve) => {
          held.push(() => void m.write(scope, batch, options).then(resolve));
        }),
    }));
    const value = { n: 1 };
    storage.set('application', 'o', value);
    t.scheduler.advance(500);
    await ticks(); // the first write is in flight and holds { n: 1 }
    expect(held).toHaveLength(1);
    value.n = 2;
    storage.set('application', 'o', value); // the same reference again
    held.shift()?.();
    await ticks();
    const flushed = storage.flush();
    await ticks();
    while (held.length > 0) {
      held.shift()?.();
      await ticks();
    }
    await flushed;
    expect(inner.snapshot('application')['o']).toEqual({ n: 2 });
  });

  it('dev mode: the value passed to set() is frozen, a later mutation throws, and a value that is not JSON-safe is refused', async () => {
    setDevMode(true);
    const { storage } = await setup();
    const value = { list: [1, 2], nested: { a: 1 } };
    storage.set('application', 'frozen', value);
    expect(storage.get('application', 'frozen')).toBe(value); // same reference as in release
    expect(() => {
      value.list.push(3);
    }).toThrow();
    expect(() => {
      value.nested.a = 2;
    }).toThrow();
    expect(() => storage.set('application', 'bad', { f: () => 1, big: 10n })).toThrowError(expect.objectContaining({ code: 'storage.notSerializable' }));
  });
});

describe('round 3: the final flush (final-flush-queues-behind-hung-write)', () => {
  it('I32: a backend that hangs once does not hold the final flush: the late state is written within the deadline', async () => {
    let hang = true;
    const { t, inner, storage } = await setup((m) => ({
      ...m,
      write: (scope, batch, options) => {
        if (hang) {
          hang = false;
          return new Promise<void>(() => undefined); // never settles
        }
        return m.write(scope, batch, options);
      },
    }));
    const errors = captureErrors();
    storage.set('application', 'early', 1);
    t.scheduler.advance(500);
    await ticks(); // the hung write is in flight
    storage.set('application', 'late', 2);
    const started = t.scheduler.now();
    const flushed = storage.flush({ final: true, deadline: started + 1000 });
    await ticks();
    const result = await flushed;
    expect(result.failedKeys).toEqual([]);
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toEqual(['storage.writeTimeout']); // the abandoned write is reported once
    expect(t.scheduler.now() - started).toBeLessThanOrEqual(1000);
    expect(inner.snapshot('application')).toEqual({ early: 1, late: 2 });
  });
});

describe('round 3: external changes (external-storage-change-reloads-whole-scope)', () => {
  it('ten events give at most two reads; with read() only the changed keys are read', async () => {
    let reads = 0;
    let loads = 0;
    const readKeys: string[][] = [];
    const { inner, storage } = await setup(
      (m) => ({
        ...m,
        load: (scope) => (loads++, m.load(scope)),
        read: async (scope, keys) => {
          reads++;
          readKeys.push([...keys]);
          const all = await m.load(scope);
          return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
        },
      }),
      { application: { a: 1 } },
    );
    loads = 0;
    for (let i = 0; i < 10; i++) inner.writeExternally('application', { set: { [`k${i}`]: i }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    await ticks(60);
    expect(reads).toBeLessThanOrEqual(2);
    expect(loads).toBe(0); // no whole-scope reload
    expect(storage.get('application', 'k9')).toBe(9);
    expect(readKeys.flat()).not.toContain('a');
  });

  it('an older read does not overwrite a newer one', async () => {
    const releases: Array<() => void> = [];
    const { inner, storage } = await setup((m) => ({
      ...m,
      read: (scope, keys) =>
        new Promise((resolve) => {
          const snapshot = m.snapshot(scope);
          releases.push(() => resolve(Object.fromEntries(keys.filter((k) => k in snapshot).map((k) => [k, snapshot[k]]))));
        }),
    }));
    inner.writeExternally('application', { set: { x: 1 }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    inner.writeExternally('application', { set: { x: 2 }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    await ticks();
    for (let i = 0; i < 6 && storage.get('application', 'x') !== 2; i++) {
      releases.shift()?.();
      await ticks(60);
    }
    expect(storage.get('application', 'x')).toBe(2);
  });
});

describe('configuration-declarations-rebuilt-per-get: the declarations are cached per change of the registry', () => {
  it('reading a setting 1000 times builds the declarations once, and adding a plugin with settings builds them at most once more', async () => {
    const { createTestApp, describePlugin, manifest } = await import('@tessera/testing');
    const { ConfigurationService } = await import('@tessera/contracts');
    const setting = (i: number) => ({ key: `bulk.s${i}`, type: 'boolean', default: false, context: i % 2 === 0 });
    const plugins = Array.from({ length: 20 }, (_, i) => describePlugin(manifest(`bulk.p${i}`, { contributes: { configuration: [setting(i * 2), setting(i * 2 + 1)] } }), 'builtin'));
    const app = await createTestApp({ plugins });
    const config = app.get(ConfigurationService) as unknown as { declarationBuilds: number; get(key: string): unknown };
    const before = config.declarationBuilds;
    for (let i = 0; i < 1000; i++) config.get(`bulk.s${i % 40}`);
    expect(config.declarationBuilds - before).toBeLessThanOrEqual(1);
    const mark = config.declarationBuilds;
    await app.plugins.add([describePlugin(manifest('bulk.late', { contributes: { configuration: [{ key: 'bulk.late', type: 'string', default: 'x' }] } }), 'builtin')]);
    for (let i = 0; i < 100; i++) config.get('bulk.late');
    expect(config.declarationBuilds - mark).toBeLessThanOrEqual(1);
    expect(config.get('bulk.late')).toBe('x');
    // the context mirror still works for the `context: true` subset
    expect(app.contextKeys.root.getValue('config.bulk.s0')).toBe(false);
  });
});

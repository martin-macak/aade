import { describe, expect, it } from 'vitest';
import { setDevMode, type StateSchema, type TesseraError } from '@tessera/base';
import { createInterceptorRegistry } from '@tessera/interceptors';
import { captureErrors, createTestScope } from '@tessera/testing';
import { DefaultStorageService, memoryStorageBackend, LOAD_BACKOFF_MS, WRITE_DEBOUNCE_MS, WRITE_MAX_DELAY_MS, WRITE_TIMEOUT_MS } from '@tessera/persistence';

/** Lets the pending promise chains run (the code under test awaits several times). */
async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function setup(initial?: Parameters<typeof memoryStorageBackend>[0]) {
  const t = createTestScope({ flat: true });
  const backend = memoryStorageBackend(initial);
  const storage = new DefaultStorageService(backend);
  await storage.whenReady();
  t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
  return { t, backend, storage };
}

describe('C22: storage reads', () => {
  it('C22: get throws storage.notReady before whenReady resolves, and reads synchronously after', async () => {
    const t = createTestScope({ flat: true });
    const backend = memoryStorageBackend({ application: { a: 1 } });
    const storage = new DefaultStorageService(backend);
    expect(() => storage.get('application', 'a')).toThrowError(expect.objectContaining({ code: 'storage.notReady' }));
    await storage.whenReady();
    expect(storage.get('application', 'a')).toBe(1);
    t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
  });

  it('C22: both scopes load once and keys() filters by prefix', async () => {
    const { storage } = await setup({ application: { 'plugin:x:a': 1, 'plugin:y:b': 2, other: 3 }, project: { p: 1 } });
    expect(storage.keys('application', 'plugin:x:')).toEqual(['plugin:x:a']);
    expect(storage.keys('project')).toEqual(['p']);
  });
});

describe('C22: write-behind batching (500 ms debounce, 2 s max, ManualScheduler)', () => {
  it('C22: a write waits 500 ms after the last change and goes out as one batch per scope', async () => {
    const { t, backend, storage } = await setup();
    storage.set('project', 'a', 1);
    t.scheduler.advance(300);
    storage.set('project', 'b', 2);
    storage.set('application', 'c', 3);
    t.scheduler.advance(WRITE_DEBOUNCE_MS - 1);
    await Promise.resolve();
    expect(backend.writes).toHaveLength(0); // the second change pushed the debounce
    t.scheduler.advance(1);
    await storage.flush();
    expect(backend.writes.map((w) => w.scope).sort()).toEqual(['application', 'project']);
    const project = backend.writes.find((w) => w.scope === 'project');
    expect(project?.set).toEqual({ a: 1, b: 2 });
    expect(backend.snapshot('application')).toEqual({ c: 3 });
  });

  it('C22: a stream of changes cannot starve the write: it goes out at most 2 s after the first change', async () => {
    const { t, backend, storage } = await setup();
    storage.set('project', 'k', 0);
    for (let i = 1; i <= 7; i++) {
      t.scheduler.advance(400); // always inside the 500 ms debounce
      storage.set('project', 'k', i);
    }
    // 2800 ms passed, the max timer (2000 ms) fired once in between
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.writes.length).toBeGreaterThanOrEqual(1);
    expect(t.scheduler.now()).toBeGreaterThanOrEqual(WRITE_MAX_DELAY_MS);
    await storage.flush();
    expect(backend.snapshot('project')).toEqual({ k: 7 });
  });

  it('C22: flush writes pending changes now and a second flush writes nothing', async () => {
    const { backend, storage } = await setup();
    storage.set('project', 'a', 1);
    await storage.flush();
    expect(backend.writes).toHaveLength(1);
    await storage.flush();
    expect(backend.writes).toHaveLength(1);
  });

  it('C22: deletes are batched with sets and a set-then-delete of one key sends only the delete', async () => {
    const { backend, storage } = await setup({ project: { old: 1 } });
    storage.set('project', 'new', 1);
    storage.delete('project', 'old');
    storage.set('project', 'tmp', 1);
    storage.delete('project', 'tmp');
    await storage.flush();
    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0]?.set).toEqual({ new: 1 });
    expect([...(backend.writes[0]?.delete ?? [])].sort()).toEqual(['old', 'tmp']);
    expect(backend.snapshot('project')).toEqual({ new: 1 });
  });

  it('C22: the write runs through the persistence interceptor pipeline (target write:<scope>)', async () => {
    const t = createTestScope({ flat: true });
    const backend = memoryStorageBackend();
    const interceptors = createInterceptorRegistry();
    const seen: string[] = [];
    interceptors.register({
      id: 'spy',
      kinds: ['persistence'],
      async intercept(ctx, next) {
        seen.push(`${ctx.target}:${ctx.data.keys.join(',')}`);
        return next();
      },
    });
    const storage = new DefaultStorageService(backend, interceptors);
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
    storage.set('application', 'k', 1);
    await storage.flush();
    expect(seen).toEqual(['write:application:k']);
  });

  it('C22: a failed write is retried at once and then succeeds, with no error', async () => {
    const { backend, storage } = await setup();
    const errors = captureErrors();
    backend.failNextWrites(1);
    storage.set('project', 'k', 1);
    const result = await storage.flush();
    expect(result.failedKeys).toEqual([]);
    expect(errors.drain()).toEqual([]);
    expect(backend.snapshot('project')).toEqual({ k: 1 });
    errors.dispose();
  });

  it('C22: when the whole backend is down the key stays dirty, one retry follows after 1 s, and the next flush writes it', async () => {
    const { t, backend, storage } = await setup();
    const errors = captureErrors();
    backend.failNextWrites(6);
    storage.set('project', 'k', 1);
    const first = await storage.flush(); // attempt 1 and the immediate retry fail
    expect(first.failedKeys).toEqual(['project:k']);
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['storage.writeFailed']);
    t.scheduler.advance(1000); // the one scheduled retry: attempt 3 fails, its immediate retry (4) fails
    await storage.flush(); // waits for the retry, then attempts 5 and 6 fail
    expect(backend.snapshot('project')).toEqual({});
    errors.drain();
    await storage.flush(); // backend works again
    expect(backend.snapshot('project')).toEqual({ k: 1 });
    errors.dispose();
  });
});

describe('C22: one bad key does not stop the others (storage-batch-poison-pill)', () => {
  it('C22: a circular value is quarantined and the good key in the same batch persists', async () => {
    setDevMode(false); // dev mode refuses the value at set() already
    try {
      const { backend, storage } = await setup();
      const errors = captureErrors();
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      storage.set('project', 'plugin:acme.git:bad', cyclic);
      storage.set('project', 'good', 1);
      const result = await storage.flush();
      expect(backend.snapshot('project')).toEqual({ good: 1 });
      expect(result.failedKeys).toEqual(['project:plugin:acme.git:bad']);
      const reported = errors.drain();
      expect(reported.map((e) => (e.error as TesseraError).code)).toEqual(['storage.notSerializable']);
      expect(reported[0]?.context.pluginId).toBe('acme.git');
      // the value is still readable from memory, and a later good value is written
      expect(storage.get('project', 'plugin:acme.git:bad')).toBe(cyclic);
      storage.set('project', 'plugin:acme.git:bad', 2);
      expect((await storage.flush()).failedKeys).toEqual([]);
      expect(backend.snapshot('project')).toEqual({ good: 1, 'plugin:acme.git:bad': 2 });
      errors.dispose();
    } finally {
      setDevMode(true);
    }
  });

  it('C22: a value above the size cap is quarantined with storage.tooLarge', async () => {
    const t = createTestScope({ flat: true });
    const backend = memoryStorageBackend();
    const storage = new DefaultStorageService(backend, undefined, { maxValueBytes: 100 });
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
    const errors = captureErrors();
    storage.set('project', 'big', 'x'.repeat(500));
    storage.set('project', 'small', 'y');
    const result = await storage.flush();
    expect(result.failedKeys).toEqual(['project:big']);
    expect(backend.snapshot('project')).toEqual({ small: 'y' });
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['storage.tooLarge']);
    errors.dispose();
  });

  it('C22: a backend that rejects one key splits the batch: the other keys persist, the retry count is bounded', async () => {
    const t = createTestScope({ flat: true });
    const inner = memoryStorageBackend();
    let calls = 0;
    const backend = {
      ...inner,
      async write(scope: 'application' | 'project', batch: { set: Record<string, unknown>; delete: readonly string[] }) {
        calls++;
        if ('quota' in batch.set) throw new Error('QuotaExceededError');
        await inner.write(scope, batch);
      },
    };
    const storage = new DefaultStorageService(backend as never);
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
    const errors = captureErrors();
    storage.set('project', 'a', 1);
    storage.set('project', 'quota', 2);
    storage.set('project', 'b', 3);
    const result = await storage.flush();
    expect(inner.snapshot('project')).toEqual({ a: 1, b: 3 });
    expect(result.failedKeys).toEqual(['project:quota']);
    expect(calls).toBe(2 + 3); // the batch, one retry, then one write per key
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['storage.writeFailed']);
    t.scheduler.advance(5000);
    await storage.flush();
    expect(calls).toBe(5); // the quarantined key is not retried and nothing else is dirty
    errors.dispose();
  });

  it('C22: the shutdown join shows the failed key (flush result)', async () => {
    const { storage } = await setup();
    setDevMode(false);
    try {
      const errors = captureErrors();
      storage.set('application', 'bad', 10n);
      expect((await storage.flush()).failedKeys).toEqual(['application:bad']);
      errors.drain();
      errors.dispose();
    } finally {
      setDevMode(true);
    }
  });
});

describe('C22: size warnings in dev mode (layout-save-starvation-and-whole-blob)', () => {
  it('C22: a value above 64 KB is reported once as storage.writeLarge with the plugin id, and still written', async () => {
    const { backend, storage } = await setup();
    const errors = captureErrors();
    storage.set('project', 'plugin:acme.big:blob', 'x'.repeat(70 * 1024));
    await storage.flush();
    storage.set('project', 'plugin:acme.big:blob', 'y'.repeat(71 * 1024));
    await storage.flush();
    const reported = errors.drain();
    errors.dispose();
    expect(reported.map((e) => (e.error as TesseraError).code)).toEqual(['storage.writeLarge']); // once per key
    expect(reported[0]?.context.pluginId).toBe('acme.big');
    expect(String(backend.snapshot('project')['plugin:acme.big:blob']).length).toBe(71 * 1024);
  });

  it('C22: nothing is reported in production mode and for small values', async () => {
    const { storage } = await setup();
    const errors = captureErrors();
    storage.set('project', 'small', 'x'.repeat(1000));
    await storage.flush();
    setDevMode(false);
    try {
      storage.set('project', 'big', 'x'.repeat(70 * 1024));
      await storage.flush();
    } finally {
      setDevMode(true);
    }
    expect(errors.drain()).toEqual([]);
    errors.dispose();
  });
});

describe('C22: a backend write that never settles (storage-write-no-timeout-stalls-queue)', () => {
  it('C22: the write times out after 10 s, the key stays dirty, and the chain is free again', async () => {
    const t = createTestScope({ flat: true });
    const inner = memoryStorageBackend();
    let hang = true;
    let signal: AbortSignal | undefined;
    const backend = {
      ...inner,
      write(scope: 'application' | 'project', batch: { set: Record<string, unknown>; delete: readonly string[] }, options?: { signal?: AbortSignal }) {
        signal = options?.signal;
        return hang ? new Promise<void>(() => undefined) : inner.write(scope, batch);
      },
    };
    const storage = new DefaultStorageService(backend as never);
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
    const errors = captureErrors();
    storage.set('project', 'k', 1);
    const flushed = storage.flush();
    await Promise.resolve();
    t.scheduler.advance(WRITE_TIMEOUT_MS);
    const result = await flushed;
    expect(result.failedKeys).toEqual(['project:k']);
    expect(signal?.aborted).toBe(true);
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['storage.writeTimeout']);
    hang = false;
    expect((await storage.flush()).failedKeys).toEqual([]);
    expect(inner.snapshot('project')).toEqual({ k: 1 });
    errors.dispose();
  });
});

describe('C22: a failed load (storage-load-failure-no-degraded-mode)', () => {
  function flakyBackend(failures: number) {
    const inner = memoryStorageBackend({ application: { saved: 1 } });
    let left = failures;
    let loads = 0;
    return {
      inner,
      get loads() {
        return loads;
      },
      backend: {
        ...inner,
        async load(scope: 'application' | 'project') {
          loads++;
          if (left > 0) {
            left--;
            throw new Error('disk unavailable');
          }
          return inner.load(scope);
        },
      },
    };
  }

  it('C22: a load that rejects once is retried with back-off and storage recovers', async () => {
    const t = createTestScope({ flat: true });
    const flaky = flakyBackend(1);
    const storage = new DefaultStorageService(flaky.backend as never);
    t.application.track({ dispose: () => (storage.dispose(), flaky.inner.dispose()) });
    const ready = storage.whenReady();
    await ticks();
    t.scheduler.advance(LOAD_BACKOFF_MS[0] ?? 250);
    await ready;
    expect(storage.degraded.peek()).toBe(false);
    expect(storage.get('application', 'saved')).toBe(1);
  });

  it('C22: a load that always rejects ends in degraded mode: reads and writes work in memory, nothing is written, retryLoad recovers', async () => {
    const t = createTestScope({ flat: true });
    const flaky = flakyBackend(100);
    const storage = new DefaultStorageService(flaky.backend as never);
    t.application.track({ dispose: () => (storage.dispose(), flaky.inner.dispose()) });
    const errors = captureErrors();
    const ready = storage.whenReady();
    for (const wait of LOAD_BACKOFF_MS) {
      await ticks();
      t.scheduler.advance(wait);
    }
    await ready;
    expect(flaky.loads).toBe((1 + LOAD_BACKOFF_MS.length) * 2); // both scopes per attempt
    expect(storage.degraded.peek()).toBe(true);
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['storage.loadFailed']);
    storage.set('application', 'session', 1);
    expect(storage.get('application', 'session')).toBe(1);
    expect((await storage.flush()).failedKeys).toEqual(['application:session']); // degraded: every dirty key is reported
    expect(flaky.inner.writes).toHaveLength(0);
    // the backend works again
    flaky.backend.load = flaky.inner.load.bind(flaky.inner);
    expect(await storage.retryLoad()).toBe(true);
    expect(storage.degraded.peek()).toBe(false);
    expect(storage.get('application', 'saved')).toBe(1);
    await storage.flush();
    expect(flaky.inner.snapshot('application')).toEqual({ saved: 1, session: 1 });
    errors.dispose();
  });
});

describe('C22: values, change events and external changes', () => {
  it('C22: dev mode rejects a value that is not JSON-safe with storage.notSerializable', async () => {
    const { storage } = await setup();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => storage.set('project', 'bad', cyclic)).toThrowError(expect.objectContaining({ code: 'storage.notSerializable' }));
    expect(() => storage.set('project', 'big', 10n)).toThrowError(expect.objectContaining({ code: 'storage.notSerializable' }));
  });

  it('C22: onDidChange reports local changes with external false', async () => {
    const { storage } = await setup();
    const seen: Array<{ keys: string[]; external: boolean }> = [];
    storage.onDidChange((e) => seen.push({ keys: [...e.keys], external: e.external }));
    storage.set('project', 'a', 1);
    storage.delete('project', 'a');
    expect(seen).toEqual([
      { keys: ['a'], external: false },
      { keys: ['a'], external: false },
    ]);
  });

  it('C22: keys changed by another window reload, update mementos and fire onDidChange with external true', async () => {
    const { backend, storage } = await setup({ application: { 'plugin:x:n': { v: 1, data: 1 } } });
    const schema: StateSchema<number> = { version: 1, schema: { safeParse: (i) => (typeof i === 'number' ? { success: true, data: i } : { success: false, error: { issues: [] } }) }, initial: () => 0 };
    const memento = storage.memento('application', 'plugin:x:n', schema);
    expect(memento.get()).toBe(1);
    const seen: Array<{ keys: string[]; external: boolean }> = [];
    storage.onDidChange((e) => seen.push({ keys: [...e.keys], external: e.external }));
    backend.writeExternally('application', { set: { 'plugin:x:n': { v: 1, data: 42 } }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(memento.get()).toBe(42);
    expect(seen).toEqual([{ keys: ['plugin:x:n'], external: true }]);
  });

  it('C22: a pending local write wins over an external change of the same key', async () => {
    const { backend, storage } = await setup();
    storage.set('project', 'k', 'mine');
    backend.writeExternally('project', { set: { k: 'theirs' }, delete: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.get('project', 'k')).toBe('mine');
  });
});

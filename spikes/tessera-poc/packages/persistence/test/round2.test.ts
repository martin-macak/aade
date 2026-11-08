import { describe, expect, it } from 'vitest';
import { type StateSchema } from '@tessera/base';
import { captureErrors, createTestScope } from '@tessera/testing';
import { DefaultStorageService, LOAD_BACKOFF_MS, LOAD_TIMEOUT_MS, MAX_RECORDED_WRITES, memoryStorageBackend } from '@tessera/persistence';

async function ticks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const numberSchema = (version: number): StateSchema<number> => ({
  version,
  schema: { safeParse: (i) => (typeof i === 'number' ? { success: true, data: i } : { success: false, error: { issues: [{ path: [], message: 'not a number' }] } }) },
  initial: () => 0,
});

describe('round 2: a load that never settles', () => {
  it('C22: each attempt times out (storage.loadTimeout), the retries run, and storage ends degraded with one notice inside 5 s', async () => {
    const t = createTestScope({ flat: true });
    const inner = memoryStorageBackend({ application: { saved: 1 } });
    let loads = 0;
    const hung = { ...inner, load: () => (loads++, new Promise<never>(() => undefined)) };
    const storage = new DefaultStorageService(hung as never);
    t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
    const errors = captureErrors();
    const started = t.scheduler.now();
    let ready = false;
    void storage.whenReady().then(() => (ready = true));
    // three attempts of LOAD_TIMEOUT_MS with the back-offs between them
    const steps = [LOAD_TIMEOUT_MS, LOAD_BACKOFF_MS[0] ?? 0, LOAD_TIMEOUT_MS, LOAD_BACKOFF_MS[1] ?? 0, LOAD_TIMEOUT_MS];
    for (const step of steps) {
      await ticks();
      expect(ready).toBe(false);
      t.scheduler.advance(step);
    }
    await ticks(100);
    expect(ready).toBe(true);
    expect(t.scheduler.now() - started).toBeLessThan(5000);
    expect(storage.degraded.peek()).toBe(true);
    expect(loads).toBe(6); // both scopes, three attempts
    const reported = errors.drain().map((e) => (e.error as { code: string }).code);
    errors.dispose();
    expect(reported).toEqual(['storage.loadFailed']); // one notice
  });
});

describe('round 2: retry after degraded mode keeps the stored state', () => {
  it('C22: the backend wins for every key it holds; the session value goes to <key>.bak.degraded; absent keys are written; consumers hear an external change', async () => {
    const t = createTestScope({ flat: true });
    const inner = memoryStorageBackend({ project: { 'workbench.layout': { v: 1, data: 'REAL LAYOUT' }, untouched: 'u' }, application: { 'plugins.disabled': { v: 1, data: ['a.b'] } } });
    let failing = true;
    const backend = { ...inner, load: (scope: 'application' | 'project') => (failing ? Promise.reject(new Error('disk offline')) : inner.load(scope)), write: inner.write.bind(inner), snapshot: inner.snapshot, onDidChangeExternally: inner.onDidChangeExternally };
    const storage = new DefaultStorageService(backend as never, undefined, { loadBackoffMs: [] });
    t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
    const errors = captureErrors();
    await storage.whenReady();
    expect(storage.degraded.peek()).toBe(true);
    // the session writes defaults over the keys it could not read, and one new key
    storage.set('project', 'workbench.layout', { v: 1, data: 'DEFAULT LAYOUT' });
    storage.set('application', 'plugins.disabled', { v: 1, data: [] });
    storage.set('application', 'session.only', 5);
    const memento = storage.memento('project', 'workbench.layout', { version: 1, schema: { safeParse: (i) => ({ success: true, data: i as string }) }, initial: () => 'x' } as StateSchema<string>);
    expect(memento.get()).toBe('DEFAULT LAYOUT');
    const seen: Array<{ scope: string; keys: string[]; external: boolean }> = [];
    storage.onDidChange((e) => seen.push({ scope: e.scope, keys: [...e.keys].sort(), external: e.external }));
    failing = false;
    expect(await storage.retryLoad()).toBe(true);
    expect(storage.degraded.peek()).toBe(false);
    // the real state is back
    expect(storage.get('project', 'workbench.layout')).toEqual({ v: 1, data: 'REAL LAYOUT' });
    expect(storage.get('application', 'plugins.disabled')).toEqual({ v: 1, data: ['a.b'] });
    expect(memento.get()).toBe('REAL LAYOUT');
    expect(seen.some((e) => e.external && e.scope === 'project' && e.keys.includes('workbench.layout'))).toBe(true);
    expect(seen.some((e) => e.external && e.scope === 'application' && e.keys.includes('plugins.disabled'))).toBe(true);
    // the session value is kept next to the key, and absent keys are written
    await storage.flush();
    const project = inner.snapshot('project');
    const application = inner.snapshot('application');
    expect(project['workbench.layout']).toEqual({ v: 1, data: 'REAL LAYOUT' });
    expect(project['workbench.layout.bak.degraded']).toEqual({ v: 1, data: 'DEFAULT LAYOUT' });
    expect(application['plugins.disabled']).toEqual({ v: 1, data: ['a.b'] });
    expect(application['plugins.disabled.bak.degraded']).toEqual({ v: 1, data: [] });
    expect(application['session.only']).toBe(5);
    expect(project['untouched']).toBe('u');
    errors.drain();
    errors.dispose();
  });
});

describe('round 2: backups keep the newest copy', () => {
  it('C22: a second downgrade replaces the .bak copy of the first', async () => {
    const t = createTestScope({ flat: true });
    const backend = memoryStorageBackend({ project: { k: { v: 7, data: 100 } } });
    const storage = new DefaultStorageService(backend);
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
    storage.getVersioned('project', 'k', numberSchema(1)); // v7 is newer than the schema: reset, copy to k.bak.v7
    await ticks();
    await storage.flush();
    expect(backend.snapshot('project')['k.bak.v7']).toEqual({ v: 7, data: 100 });
    // the user works on, and a later version writes v7 data again with other content, then the app downgrades again
    backend.writeExternally('project', { set: { k: { v: 7, data: 200 } }, delete: [] });
    await ticks();
    await new Promise((r) => setTimeout(r, 0));
    const second = new DefaultStorageService(backend);
    await second.whenReady();
    second.getVersioned('project', 'k', numberSchema(1));
    await ticks();
    await second.flush();
    expect(backend.snapshot('project')['k.bak.v7']).toEqual({ v: 7, data: 200 });
    second.dispose();
  });
});

describe('round 2: write generations and memento release', () => {
  it('C22: after a write timeout, the late write of the abandoned attempt cannot overwrite newer data', async () => {
    const t = createTestScope({ flat: true });
    const inner = memoryStorageBackend();
    const late: Array<() => Promise<void>> = [];
    let slow = true;
    const backend = {
      ...inner,
      load: inner.load.bind(inner),
      onDidChangeExternally: inner.onDidChangeExternally,
      write: (scope: 'application' | 'project', batch: { set: Record<string, unknown>; delete: string[] }, options?: { signal?: AbortSignal; generation?: number }) => {
        if (!slow) return inner.write(scope, batch, options);
        // the first write hangs and lands later, after the service gave up (its signal is not honoured here: a bad backend)
        return new Promise<void>((resolve) => late.push(async () => (await inner.write(scope, batch, options?.generation === undefined ? undefined : { generation: options.generation }), resolve())));
      },
    };
    const storage = new DefaultStorageService(backend as never, undefined, { writeTimeoutMs: 1000 });
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), inner.dispose()) });
    const errors = captureErrors();
    storage.set('project', 'k', 'old');
    const first = storage.flush();
    await ticks();
    t.scheduler.advance(1000);
    expect((await first).failedKeys).toContain('project:k');
    slow = false;
    storage.set('project', 'k', 'new');
    await storage.flush();
    expect(inner.snapshot('project')['k']).toBe('new');
    await late[0]?.(); // the old write finally lands
    expect(inner.snapshot('project')['k']).toBe('new'); // ignored: lower generation
    errors.drain();
    errors.dispose();
  });

  it('C22: Memento.dispose() leaves the registry (10,000 cycles keep the count at 0)', async () => {
    const t = createTestScope({ flat: true });
    const backend = memoryStorageBackend();
    const storage = new DefaultStorageService(backend);
    await storage.whenReady();
    t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
    for (let i = 0; i < 10_000; i++) storage.memento('project', `k${i % 7}`, numberSchema(1)).dispose();
    expect(storage.mementoCount).toBe(0);
  });
});

describe('round 2: test doubles keep a bounded history', () => {
  it('B15: the memory backend keeps at most MAX_RECORDED_WRITES records, and none with retainHistory false', async () => {
    const kept = memoryStorageBackend();
    const none = memoryStorageBackend(undefined, { retainHistory: false });
    for (let i = 0; i < MAX_RECORDED_WRITES + 500; i++) {
      await kept.write('project', { set: { k: i }, delete: [] });
      await none.write('project', { set: { k: i }, delete: [] });
    }
    expect(kept.writes).toHaveLength(MAX_RECORDED_WRITES);
    expect(kept.writes.at(-1)?.set).toEqual({ k: MAX_RECORDED_WRITES + 499 });
    expect(none.writes).toHaveLength(0);
    expect(none.snapshot('project')['k']).toBe(MAX_RECORDED_WRITES + 499); // the data is still written
    kept.dispose();
    none.dispose();
  });
});

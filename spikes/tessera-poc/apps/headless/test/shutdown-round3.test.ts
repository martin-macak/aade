import { describe, expect, it } from 'vitest';
import { memoryStorageBackend } from '@tessera/persistence';
import { captureErrors, createTestApp } from '@tessera/testing';

async function ticks(count = 200): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function drive<T>(t: { readonly scheduler: { advance(ms: number): void } }, work: Promise<T>, stepMs = 25): Promise<T> {
  const progress = { done: false };
  void work.finally(() => (progress.done = true));
  for (let i = 0; i < 1200 && !progress.done; i++) {
    await ticks();
    t.scheduler.advance(stepMs);
  }
  return work;
}

describe('round 3: shutdown steps in the composed application', () => {
  it('I32: in degraded mode the shutdown result lists storage.flush and layout.flush in failed (dispose-step-flush-failures-unreported)', async () => {
    const inner = memoryStorageBackend();
    const flaky = { ...inner, load: () => Promise.reject(new Error('disk offline')), write: inner.write.bind(inner), onDidChangeExternally: inner.onDidChangeExternally };
    const errors = captureErrors();
    const t = await createTestApp({ host: { storage: flaky as never }, start: false });
    await drive(t, t.app.start({ mount: () => undefined }));
    await t.settle();
    t.storageService.set('application', 'typed-text', 'unsaved');
    const result = await drive(t, t.app.shutdown('quit'));
    expect(result.failed).toEqual(expect.arrayContaining(['storage.flush', 'layout.flush']));
    expect(inner.writes).toHaveLength(0);
    errors.dispose();
  });

  it('I32: a backend whose write never settles and a plugin whose deactivate never settles: the shutdown ends inside 6.5 s and reports both', async () => {
    const { DeferredPromise } = await import('@tessera/base');
    const { describePlugin } = await import('@tessera/testing');
    const never = new DeferredPromise<void>();
    const inner = memoryStorageBackend();
    const hung = { ...inner, write: () => new Promise<void>(() => undefined), load: inner.load, onDidChangeExternally: inner.onDidChangeExternally };
    const plugin = describePlugin({ id: 'probe.hang', name: 'hang', version: '1.0.0', publisher: 't', engines: { tessera: '^1.0.0' }, main: './m.js', activationEvents: ['*'] } as never, 'builtin');
    const errors = captureErrors();
    const t = await createTestApp({ plugins: [plugin], modules: { [plugin.location]: { activate: () => undefined, deactivate: () => never.promise } }, host: { storage: hung as never } });
    t.storageService.set('application', 'late-state', 1);
    const started = t.scheduler.now();
    const result = await drive(t, t.app.shutdown('quit'));
    never.resolve();
    expect(t.scheduler.now() - started).toBeLessThanOrEqual(6500);
    expect(result.timedOut).toContain('probe.hang');
    expect(result.failed ?? []).toContain('storage.flush'); // the final flush could not write the key
    errors.drain();
    errors.dispose();
  });
});

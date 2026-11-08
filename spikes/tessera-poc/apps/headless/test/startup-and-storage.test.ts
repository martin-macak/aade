import { describe, expect, it } from 'vitest';
import { setDevMode, type StateSchema } from '@tessera/base';
import { LAYOUT_STORAGE_KEY, LayoutStore, LifecycleContribution, LifecyclePhase, NotificationService, type PluginContext, type ServiceModule } from '@tessera/contracts';
import { memoryStorageBackend } from '@tessera/persistence';
import { captureErrors, createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

/** Runs a promise that waits for scheduler timers: advances the manual scheduler until it settles. */
async function drive<T>(t: { readonly scheduler: { advance(ms: number): void } }, work: Promise<T>, stepMs = 250): Promise<T> {
  const state = { done: false };
  void work.finally(() => (state.done = true));
  for (let i = 0; i < 80 && !state.done; i++) {
    await ticks();
    t.scheduler.advance(stepMs);
  }
  return work;
}

const anySchema: StateSchema<unknown> = { version: 1, schema: { safeParse: (d) => ({ success: true, data: d }) }, initial: () => undefined };

describe('C21: startup order (first-paint-gated-on-star-plugins)', () => {
  it('C21: "*" plugins are not active when mount() runs and are active after the restore; the four startup marks are in order', async () => {
    const star = describePlugin(manifest('fixture.star', { activationEvents: ['*'] }));
    const states: Array<string | undefined> = [];
    const t = await createTestApp({ plugins: [star], modules: { [star.location]: { activate: () => undefined } }, start: false });
    await t.app.start({ mount: () => void states.push(t.plugins.status('fixture.star')?.state) });
    expect(states).toEqual(['resolved']); // the first paint did not wait for the "*" plugin
    await t.settle();
    expect(t.plugins.status('fixture.star')?.state).toBe('active');
    expect(t.plugins.status('fixture.star')?.activationReason).toBe('*');
    const marks = [...t.app.marks];
    expect(marks.map(([name]) => name)).toEqual(['app.start', 'phase.Starting.end', 'first-paint', 'restored']);
    expect(marks.map(([, at]) => at)).toEqual([...marks.map(([, at]) => at)].toSorted((a, b) => a - b));
  });

  it('C21: a phase that takes longer than the phase budget is reported once as lifecycle.phaseBudget (report only)', async () => {
    let advance: (ms: number) => void = () => undefined;
    const slow: ServiceModule = {
      id: 'fixture.slowPhase',
      install({ window }) {
        window.provideMany(LifecycleContribution, () => ({ id: 'fixture.slow', phase: LifecyclePhase.Starting, run: () => advance(300) }), { owner: 'fixture' });
      },
    };
    const t = await createTestApp({ appModules: [slow], lifecycle: { phaseBudgetMs: 100 }, start: false });
    advance = (ms) => t.scheduler.advance(ms);
    const errors = captureErrors();
    await t.start();
    const reported = errors.drain().filter((e) => (e.error as { code?: string }).code === 'lifecycle.phaseBudget');
    errors.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context.target).toBe('phase:Starting');
    expect(t.app.marks.has('restored')).toBe(true); // the report did not stop the start
  });
});

describe('C22: layout save has a maximum wait (layout-save-starvation-and-whole-blob)', () => {
  it('C22: 100 changes at 100 ms spacing give a save before 2.5 s (500 ms debounce, 2 s max wait)', async () => {
    const t = await createTestApp({});
    await t.advance(10_000);
    t.storageService.delete('project', LAYOUT_STORAGE_KEY);
    await t.settle();
    const layout = t.get(LayoutStore);
    let firstSave: number | undefined;
    const started = t.scheduler.now();
    for (let i = 0; i < 100 && firstSave === undefined; i++) {
      layout.scheduleSave();
      t.scheduler.advance(100);
      if (t.storageService.get('project', LAYOUT_STORAGE_KEY) !== undefined) firstSave = t.scheduler.now() - started;
    }
    expect(firstSave).toBeDefined();
    expect(firstSave).toBeLessThanOrEqual(2500);
    expect(firstSave).toBeGreaterThanOrEqual(2000); // not earlier than the max wait: the debounce kept restarting
  });

  it('C22: the layout schema is built once while the set of migrations does not change', async () => {
    const t = await createTestApp({});
    const store = t.get(LayoutStore) as unknown as { schema(): unknown };
    expect(store.schema()).toBe(store.schema());
  });
});

describe('C22: a failed storage load runs degraded (storage-load-failure-no-degraded-mode)', () => {
  it('C22: the context key, one notification with a Retry action, and the retry command that recovers', async () => {
    const inner = memoryStorageBackend({ application: { saved: 1 } });
    let broken = true;
    const backend = Object.assign(Object.create(inner) as typeof inner, { load: async (scope: 'application' | 'project') => (broken ? Promise.reject(new Error('disk unavailable')) : inner.load(scope)) });
    const errors = captureErrors();
    const t = await createTestApp({ storage: backend, start: false });
    await drive(t, t.start());
    errors.drain();
    errors.dispose();
    expect(t.contextKeys.root.getValue('storage.degraded')).toBe(true);
    const notices = t.get(NotificationService).active.peek();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.actions?.map((a) => a.title)).toEqual(['Retry']);
    broken = false;
    await t.commands.execute(notices[0]?.actions?.[0]?.command ?? 'missing');
    expect(t.storageService.degraded.peek()).toBe(false);
    expect(t.contextKeys.root.getValue('storage.degraded')).toBe(false);
    expect(t.storageService.get('application', 'saved')).toBe(1);
  });
});

describe('C13: a key that cannot be written shows in the shutdown result (storage-batch-poison-pill)', () => {
  it('C13: a quarantined key makes the storage.flush join fail: ShutdownResult.failed lists it, the good key is on the backend', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const plugin = describePlugin(manifest('fixture.poison', { activationEvents: ['*'] }));
    const module = {
      activate(ctx: PluginContext) {
        ctx.storage.application.set('bad', cyclic, anySchema);
        ctx.storage.application.set('good', 7, anySchema);
      },
    };
    setDevMode(false);
    try {
      const t: TestApp = await createTestApp({ plugins: [plugin], modules: { [plugin.location]: module }, host: { isDev: false } });
      const errors = captureErrors();
      const result = await drive(t, t.app.shutdown('close'));
      expect(result.vetoed).toBe(false);
      expect(result.failed).toEqual(['storage.flush']);
      expect(t.storage.snapshot('application')['plugin:fixture.poison:good']).toEqual({ v: 1, data: 7 });
      expect(Object.keys(t.storage.snapshot('application'))).not.toContain('plugin:fixture.poison:bad');
      expect(errors.drain().some((e) => (e.error as { code?: string }).code === 'storage.notSerializable')).toBe(true);
      errors.dispose();
    } finally {
      setDevMode(true);
    }
  });
});

describe('round 2: startup budgets are reported per mark', () => {
  it('C21: a first paint later than firstPaintBudgetMs and a restore later than restoredBudgetMs are reported once each as lifecycle.markBudget; the start goes on', async () => {
    let advance: (ms: number) => void = () => undefined;
    const slow: ServiceModule = {
      id: 'fixture.slowStart',
      install({ window }) {
        window.provideMany(LifecycleContribution, () => ({ id: 'fixture.slowStart', phase: LifecyclePhase.Starting, run: () => advance(900) }), { owner: 'fixture' });
      },
    };
    const t = await createTestApp({ appModules: [slow], lifecycle: { firstPaintBudgetMs: 800, restoredBudgetMs: 1500 }, start: false });
    advance = (ms) => t.scheduler.advance(ms);
    const errors = captureErrors();
    await t.app.start({ mount: () => advance(700) });
    await t.settle();
    const reported = errors.drain().filter((e) => (e.error as { code?: string }).code === 'lifecycle.markBudget');
    errors.dispose();
    expect(reported.map((e) => e.context.target)).toEqual(['mark:first-paint', 'mark:restored']);
    expect(t.app.marks.has('restored')).toBe(true);
  });

  it('C21: a fast start reports nothing', async () => {
    const t = await createTestApp({ lifecycle: { firstPaintBudgetMs: 800, restoredBudgetMs: 1500 } });
    const errors = captureErrors();
    await t.settle();
    expect(errors.drain().filter((e) => (e.error as { code?: string }).code === 'lifecycle.markBudget')).toEqual([]);
    errors.dispose();
  });
});

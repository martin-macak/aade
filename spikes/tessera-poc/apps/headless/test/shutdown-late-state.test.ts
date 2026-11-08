import { describe, expect, it } from 'vitest';
import { DeferredPromise, toDisposable, type StateSchema } from '@tessera/base';
import { LifecycleContribution, LifecyclePhase, type PluginContext, type ServiceModule } from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin, type TestApp } from '@tessera/testing';

const counter: StateSchema<number> = { version: 1, schema: { safeParse: (d) => ({ success: true, data: d as number }) }, initial: () => 0 };

const manifest = (id: string, extra: object = {}): ReturnType<typeof describePlugin> =>
  describePlugin({ id, name: id, version: '1.0.0', publisher: 't', engines: { tessera: '^1.0.0' }, main: './m.js', activationEvents: ['*'], ...extra });

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

/** Runs a shutdown that waits for timers: advances the manual scheduler until the promise settles. */
async function drive<T>(t: TestApp, work: Promise<T>, stepMs = 25): Promise<T> {
  const state = { done: false };
  void work.finally(() => (state.done = true));
  for (let i = 0; i < 1200 && !state.done; i++) {
    await ticks(200); // microtask-heavy steps cost no scheduler time in production; the manual clock must not run ahead of them
    t.scheduler.advance(stepMs);
  }
  return work;
}

describe('C13: state saved late reaches the backend (late-state-lost-at-shutdown)', () => {
  it('C13: a value set in deactivate() and a WorkItem memento written in terminate() are flushed by the dispose step', async () => {
    let context: PluginContext | undefined;
    const module = {
      activate(ctx: PluginContext) {
        context = ctx;
        ctx.storage.application.set('late', 7, counter);
        (ctx as unknown as { workItems: { create(id: string): unknown } }).workItems.create('late-item');
      },
      deactivate() {
        context?.storage.application.set('inDeactivate', 42, counter);
      },
    };
    const t = await createTestApp({ plugins: [manifest('probe.saver')], modules: { 'test://probe.saver/': module } });
    expect(t.plugins.status('probe.saver')?.state).toBe('active');
    // a WorkItem of the plugin writes its memento when it ends (terminate disposes its scope)
    const item = t.workItems.find('root/late-item');
    expect(item?.owner).toBe('probe.saver');
    const memento = item?.memento('state', counter);
    item?.scope.track(toDisposable(() => memento?.set(99)));
    await t.settle();
    const result = await drive(t, t.app.shutdown('close'));
    expect(result.vetoed).toBe(false);
    const saved = t.storage.snapshot('application');
    expect(saved['plugin:probe.saver:inDeactivate']).toEqual({ v: 1, data: 42 });
    expect(saved['plugin:probe.saver:late']).toEqual({ v: 1, data: 7 });
    expect(t.storage.snapshot('project')['workItem:root/late-item:state']).toEqual({ v: 1, data: 99 });
  });
});

describe('C13: the dispose step has a total budget (shutdown-dispose-step-unbounded)', () => {
  it('C13: a hung deactivate() and a hung Eventually contribution are listed in timedOut, and the shutdown ends', async () => {
    const never = new DeferredPromise<void>();
    const signals: AbortSignal[] = [];
    const module = {
      activate(ctx: PluginContext) {
        signals.push(ctx.signal);
      },
      deactivate: () => never.promise,
    };
    const hung: ServiceModule = {
      id: 'probe.hung',
      install({ window }) {
        window.provideMany(LifecycleContribution, () => ({ id: 'probe.hang', phase: LifecyclePhase.Eventually, run: () => new Promise<void>(() => undefined) }), { owner: 'probe' });
      },
    };
    const t = await createTestApp({
      plugins: [manifest('probe.hang-plugin')],
      modules: { 'test://probe.hang-plugin/': module },
      appModules: [hung],
      lifecycle: { disposeBudgetMs: 1000 },
    });
    await t.toEventually();
    const errors = captureErrors();
    const result = await drive(t, t.app.shutdown('close'));
    expect(result.vetoed).toBe(false);
    expect(result.timedOut).toContain('probe.hang-plugin');
    expect(result.timedOut).toContain('probe.hang');
    expect(signals[0]?.aborted).toBe(true); // the signal is aborted at the start of the step
    errors.drain();
    errors.dispose();
    never.resolve();
  });
});

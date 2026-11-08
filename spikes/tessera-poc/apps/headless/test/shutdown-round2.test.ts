import { describe, expect, it } from 'vitest';
import { DeferredPromise, toDisposable, type StateSchema } from '@tessera/base';
import { type PluginContext, WorkbenchService } from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin, type TestApp } from '@tessera/testing';

const counter: StateSchema<number> = { version: 1, schema: { safeParse: (d) => ({ success: true, data: d as number }) }, initial: () => 0 };
const text: StateSchema<string> = { version: 1, schema: { safeParse: (d) => ({ success: true, data: d as string }) }, initial: () => '' };

const manifest = (id: string, extra: object = {}): ReturnType<typeof describePlugin> =>
  describePlugin({ id, name: id, version: '1.0.0', publisher: 't', engines: { tessera: '^1.0.0' }, main: './m.js', activationEvents: ['*'], ...extra });

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

/** Runs a shutdown that waits for timers: advances the manual scheduler until the promise settles. */
async function drive<T>(t: TestApp, work: Promise<T>, stepMs = 25): Promise<T> {
  const state = { done: false };
  void work.finally(() => (state.done = true));
  for (let i = 0; i < 400 && !state.done; i++) {
    await ticks(200); // microtask-heavy steps cost no scheduler time in production; the manual clock must not run ahead of them
    t.scheduler.advance(stepMs);
  }
  return work;
}

describe('round 2: the dispose step reports failed keys and flushes after window disposers', () => {
  it('C13: a 2 MB value written in deactivate() cannot be stored: the result lists storage.flush in failed', async () => {
    let context: PluginContext | undefined;
    const module = {
      activate(ctx: PluginContext) {
        context = ctx;
      },
      deactivate() {
        context?.storage.application.set('big', 'x'.repeat(2_000_000), text);
      },
    };
    const t = await createTestApp({ plugins: [manifest('probe.big')], modules: { 'test://probe.big/': module } });
    const errors = captureErrors();
    const result = await drive(t, t.app.shutdown('close'));
    errors.drain();
    errors.dispose();
    expect(result.vetoed).toBe(false);
    expect(result.failed).toContain('storage.flush');
  });

  it('C13: a write by a window-scope disposer and by a WorkItem terminate() reaches the backend (final flush after window.dispose)', async () => {
    const module = {
      activate(ctx: PluginContext) {
        (ctx as unknown as { workItems: { create(id: string): unknown } }).workItems.create('late-item');
      },
    };
    const t = await createTestApp({ plugins: [manifest('probe.late')], modules: { 'test://probe.late/': module } });
    const item = t.workItems.find('root/late-item');
    const memento = item?.memento('state', counter);
    item?.scope.track(toDisposable(() => memento?.set(99)));
    // a window-scope disposer that writes straight into the storage service
    const storageService = t.storageService;
    t.window.track(toDisposable(() => storageService.set('application', 'written.by.window.disposer', 5)));
    await t.settle();
    const result = await drive(t, t.app.shutdown('close'));
    expect(result.failed).toBeUndefined();
    expect(t.storage.snapshot('application')['written.by.window.disposer']).toBe(5);
    expect(t.storage.snapshot('project')['workItem:root/late-item:state']).toEqual({ v: 1, data: 99 });
  });
});

describe('round 2: deactivation in dependency waves with a share of the budget', () => {
  it('C13: a hung plugin does not starve the others: the saver value reaches the backend and the hung one is in timedOut', async () => {
    const never = new DeferredPromise<void>();
    let saver: PluginContext | undefined;
    const t = await createTestApp({
      plugins: [manifest('a.saver'), manifest('b.hang')],
      modules: {
        'test://a.saver/': { activate: (c: PluginContext) => void (saver = c), deactivate: () => void saver?.storage.application.set('saved', 7, counter) },
        'test://b.hang/': { activate: () => undefined, deactivate: () => never.promise },
      },
      lifecycle: { disposeBudgetMs: 2000 },
    });
    const errors = captureErrors();
    const result = await drive(t, t.app.shutdown('close'));
    errors.drain();
    errors.dispose();
    never.resolve();
    expect(t.storage.snapshot('application')['plugin:a.saver:saved']).toEqual({ v: 1, data: 7 });
    expect(result.timedOut).toContain('b.hang');
    expect(result.timedOut).not.toContain('a.saver');
  });

  it('C13: dependents deactivate before their providers (waves), and plugins of one wave run in parallel', async () => {
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    const mod = (id: string, wait?: Promise<void>) => ({ activate: () => undefined, deactivate: async () => { order.push(`${id}:start`); await wait; order.push(`${id}:end`); } });
    const t = await createTestApp({
      plugins: [
        manifest('p.base'),
        manifest('p.mid', { dependencies: { 'p.base': '^1.0.0' } }),
        manifest('p.leaf1', { dependencies: { 'p.mid': '^1.0.0' } }),
        manifest('p.leaf2', { dependencies: { 'p.mid': '^1.0.0' } }),
      ],
      modules: { 'test://p.base/': mod('base'), 'test://p.mid/': mod('mid'), 'test://p.leaf1/': mod('leaf1', gate.promise), 'test://p.leaf2/': mod('leaf2', gate.promise) },
    });
    const shutdown = t.app.shutdown('close');
    await ticks(300);
    expect(order).toEqual(expect.arrayContaining(['leaf1:start', 'leaf2:start']));
    expect(order).not.toContain('mid:start'); // the next wave waits for the leaves
    gate.resolve();
    await drive(t, shutdown);
    expect(order.indexOf('mid:start')).toBeGreaterThan(order.indexOf('leaf1:end'));
    expect(order.indexOf('base:start')).toBeGreaterThan(order.indexOf('mid:end'));
  });

  it('C13: when a hung disposer eats the budget, the next wave gets no deactivate() (notStarted) but is still cleaned up', async () => {
    const called: string[] = [];
    const t = await createTestApp({
      plugins: [manifest('q.base'), manifest('q.leaf', { dependencies: { 'q.base': '^1.0.0' } })],
      modules: {
        'test://q.base/': { activate: () => undefined, deactivate: () => void called.push('base') },
        'test://q.leaf/': {
          activate: (ctx: PluginContext) => {
            // a WorkItem whose scope has a disposer that never settles: terminate() hangs
            (ctx as unknown as { workItems: { create(id: string): unknown } }).workItems.create('hung-item');
          },
          deactivate: () => void called.push('leaf'),
        },
      },
      lifecycle: { disposeBudgetMs: 1000 },
    });
    const release = new DeferredPromise<void>();
    t.workItems.find('root/hung-item')?.scope.track({ dispose: () => release.promise });
    const errors = captureErrors();
    const result = await drive(t, t.app.shutdown('close'), 25); // fine steps: the chain after a timer needs a few microtask turns
    errors.drain();
    errors.dispose();
    expect(result.notStarted).toEqual(['q.base']);
    expect(called).toEqual(['leaf']);
    expect(t.window.state).toBe('disposed');
    release.resolve(); // let the abandoned disposer end, so nothing leaks
    await ticks(50);
  });
});

describe('round 2: shutdown during start() (one closing gate)', () => {
  it('C13: shutdown while mount() runs: start() returns quietly and nothing restores after the window is disposed', async () => {
    const mountGate = new DeferredPromise<void>();
    const t = await createTestApp({ start: false, plugins: [manifest('probe.early')], modules: { 'test://probe.early/': { activate: () => undefined } } });
    const errors = captureErrors();
    const started = t.app.start({ mount: () => mountGate.promise });
    await ticks(30);
    const shutdown = t.app.shutdown('close');
    await ticks(30);
    mountGate.resolve();
    const result = await drive(t, shutdown);
    await expect(started).resolves.toBeUndefined();
    expect(result.vetoed).toBe(false);
    expect(t.app.marks.has('restored')).toBe(false);
    expect(errors.drain()).toEqual([]);
    errors.dispose();
  });

  it('C13: shutdown before start(): start() does nothing and the scopes are disposed', async () => {
    const t = await createTestApp({ start: false });
    const result = await drive(t, t.app.shutdown('close'));
    expect(result.vetoed).toBe(false);
    await t.app.start({ mount: () => { throw new Error('mount must not run'); } });
    expect(t.window.state).toBe('disposed');
  });

  it('C13: shutdown while the workbench restores: start() ends at once and no Restored or Eventually phase runs', async () => {
    const t = await createTestApp({ start: false });
    const workbench = t.window.get(WorkbenchService);
    const gate = new DeferredPromise<void>();
    (workbench as unknown as { whenRestored: () => Promise<void> }).whenRestored = () => gate.promise;
    const started = t.app.start({ mount: () => undefined });
    await ticks(30);
    const shutdown = t.app.shutdown('close');
    const result = await drive(t, shutdown);
    await expect(started).resolves.toBeUndefined();
    expect(result.vetoed).toBe(false);
    expect(t.app.marks.has('restored')).toBe(false);
    gate.resolve();
  });

  it('C13: after the gate closes a plugin cannot activate (plugin.shuttingDown) and activation events start nothing', async () => {
    const t = await createTestApp({ plugins: [manifest('probe.lazy', { activationEvents: ['onCommand:lazy.run'] })], modules: { 'test://probe.lazy/': { activate: () => undefined } } });
    (t.plugins as unknown as { abortAll(): void }).abortAll();
    await expect(t.plugins.activate('probe.lazy')).rejects.toMatchObject({ code: 'plugin.shuttingDown' });
    await t.plugins.activateByEvent('onCommand:lazy.run');
    expect(t.plugins.status('probe.lazy')?.state).toBe('resolved');
  });
});

describe('round 2: modules and the one live application', () => {
  it('C23: a second createApplication in the same realm throws shell.secondApplication until the first is disposed', async () => {
    const t = await createTestApp({ start: false });
    await expect(createTestApp({ start: false })).rejects.toMatchObject({ code: 'shell.secondApplication' });
    await t.dispose();
    const again = await createTestApp({ start: false });
    await again.dispose();
  });

  it('C23: a module with an id that is already installed throws shell.duplicateModule; replaceModules swaps a core module; an unknown id throws shell.unknownModule', async () => {
    await expect(createTestApp({ start: false, appModules: [{ id: '@tessera/events', install: () => undefined }] })).rejects.toMatchObject({ code: 'shell.duplicateModule' });
    await expect(createTestApp({ start: false, replaceModules: [{ id: 'no.such.module', install: () => undefined }] })).rejects.toMatchObject({ code: 'shell.unknownModule' });
    let installed = false;
    const events = (await import('@tessera/events')).eventsModule;
    const t = await createTestApp({ start: false, replaceModules: [{ ...events, install: (ctx) => { installed = true; events.install(ctx); } }] });
    expect(installed).toBe(true);
    await t.dispose();
  });
});

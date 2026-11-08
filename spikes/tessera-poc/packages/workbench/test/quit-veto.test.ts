import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { type PluginContext } from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin } from '@tessera/testing';
import { listManifest, listProvider } from './kit.ts';

async function dirtyApp(canClose: () => boolean | Promise<boolean>, extra?: { onActivate?: (ctx: PluginContext) => void }) {
  const provider = listProvider();
  const wrapped = { ...provider, createPresenter: (ctx: Parameters<typeof provider.createPresenter>[0]) => ({ ...provider.createPresenter(ctx), canClose }) };
  const description = describePlugin(listManifest());
  const app = await createTestApp({
    plugins: [description],
    modules: { [description.location]: { activate: (ctx: PluginContext & { views: { registerProvider(p: unknown): void } }) => (ctx.views.registerProvider(wrapped), extra?.onActivate?.(ctx)) } },
  });
  return app;
}

describe('round 2: a dirty presenter vetoes the quit', () => {
  it('C13: presenter.canClose() false vetoes shutdown with the id placement:<id>; force ends the veto and the shutdown goes on', async () => {
    const app = await dirtyApp(() => false);
    const placement = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const vetoed = await app.app.shutdown('close');
    expect(vetoed.vetoed).toBe(true);
    expect(vetoed.vetoedBy).toEqual([`placement:${placement.id}`]);
    expect(app.window.state).toBe('active'); // nothing was torn down
    const forced = await app.app.shutdown('close', { force: true });
    expect(forced.vetoed).toBe(false);
  });

  it('C13: a clean presenter (canClose true) does not veto', async () => {
    const app = await dirtyApp(() => true);
    await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const result = await app.app.shutdown('close');
    expect(result.vetoed).toBe(false);
  });

  it('C13: placements are asked one at a time and the first false stops the walk', async () => {
    const asked: string[] = [];
    let n = 0;
    const app = await dirtyApp(() => {
      asked.push(`call${++n}`);
      return n < 2;
    });
    await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    await app.workbench.showView('fixture.list', { workspace: 'fixture.side' });
    await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const result = await app.app.shutdown('close');
    expect(result.vetoed).toBe(true);
    expect(result.vetoedBy).toHaveLength(1);
    expect(asked.length).toBeLessThanOrEqual(2); // the walk stopped at the first false
    await app.app.shutdown('close', { force: true });
  });

  it('C13: a pending canClose (a dialog) has no hard timeout: the veto stays pending until the user answers or force is sent', async () => {
    const dialog = new DeferredPromise<boolean>();
    const app = await dirtyApp(() => dialog.promise);
    await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    let settled = false;
    const result = app.app.shutdown('close').then((r) => ((settled = true), r));
    app.scheduler.advance(60_000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(settled).toBe(false);
    dialog.resolve(true);
    expect((await result).vetoed).toBe(false);
  });

  it('C13: a throwing canClose vetoes and is reported', async () => {
    const app = await dirtyApp(() => {
      throw new Error('canClose broke');
    });
    await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const errors = captureErrors();
    const result = await app.app.shutdown('close');
    errors.drain();
    errors.dispose();
    expect(result.vetoed).toBe(true);
    await app.app.shutdown('close', { force: true });
  });

  it('C13: a plugin registers a quit veto through ctx.lifecycle.onBeforeShutdown (id plugin:<id>); it is removed when the plugin deactivates', async () => {
    let dirty = true;
    const app = await dirtyApp(() => true, { onActivate: (ctx) => void ctx.lifecycle.onBeforeShutdown((e) => e.veto(dirty)) });
    await app.plugins.activate('fixture.view');
    const first = await app.app.shutdown('close');
    expect(first.vetoed).toBe(true);
    expect(first.vetoedBy).toEqual(['plugin:fixture.view']);
    dirty = false;
    expect((await app.app.shutdown('close')).vetoed).toBe(false);
  });

  it('C13: the plugin veto is gone after the plugin deactivates (tracked registration)', async () => {
    const app = await dirtyApp(() => true, { onActivate: (ctx) => void ctx.lifecycle.onBeforeShutdown((e) => e.veto(true)) });
    await app.plugins.activate('fixture.view');
    expect((await app.app.shutdown('close')).vetoed).toBe(true);
    await app.plugins.deactivate('fixture.view');
    const result = await app.app.shutdown('close');
    expect(result.vetoed).toBe(false);
  });
});

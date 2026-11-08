import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { state } from '@tessera/reactive';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';
import { listApp } from './kit.ts';

async function ticks(count = 30): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe('round 2: a terminated WorkItem ends the placements of its instances', () => {
  it('C20: terminating the owner WorkItem closes both placements of one instance, releases the instance, and keeps the local state for a later restore', async () => {
    const app = await listApp();
    const item = app.workItems.root.createChild('use-case');
    const a = await app.workbench.showView('fixture.list', { workItem: item, workspace: 'workbench.editorArea' });
    const b = await app.workbench.showView('fixture.list', { workItem: item, workspace: 'fixture.side' });
    expect(b.instanceId).toBe(a.instanceId);
    expect(app.workbench.instance(a.instanceId)?.refCount).toBe(2);
    await item.terminate();
    await app.settle();
    await ticks();
    expect(app.workbench.placement(a.id)).toBeUndefined();
    expect(app.workbench.placement(b.id)).toBeUndefined();
    expect(app.workbench.instance(a.instanceId)).toBeUndefined();
  });
});

describe('round 2: a view instance is not live twice (Retiring)', () => {
  const hungManifest = () =>
    manifest('fx.view', {
      contributes: {
        workspaces: [{ id: 'fx.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }],
        views: [{ id: 'fx.v', title: 'V', workspace: 'fx.side', visibleByDefault: false, retain: 'none' }],
      },
    } as never);

  async function boot(log: string[], gate: DeferredPromise<void>) {
    const description = describePlugin(hungManifest());
    let n = 0;
    return createTestApp({
      plugins: [description],
      modules: {
        [description.location]: {
          activate(ctx: { views: { registerProvider(p: unknown): void } }) {
            ctx.views.registerProvider({
              viewType: 'fx.v',
              sharedState: { version: 1, schema: { safeParse: (i: unknown) => ({ success: true, data: i }) }, initial: () => ({ count: 0 }) },
              createViewModel: () => {
                const id = ++n;
                log.push(`vm${id}`);
                return {
                  dispose: async () => {
                    log.push(`dispose-start${id}`);
                    await gate.promise;
                    log.push(`dispose-end${id}`);
                  },
                };
              },
              createPresenter: () => ({ viewState: state(1), intents: {}, dispose: () => undefined }),
            });
          },
        },
      },
    });
  }

  it('C20: reopening an instance whose view model still disposes waits for the dispose: vm1, dispose-start1, dispose-end1, then vm2', async () => {
    const log: string[] = [];
    const gate = new DeferredPromise<void>();
    const app = await boot(log, gate);
    const first = await app.workbench.showView('fx.v', { workspace: 'workbench.editorArea' });
    await app.workbench.close(first.id);
    await app.settle();
    expect(log).toEqual(['vm1', 'dispose-start1']);
    const again = app.workbench.showView('fx.v', { workspace: 'workbench.editorArea' });
    await ticks();
    expect(log).toEqual(['vm1', 'dispose-start1']); // no second view model while the first one disposes
    gate.resolve();
    const placement = await again;
    await app.settle();
    expect(log).toEqual(['vm1', 'dispose-start1', 'dispose-end1', 'vm2']);
    expect(app.workbench.instance(placement.instanceId)).toBeDefined();
  });

  it('C20: a view model whose dispose never settles is cut off after 5 s (di.disposeTimeout); a double close does not dispose twice, and the view opens again', async () => {
    const log: string[] = [];
    const never = new DeferredPromise<void>();
    const app = await boot(log, never);
    const errors = captureErrors();
    const first = await app.workbench.showView('fx.v', { workspace: 'workbench.editorArea' });
    const closing = [app.workbench.close(first.id), app.workbench.close(first.id)];
    await Promise.all(closing);
    await app.settle();
    expect(log.filter((l) => l.startsWith('dispose-start'))).toHaveLength(1);
    const again = app.workbench.showView('fx.v', { workspace: 'workbench.editorArea' });
    await ticks();
    app.scheduler.advance(5000);
    await app.settle();
    await ticks();
    const placement = await again;
    expect(log.filter((l) => l.startsWith('vm'))).toEqual(['vm1', 'vm2']);
    expect(errors.drain().map((r) => (r.error as { code?: string }).code)).toContain('di.disposeTimeout');
    errors.dispose();
    expect(app.workbench.placement(placement.id)).toBeDefined();
    never.resolve();
    await ticks();
  });
});

import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { state } from '@tessera/reactive';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';

async function ticks(count = 50): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe('view-instance-overlap-on-retire: a reload with a slow presenter dispose never overlaps two view models', () => {
  it('the old presenter and view model end before the new view model is created, and no presenter sits on the old view model', async () => {
    const description = describePlugin(
      manifest('fx.view', {
        contributes: {
          workspaces: [{ id: 'fx.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }],
          views: [{ id: 'fx.v', title: 'V', workspace: 'fx.side', visibleByDefault: false }],
        },
      }),
      'dev',
    );
    const events: string[] = [];
    const gate = new DeferredPromise<void>();
    let vmCount = 0;
    const module = {
      activate(ctx: { views: { registerProvider(p: unknown): void } }) {
        ctx.views.registerProvider({
          viewType: 'fx.v',
          sharedState: { version: 1, schema: { safeParse: (i: unknown) => ({ success: true, data: i }) }, initial: () => ({}) },
          createViewModel: () => {
            const id = ++vmCount;
            events.push(`vm${id} created`);
            return { id, dispose: () => void events.push(`vm${id} disposed`) };
          },
          createPresenter: (c: { viewModel: { id: number } }) => {
            events.push(`presenter on vm${c.viewModel.id}`);
            return {
              viewState: state(1),
              intents: {},
              dispose: async () => {
                events.push('presenter dispose start');
                await gate.promise;
                events.push('presenter dispose end');
              },
            };
          },
        });
      },
    };
    const errors = captureErrors();
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: module } });
    const placement = await app.workbench.showView('fx.v', { workspace: 'workbench.editorArea' });
    await app.settle();
    const reload = app.plugins.reload('fx.view');
    await ticks();
    events.push('--- gate released');
    gate.resolve();
    await reload.catch((e: Error) => events.push(`reload error ${e.message}`));
    await app.settle();
    await ticks();
    await app.settle();
    const at = (name: string): number => events.indexOf(name);
    expect(at('presenter dispose end')).toBeGreaterThan(-1);
    expect(at('vm2 created')).toBeGreaterThan(at('presenter dispose end')); // no overlap
    expect(at('vm2 created')).toBeGreaterThan(at('vm1 disposed'));
    expect(events.filter((e) => e === 'presenter on vm1')).toHaveLength(1); // only the first presenter sits on vm1
    expect(events).toContain('presenter on vm2'); // the placement came back on the new view model
    expect(app.workbench.placement(placement.id)?.status.peek()).toBe('attached');
    errors.drain();
    errors.dispose();
  });
});

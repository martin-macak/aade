import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, type PluginContext } from '@tessera/contracts';
import { state } from '@tessera/reactive';
import { createTestApp, describePlugin, manifest } from '@tessera/testing';

const scrollSchema = { version: 1, schema: { safeParse: (d: unknown) => ({ success: true as const, data: d as { scrolled: number } }) }, initial: () => ({ scrolled: 0 }) };
const sharedSchema = { version: 1, schema: { safeParse: (d: unknown) => ({ success: true as const, data: d as { filter: string } }) }, initial: () => ({ filter: '' }) };

const description = describePlugin(
  manifest('fixture.scroller', {
    activationEvents: ['*'],
    contributes: { views: [{ id: 'fixture.scrolled', title: 'Scrolled', workspace: 'workbench.editorArea', visibleByDefault: false }] },
  }),
  'builtin',
);

describe('view-state-edits-not-saved-open-data-loss: an edit of view state schedules a layout save', () => {
  it('a scroll position (placement local state) and a filter (shared state) reach the backend 2 s after the edit', async () => {
    const edits: { scroll?: (n: number) => void; filter?: (v: string) => void } = {};
    const module = {
      activate(ctx: PluginContext & { views: { registerProvider(p: unknown): void } }) {
        ctx.views.registerProvider({
          viewType: 'fixture.scrolled',
          sharedState: sharedSchema,
          localState: scrollSchema,
          createViewModel: () => ({}),
          createPresenter: (p: { local: { set(v: { scrolled: number }): void }; viewModel: object; instance?: unknown }) => {
            edits.scroll = (n) => p.local.set({ scrolled: n });
            return { viewState: state({}).asReadonly(), intents: {}, dispose: () => undefined };
          },
        });
      },
    };
    const t = await createTestApp({ plugins: [description], modules: { [description.location]: module } });
    const placement = await t.workbench.showView('fixture.scrolled', { workspace: 'workbench.editorArea' });
    await t.settle();
    await t.advance(2500); // the layout from opening the view is written
    const before = t.storage.writes.length;
    edits.scroll?.(321);
    await t.advance(2500);
    expect(t.storage.writes.length).toBeGreaterThan(before);
    const stored = t.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: { placements: Record<string, { local?: { data: { scrolled: number } } }> } };
    expect(stored.data.placements[placement.id]?.local?.data.scrolled).toBe(321);
    // the shared state of the view instance
    const live = t.workbench.instance(placement.instanceId) as unknown as { shared: { set(v: { filter: string }): void } };
    live.shared.set({ filter: 'abc' });
    await t.advance(2500);
    const storedAgain = t.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: { instances: Record<string, { shared?: { data: { filter: string } } }> } };
    expect(Object.values(storedAgain.data.instances).some((i) => i.shared?.data.filter === 'abc')).toBe(true);
  });
});

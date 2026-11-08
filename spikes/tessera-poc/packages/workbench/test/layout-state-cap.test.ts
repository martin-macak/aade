import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, LayoutStore, type PluginContext } from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin } from '@tessera/testing';
import { MAX_VIEW_STATE_BYTES } from '@tessera/workbench';
import { listManifest, listProvider, type ListIntents } from './kit.ts';

describe('round 2: one big view state cannot veto the whole layout save', () => {
  it('C21: a 1.2 MB shared state is left out and reported once; the layout with three views is saved', async () => {
    const provider = listProvider();
    const description = describePlugin(listManifest());
    const app = await createTestApp({
      plugins: [description],
      modules: { [description.location]: { activate: (ctx: PluginContext & { views: { registerProvider(p: unknown): void } }) => ctx.views.registerProvider(provider) } },
    });
    const errors = captureErrors();
    const a = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const b = await app.workbench.showView('fixture.list', { workspace: 'fixture.side' });
    const c = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea', reuse: 'new' });
    expect(new Set([a.id, b.id, c.id]).size).toBeGreaterThanOrEqual(2);
    const intents = app.workbench.placement(a.id)?.presenter?.intents as ListIntents | undefined;
    intents?.select('x'.repeat(1_200_000));
    const layout = app.window.get(LayoutStore);
    await layout.flush();
    const stored = app.storage.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: { placements: Record<string, unknown>; instances: Record<string, { shared?: unknown }> } } | undefined;
    expect(stored).toBeDefined(); // the save was not vetoed by the 1 MB key limit
    const placements = Object.keys(stored?.data.placements ?? {});
    for (const id of [a.id, b.id, c.id]) expect(placements).toContain(id);
    const instance = stored?.data.instances[a.instanceId];
    expect(instance?.shared === undefined || JSON.stringify(instance.shared).length < MAX_VIEW_STATE_BYTES).toBe(true);
    await layout.flush(); // saving again works: the big state is skipped every time, reported once
    const reported = errors.drain().filter((r) => (r.error as { code?: string }).code === 'layout.viewStateTooLarge');
    errors.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context.pluginId).toBe('fixture.view');
  });
});

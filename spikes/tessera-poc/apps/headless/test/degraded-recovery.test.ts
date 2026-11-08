import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, LayoutStore, PLUGINS_DISABLED_STORAGE_KEY, StorageService, type PluginContext } from '@tessera/contracts';
import { memoryStorageBackend } from '@tessera/persistence';
import { computed, state } from '@tessera/reactive';
import { captureErrors, createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function drive<T>(t: { readonly scheduler: { advance(ms: number): void } }, work: Promise<T>, stepMs = 100): Promise<T> {
  const progress = { done: false };
  void work.finally(() => (progress.done = true));
  for (let i = 0; i < 200 && !progress.done; i++) {
    await ticks(30);
    t.scheduler.advance(stepMs);
  }
  return work;
}

const unit = { version: 1, schema: { safeParse: (d: unknown) => ({ success: true as const, data: d }) }, initial: () => ({}) };
/** A view with no state worth saving: only its placement matters here. */
const listProvider = () => ({
  viewType: 'fixture.list',
  sharedState: unit,
  localState: unit,
  createViewModel: () => ({}),
  createPresenter: () => ({ viewState: computed(() => ({ rows: state<readonly string[]>([]).get() })), intents: {}, dispose: () => undefined }),
});

const viewManifest = () =>
  manifest('fixture.view', {
    activationEvents: ['*'],
    contributes: {
      workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }],
      views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.side', visibleByDefault: false }],
    },
  });

describe('round 2: Retry after degraded mode does not overwrite the stored state', () => {
  it('C22: the stored layout and the disabled plugin list come back; the session defaults are kept as .bak.degraded', async () => {
    // 1. a normal session leaves a layout (a view in the editor area) and a disabled plugin on the backend
    const description = describePlugin(viewManifest());
    const other = describePlugin(manifest('fixture.other', { activationEvents: ['*'] }));
    const modules = { [description.location]: { activate: (ctx: PluginContext & { views: { registerProvider(p: unknown): void } }) => ctx.views.registerProvider(listProvider()) }, [other.location]: { activate: () => undefined } };
    const first: TestApp = await createTestApp({ plugins: [description, other], modules });
    await first.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    await first.plugins.disable('fixture.other');
    await first.window.get(LayoutStore).flush();
    await first.window.get(StorageService).flush();
    const stored = first.storage;
    expect((stored.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: { placements: object } }).data.placements).not.toEqual({});
    const keep = { project: stored.snapshot('project'), application: stored.snapshot('application') };
    await first.dispose();

    // 2. the next session cannot read the storage (the load fails), so it runs degraded
    const inner = memoryStorageBackend(keep);
    let failing = true;
    const flaky = { ...inner, load: (scope: 'application' | 'project') => (failing ? Promise.reject(new Error('disk offline')) : inner.load(scope)), write: inner.write.bind(inner), onDidChangeExternally: inner.onDidChangeExternally };
    const errors = captureErrors();
    const t = await createTestApp({ plugins: [description, other], modules, host: { storage: flaky as never }, start: false });
    await drive(t, t.app.start({ mount: () => undefined }));
    await t.settle();
    const storage = t.window.get(StorageService);
    expect(storage.degraded.peek()).toBe(true);
    expect(t.plugins.status('fixture.other')?.state).toBe('active'); // the list was unreadable: started enabled
    expect(Object.values(t.workbench.state.peek().placements).filter((p) => p.viewType === 'fixture.list')).toHaveLength(0); // the default layout

    // 3. the backend works again and the user presses Retry
    failing = false;
    expect(await storage.retryLoad()).toBe(true);
    await drive(t, t.settle());
    await t.settle();
    // the disabled list is applied again, the stored layout is rebuilt
    expect(t.plugins.status('fixture.other')?.state).toBe('disabled');
    const placements = Object.values(t.workbench.state.peek().placements).filter((p) => p.viewType === 'fixture.list');
    expect(placements).toHaveLength(1);
    expect(placements[0]?.workspaceId).toBe('workbench.editorArea');
    await storage.flush();
    expect((inner.snapshot('application')[PLUGINS_DISABLED_STORAGE_KEY] as { data: string[] }).data).toEqual(['fixture.other']);
    const layout = inner.snapshot('project')[LAYOUT_STORAGE_KEY] as { data: { placements: Record<string, { viewType: string }> } };
    expect(Object.values(layout.data.placements).some((p) => p.viewType === 'fixture.list')).toBe(true);
    errors.drain();
    errors.dispose();
  });
});

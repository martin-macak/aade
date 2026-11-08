import { describe, expect, it } from 'vitest';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';
import { UiModuleLoader } from '../src/index.ts';

// Round 2 (react-adapter-owns-plugin-ui-loading): the loading, caching and invalidation of plugin UI modules is renderer-independent.
const description = describePlugin(
  manifest('test.ui', {
    activationEvents: ['*'],
    ui: { react: './ui-react.js', lit: './ui-lit.js' },
    contributes: { views: [{ id: 'a', title: 'A', workspace: 'workbench.editorArea', visibleByDefault: false }] },
  } as never),
  'builtin',
);
// another plugin owns the view type 'owned.elsewhere'
const other = describePlugin(manifest('test.other', { contributes: { views: [{ id: 'owned.elsewhere', title: 'Other', workspace: 'workbench.editorArea', visibleByDefault: false }] } }), 'builtin');

async function boot(uiFor: (renderer: string) => unknown, loadTimeoutMs?: number, load?: () => Promise<unknown>) {
  let imports = 0;
  const app = await createTestApp({
    plugins: [description, other],
    modules: {
      [description.location]: { activate: () => undefined },
      [other.location]: { activate: () => undefined },
      [`${description.location}#react`]: () => {
        imports++;
        return load ? load() : uiFor('react');
      },
      [`${description.location}#lit`]: () => uiFor('lit'),
    },
  });
  const loader = new UiModuleLoader(app.window, loadTimeoutMs === undefined ? undefined : { loadTimeoutMs });
  return { app, loader, imports: () => imports };
}

describe('@tessera/dom: UiModuleLoader', () => {
  it('loads the entry once for concurrent callers and caches it', async () => {
    const { loader, imports } = await boot(() => ({ rendererId: 'react', views: [{ viewType: 'a' }] }));
    const [first, second] = await Promise.all([loader.loadUi('test.ui', 'react'), loader.loadUi('test.ui', 'react')]);
    expect(first).toBe(second);
    expect(first?.views).toEqual([{ viewType: 'a' }]);
    await loader.loadUi('test.ui', 'react');
    expect(imports()).toBe(1);
    loader.dispose();
  });

  it('accepts a module as the default export, and returns undefined for a plugin or renderer without an entry', async () => {
    const { loader } = await boot(() => ({ default: { rendererId: 'react', views: [] } }));
    expect((await loader.loadUi('test.ui', 'react'))?.rendererId).toBe('react');
    expect(await loader.loadUi('test.ui', 'solid')).toBeUndefined(); // the manifest has no ui.solid
    expect(await loader.loadUi('no.such.plugin', 'react')).toBeUndefined();
    loader.dispose();
  });

  it('reports a module of the wrong renderer once and lets a later call retry', async () => {
    const errors = captureErrors();
    let good = false;
    const { loader, imports } = await boot(() => (good ? { rendererId: 'react', views: [] } : { rendererId: 'lit', views: [] }));
    expect(await loader.loadUi('test.ui', 'react')).toBeUndefined();
    expect(errors.drain().map((e) => e.context.source)).toEqual(['view']);
    good = true;
    expect((await loader.loadUi('test.ui', 'react'))?.rendererId).toBe('react');
    expect(imports()).toBe(2);
    errors.dispose();
    loader.dispose();
  });

  it('forgets the module when the plugin deactivates, fires onDidForget, and imports the entry again on the next call', async () => {
    const { app, loader, imports } = await boot(() => ({ rendererId: 'react', views: [] }));
    const forgotten: string[] = [];
    loader.onDidForget((owner) => void forgotten.push(owner));
    await loader.loadUi('test.ui', 'react');
    await app.plugins.deactivate('test.ui');
    expect(forgotten).toEqual(['test.ui']);
    await app.plugins.activate('test.ui');
    await loader.loadUi('test.ui', 'react');
    expect(imports()).toBe(2);
    loader.dispose();
  });

  it('accepts only the views of view types the plugin owns: a foreign view type is reported once and skipped (view.uiForeignViewType)', async () => {
    const errors = captureErrors();
    const { loader } = await boot(() => ({ rendererId: 'react', views: [{ viewType: 'owned.elsewhere' }, { viewType: 'a' }, { viewType: 'never.declared' }] }));
    const module = await loader.loadUi('test.ui', 'react');
    expect(module?.views).toEqual([{ viewType: 'a' }]);
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toEqual(['view.uiForeignViewType', 'view.uiForeignViewType']);
    await loader.loadUi('test.ui', 'react'); // cached: no second report
    expect(errors.drain()).toHaveLength(0);
    loader.dispose();
  });

  it('forget() during a pending load: the stale result delivers nothing, and a failed stale load keeps the newer entry', async () => {
    const errors = captureErrors();
    const gates: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
    const { loader, imports } = await boot(
      () => undefined,
      undefined,
      () => new Promise((resolve, reject) => void gates.push({ resolve, reject })),
    );
    const first = loader.loadUi('test.ui', 'react');
    for (let i = 0; i < 20 && gates.length < 1; i++) await Promise.resolve();
    loader.forget('test.ui');
    const second = loader.loadUi('test.ui', 'react'); // a newer load starts
    for (let i = 0; i < 20 && gates.length < 2; i++) await Promise.resolve();
    expect(imports()).toBe(2);
    gates[0]?.resolve({ rendererId: 'react', views: [{ viewType: 'a' }] });
    expect(await first).toBeUndefined(); // stale
    gates[1]?.resolve({ rendererId: 'react', views: [{ viewType: 'a' }] });
    expect((await second)?.views).toEqual([{ viewType: 'a' }]);
    // a stale load that fails does not delete the entry of the newer load
    const stale = loader.loadUi('test.ui', 'react');
    void stale;
    loader.forget('test.ui');
    const newer = loader.loadUi('test.ui', 'react');
    for (let i = 0; i < 30 && gates.length < 4; i++) await Promise.resolve();
    gates[2]?.reject(new Error('stale failure'));
    await stale;
    expect(loader.loadUi('test.ui', 'react')).toBe(newer); // still the same cached promise
    gates[3]?.resolve({ rendererId: 'react', views: [] });
    await newer;
    errors.drain();
    loader.dispose();
  });

  it('a load that never settles ends after the bound: undefined, plugin.uiLoadTimeout reported, the cache dropped', async () => {
    const errors = captureErrors();
    const { app, loader, imports } = await boot(
      () => undefined,
      1000,
      () => new Promise(() => undefined),
    );
    const loading = loader.loadUi('test.ui', 'react');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    app.scheduler.advance(1000);
    expect(await loading).toBeUndefined();
    expect(errors.drain().map((e) => (e.error as { cause?: { code?: string }; code?: string }).code)).toEqual(['plugin.uiLoadTimeout']);
    void loader.loadUi('test.ui', 'react'); // retried: not cached
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(imports()).toBe(2);
    loader.dispose();
  });
});

import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { state } from '@tessera/reactive';
import { describePlugin, manifest } from '@tessera/testing';
import type { PluginModule, ViewProvider } from '@tessera/contracts';
import { defineReactUi, defineReactView } from '../src/index.ts';
import { renderCounterApp } from './app-kit.tsx';

// view-portals-rerender-all-views: opening, closing or focusing one view renders no other view.
const renders: Record<string, number> = { a: 0, b: 0 };

const countsManifest = manifest('test.counts', {
  ui: { react: './ui.js' },
  contributes: {
    workspaces: [
      { id: 'counts.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' },
      { id: 'counts.panel', title: 'Panel', kind: 'tabs', part: 'panel' },
    ],
    views: [
      { id: 'counts.a', title: 'A', workspace: 'counts.side', visibleByDefault: false },
      { id: 'counts.b', title: 'B', workspace: 'counts.panel', visibleByDefault: false },
    ],
  },
});

const provider = (viewType: string): ViewProvider => ({
  viewType,
  createPresenter: () => ({ viewState: state({ label: viewType }).asReadonly(), intents: {}, dispose: () => undefined }),
});

const module: PluginModule = {
  activate(ctx) {
    ctx.views.registerProvider(provider('counts.a'));
    ctx.views.registerProvider(provider('counts.b'));
  },
};

const ui = defineReactUi([
  defineReactView<{ label: string }, object>('counts.a', ({ state: s }) => (renders['a'] = (renders['a'] ?? 0) + 1, <p data-testid="view-a">{s.label}</p>)),
  defineReactView<{ label: string }, object>('counts.b', ({ state: s }) => (renders['b'] = (renders['b'] ?? 0) + 1, <p data-testid="view-b">{s.label}</p>)),
]);

describe('React binding: the cost of a change (view-portals-rerender-all-views)', () => {
  it('opening, focusing and closing one view renders 0 other views', async () => {
    renders['a'] = 0;
    renders['b'] = 0;
    const description = describePlugin(countsManifest);
    const view = await renderCounterApp({ extraPlugins: [description], extraModules: { [description.location]: module, [`${description.location}#react`]: ui } });
    let a!: Awaited<ReturnType<typeof view.app.workbench.showView>>;
    await act(async () => {
      a = await view.app.workbench.showView('counts.a');
    });
    await act(async () => {
      await view.app.settle();
    });
    expect(view.host.querySelector('[data-testid="view-a"]')).not.toBeNull();
    const afterA = renders['a'] ?? 0;
    expect(afterA).toBeGreaterThanOrEqual(1);

    // open B: A renders no more
    let b!: Awaited<ReturnType<typeof view.app.workbench.showView>>;
    await act(async () => {
      b = await view.app.workbench.showView('counts.b');
    });
    await act(async () => {
      await view.app.settle();
    });
    expect(view.host.querySelector('[data-testid="view-b"]')).not.toBeNull();
    expect(renders['a']).toBe(afterA);
    expect(renders['b']).toBeGreaterThanOrEqual(1);
    const afterB = renders['b'] ?? 0;

    // focus A, then B again: neither view renders
    await act(async () => {
      await view.app.workbench.activate(a.id, { focus: true });
      await view.app.workbench.activate(b.id, { focus: true });
      await view.app.settle();
    });
    expect(renders['a']).toBe(afterA);
    expect(renders['b']).toBe(afterB);

    // close B: A renders no more
    await act(async () => {
      await view.app.workbench.close(b.id);
      await view.app.settle();
    });
    expect(view.host.querySelector('[data-testid="view-b"]')).toBeNull();
    expect(renders['a']).toBe(afterA);
    view.unmount();
  });
});

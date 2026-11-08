import { act } from '@testing-library/react';
import type { StateSchema } from '@tessera/base';
import type { PluginDescription, PluginManifest, PluginModule, ViewProvider, WindowId } from '@tessera/contracts';
import { computed, effect, state, type Observable, type State } from '@tessera/reactive';
import { createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';
import { createReactRenderer, defineReactUi, defineReactView, type ReactRenderer } from '../src/index.ts';

// A small "counter" plugin for the rendering tests: one view type with a shared counter (view model) and a per-placement note
// (local state), a command, a menu item, a context-key enablement, a status bar item. Its UI is a React view.

export interface CounterState {
  readonly count: number;
  readonly note: string;
  readonly positive: boolean;
}
export interface CounterIntents {
  increment(): void;
  setNote(note: string): void;
}

const ok = <T,>(data: T) => ({ success: true as const, data });
const bad = { success: false as const, error: { issues: [{ path: [] as string[], message: 'bad' }] } };
const noteSchema: StateSchema<{ readonly note: string }> = {
  version: 1,
  schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null && typeof (i as { note?: unknown }).note === 'string' ? ok(i as { note: string }) : bad) },
  initial: () => ({ note: '' }),
};
const sharedSchema: StateSchema<Record<string, never>> = { version: 1, schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null ? ok(i as Record<string, never>) : bad) }, initial: () => ({}) };

export function counterManifest(): PluginManifest {
  return manifest('test.counter', {
    ui: { react: './ui.js' },
    contributes: {
      commands: [
        { id: 'counter.increment', title: 'Increment Counter', category: 'Counter' },
        { id: 'counter.reset', title: 'Reset Counter', category: 'Counter', enablement: 'counter.positive' },
      ],
      menus: [
        { menu: 'commandPalette', command: 'counter.increment' },
        { menu: 'commandPalette', command: 'counter.reset' },
        { menu: 'view/title', command: 'counter.increment', group: 'navigation', order: 1, when: 'view == counter.view' },
        { menu: 'view/title', command: 'counter.reset', group: 'navigation', order: 2, when: 'view == counter.view' },
      ],
      workspaces: [{ id: 'counter.sidebar', title: 'Counter', kind: 'tabs', part: 'primarySideBar' }],
      views: [{ id: 'counter.view', title: 'Counter', workspace: 'counter.sidebar', visibleByDefault: false }, { id: 'counter.crash', title: 'Crash', workspace: 'counter.sidebar', visibleByDefault: false }],
      statusBar: [{ id: 'counter.status', alignment: 'left', text: 'Counter ready' }],
    },
  });
}

export interface CounterPlugin {
  readonly module: PluginModule;
  readonly count: State<number>;
}

export function counterPlugin(): CounterPlugin {
  const count = state(0, { name: 'test.counter.count' });
  const module: PluginModule = {
    activate(ctx) {
      ctx.api.commands.registerHandler('counter.increment', { run: () => void count.update((n) => n + 1) });
      ctx.api.commands.registerHandler('counter.reset', { run: () => void count.set(0) });
      const provider: ViewProvider<Observable<number>, CounterState, CounterIntents, Record<string, never>, { note: string }> = {
        viewType: 'counter.view',
        sharedState: sharedSchema,
        localState: noteSchema,
        createViewModel: () => count.asReadonly(),
        createPresenter: (p) => {
          const stop = effect(() => p.context.set('counter.positive', p.viewModel.get() > 0), { name: 'test.counter.key' });
          return {
            viewState: computed<CounterState>(() => ({ count: p.viewModel.get(), note: p.local.get().note, positive: p.viewModel.get() > 0 }), { name: 'test.counter.viewState' }),
            intents: { increment: () => void count.update((n) => n + 1), setNote: (note) => p.local.set({ note }) },
            dispose: () => stop.dispose(),
          };
        },
      };
      ctx.views.registerProvider(provider as ViewProvider);
      ctx.views.registerProvider({
        viewType: 'counter.crash',
        createPresenter: () => ({ viewState: state({ boom: true }).asReadonly(), intents: {}, dispose: () => undefined }),
      });
    },
  };
  return { module, count };
}

export function counterUi() {
  return defineReactUi([
    defineReactView<CounterState, CounterIntents>('counter.view', ({ state: s, intents }) => (
      <div className="counter">
        <output aria-label="count">{s.count}</output>
        <button type="button" onClick={() => intents.increment()}>
          plus
        </button>
        <input aria-label="note" value={s.note} onChange={(e) => intents.setNote(e.target.value)} />
      </div>
    )),
    defineReactView<{ boom: boolean }, object>('counter.crash', () => {
      throw new Error('crash in render');
    }),
  ]);
}

export interface RenderedApp {
  readonly app: TestApp;
  readonly renderer: ReactRenderer;
  readonly plugin: CounterPlugin;
  readonly host: HTMLElement;
  readonly description: PluginDescription;
  unmount(): void;
}

/** Boots the test app with the counter plugin and renders the workbench with the React renderer into the document. */
export async function renderCounterApp(options: { readonly strictMode?: boolean; readonly extraPlugins?: readonly PluginDescription[]; readonly extraModules?: Record<string, unknown> } = {}): Promise<RenderedApp> {
  const plugin = counterPlugin();
  const description = describePlugin(counterManifest());
  const app = await createTestApp({
    plugins: [description, ...(options.extraPlugins ?? [])],
    modules: { [description.location]: plugin.module, [`${description.location}#react`]: counterUi(), ...options.extraModules },
    start: false,
  });
  const renderer = createReactRenderer({ services: app.window, strictMode: options.strictMode ?? true, title: 'Test App' });
  const host = document.createElement('div');
  document.body.append(host);
  let mounted: { dispose(): void } | undefined;
  await app.app.start({
    mount: () => {
      act(() => {
        mounted = renderer.workbench.render(host, 'w-test' as WindowId);
      });
    },
  });
  await app.settle();
  await act(async () => {
    await Promise.resolve();
  });
  return {
    app,
    renderer,
    plugin,
    host,
    description,
    unmount() {
      act(() => mounted?.dispose());
      renderer.mounter.dispose();
      host.remove();
    },
  };
}

import type { StateSchema } from '@tessera/base';
import { DockSurfaceFactory, DockSurfaceHost, type PluginDescription, type PluginModule, type ViewProvider } from '@tessera/contracts';
import { computed, state, type State } from '@tessera/reactive';
import { createTestApp, describePlugin, manifest, plainDomMounter, type PlainDomMounter, type TestApp, type TestAppOptions } from '@tessera/testing';
import { dockviewSurfaceFactory, type DockviewSurface, type DockviewSurfaceFactory } from '../src/index.ts';

// A "notes" view for the dockview integration tests: any number of placements (reuse: 'new'), plain-text rendering
// through the test-only plain DOM mounter, so no React is involved. The dock surface is the real dockview in Chromium.

export const EDITOR = 'workbench.editorArea';

const ok = <T,>(data: T) => ({ success: true as const, data });
const objectSchema = <T,>(initial: T): StateSchema<T> => ({
  version: 1,
  schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null ? ok(i as T) : { success: false as const, error: { issues: [{ path: [] as string[], message: 'bad' }] } }) },
  initial: () => initial,
});

export interface NoteState {
  readonly text: string;
}

export function notesManifest(extra: { readonly canMove?: boolean } = {}) {
  return manifest('test.notes', {
    contributes: {
      views: [{ id: 'notes.view', title: 'Notes', workspace: EDITOR, visibleByDefault: false, ...(extra.canMove === undefined ? {} : { canMove: extra.canMove }) }],
    },
  });
}

export interface NotesPlugin {
  readonly module: PluginModule;
  readonly closable: State<boolean>;
  readonly text: State<string>;
}

export function notesPlugin(): NotesPlugin {
  const closable = state(true, { name: 'notes.closable' });
  const text = state('hello', { name: 'notes.text' });
  const module: PluginModule = {
    activate(ctx) {
      const provider: ViewProvider<State<string>, NoteState, object, object, object> = {
        viewType: 'notes.view',
        sharedState: objectSchema({}),
        localState: objectSchema({}),
        createViewModel: () => text,
        createPresenter: (p) => ({
          viewState: computed<NoteState>(() => ({ text: p.viewModel.get() }), { name: 'notes.viewState' }),
          intents: {},
          title: computed(() => `Notes: ${p.viewModel.get()}`, { name: 'notes.title' }),
          canClose: () => closable.peek(),
          dispose: () => undefined,
        }),
      };
      ctx.views.registerProvider(provider as ViewProvider);
    },
  };
  return { module, closable, text };
}

export interface DockApp {
  readonly app: TestApp;
  readonly factory: DockviewSurfaceFactory;
  readonly mounter: PlainDomMounter;
  readonly plugin: NotesPlugin;
  readonly host: HTMLElement;
  surface(): DockviewSurface;
  /** Lets the workbench, the surface and dockview settle (microtasks and one frame). */
  settle(): Promise<void>;
  detach(): void;
}

export async function createDockApp(options: { readonly canMove?: boolean; readonly storage?: TestAppOptions['storage']; readonly plugin?: NotesPlugin } = {}): Promise<DockApp> {
  const plugin = options.plugin ?? notesPlugin();
  const description: PluginDescription = describePlugin(notesManifest(options.canMove === undefined ? {} : { canMove: options.canMove }));
  const mounter = plainDomMounter();
  mounter.register('notes.view', (s) => `note: ${(s as NoteState).text}`);
  let factory!: DockviewSurfaceFactory;
  const app = await createTestApp({
    plugins: [description],
    modules: { [description.location]: plugin.module },
    dockSurfaces: false,
    ...(options.storage ? { storage: options.storage } : {}),
    appModules: [
      {
        id: 'test.dockview',
        install: ({ window }) => {
          factory = dockviewSurfaceFactory({ services: window });
          window.provideValue(DockSurfaceFactory, factory, { owner: 'test' });
          window.provideValue(DockSurfaceHost, factory, { owner: 'test' });
        },
      },
    ],
  });
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:600px;position:relative;';
  document.body.append(host);
  const attachment = factory.attach(EDITOR, host, mounter as never);
  const settle = async (): Promise<void> => {
    // Wait for what dockview does after a change, which is layout work on the next frame: two animation frames are the event to wait for,
    // not a guessed number of milliseconds. The workbench settles between the frames.
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    for (let i = 0; i < 3; i++) {
      await app.settle();
      await frame();
      await frame();
    }
    await app.settle();
  };
  await settle();
  return {
    app,
    factory,
    mounter,
    plugin,
    host,
    surface: () => factory.surface(EDITOR) as DockviewSurface,
    settle,
    detach() {
      attachment.dispose();
      host.remove();
    },
  };
}

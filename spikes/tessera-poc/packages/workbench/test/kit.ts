import { computed, state, type Observable, type State } from '@tessera/reactive';
import type { StateSchema } from '@tessera/base';
import type { PlacementRef, PluginModule, ViewProvider, PluginDescription, PluginManifest } from '@tessera/contracts';
import { createTestApp, describePlugin, manifest, type TestApp, type TestAppOptions } from '@tessera/testing';

// A tiny "list" view for the workbench tests: shared selection (view model), per-placement scroll (local state).

export interface ListShared {
  readonly selectedId: string | undefined;
}
export interface ListLocal {
  readonly scrollTop: number;
}
export interface ListState {
  readonly rows: readonly string[];
  readonly selectedId: string | undefined;
  readonly scrollTop: number;
}
export interface ListIntents {
  select(id: string): void;
  scrolled(top: number): void;
}

const ok = <T>(data: T) => ({ success: true as const, data });
const bad = { success: false as const, error: { issues: [{ path: [] as string[], message: 'bad' }] } };

export const listShared: StateSchema<ListShared> = {
  version: 1,
  schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null ? ok(i as ListShared) : bad) },
  initial: () => ({ selectedId: undefined }),
};
export const listLocal: StateSchema<ListLocal> = {
  version: 1,
  schema: { safeParse: (i: unknown) => (typeof i === 'object' && i !== null && typeof (i as ListLocal).scrollTop === 'number' ? ok(i as ListLocal) : bad) },
  initial: () => ({ scrollTop: 0 }),
};

export class ListViewModel {
  readonly rows: State<readonly string[]> = state<readonly string[]>(['a', 'b', 'c'], { name: 'list.rows' });
  readonly selectedId: Observable<string | undefined>;
  readonly #shared: State<ListShared>;
  constructor(shared: State<ListShared>) {
    this.#shared = shared;
    this.selectedId = computed(() => shared.get().selectedId, { name: 'list.selected' });
  }
  select(id: string): void {
    this.#shared.set({ selectedId: id });
  }
}

export function listProvider(log?: string[]): ViewProvider<ListViewModel, ListState, ListIntents, ListShared, ListLocal> {
  return {
    viewType: 'fixture.list',
    sharedState: listShared,
    localState: listLocal,
    createViewModel: (ctx) => {
      log?.push('viewModel');
      return new ListViewModel(ctx.shared);
    },
    createPresenter: (ctx) => {
      log?.push(`presenter ${ctx.placement.id}`);
      const viewState = computed<ListState>(() => ({ rows: ctx.viewModel.rows.get(), selectedId: ctx.viewModel.selectedId.get(), scrollTop: ctx.local.get().scrollTop }), { name: 'list.viewState' });
      return {
        viewState,
        intents: { select: (id) => ctx.viewModel.select(id), scrolled: (top) => ctx.local.set({ scrollTop: top }) },
        dispose: () => void log?.push(`dispose ${ctx.placement.id}`),
      };
    },
  };
}

export function listManifest(extra?: Partial<PluginManifest>): PluginManifest {
  return manifest('fixture.view', {
    contributes: {
      workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }],
      views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.side', visibleByDefault: false }],
    },
    ...extra,
  });
}

export function listModule(log?: string[]): PluginModule {
  return {
    activate(ctx) {
      log?.push('activate');
      ctx.views.registerProvider(listProvider(log) as ViewProvider);
    },
    deactivate() {
      log?.push('deactivate');
    },
  };
}

export async function listApp(options?: Partial<TestAppOptions> & { readonly log?: string[]; readonly manifest?: PluginManifest }): Promise<TestApp> {
  const m = options?.manifest ?? listManifest();
  const description: PluginDescription = describePlugin(m);
  return createTestApp({ plugins: [description], modules: { [description.location]: listModule(options?.log) }, ...options });
}

export async function showTwice(app: TestApp): Promise<{ side: PlacementRef; dock: PlacementRef }> {
  const side = await app.workbench.showView('fixture.list');
  const dock = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
  return { side, dock };
}

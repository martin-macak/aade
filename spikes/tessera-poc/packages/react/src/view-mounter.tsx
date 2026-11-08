import { createElement, memo, StrictMode, useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { TesseraError, toDisposable, type IDisposable } from '@tessera/base';
import { ViewRegistry, type MountTarget, type RendererId, type ViewMounter } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { UiModuleLoader, markPlacementHost } from '@tessera/dom';
import { DefaultErrorFallback, PlacementBoundary, type ErrorFallback } from './boundary.tsx';
import { ViewContextContext } from './contexts.ts';
import { REACT_RENDERER_ID, type ReactViewDefinition } from './define.ts';
import { ViewHub, type MountedView } from './hub.ts';
import { toViewUiContext } from './ui-context.ts';
import { useObservable } from './use-observable.ts';

function PlacementView({ definition, target }: { readonly definition: ReactViewDefinition | undefined; readonly target: MountTarget }): ReactElement {
  // exactly one useSyncExternalStore subscription per mounted placement (contracts.md 18.2 rule 1)
  const state = useObservable(target.presenter.viewState);
  // the component prop is the narrowed, render-only context; the chrome keeps the full ViewContext through ViewContextContext
  const uiContext = useMemo(() => toViewUiContext(target.context), [target.context]);
  if (!definition) throw new Error(`No React view is registered for "${target.placement.viewType}".`);
  return (
    <ViewContextContext value={target.context}>
      {createElement(definition.component, { state: state as never, intents: target.presenter.intents as never, context: uiContext })}
    </ViewContextContext>
  );
}

interface PortalsProps {
  readonly hub: ViewHub;
  readonly lookup: (viewType: string) => ReactViewDefinition | undefined;
  readonly errorFallback: ErrorFallback;
}

/**
 * One mounted view in its portal. Memoized on the hub entry (its identity never changes) and two props that are stable for the life of
 * the root, so opening, closing or moving one view renders none of the others (react-binding.md, cost model).
 */
const PortalEntry = memo(function PortalEntry({ entry, lookup, errorFallback }: { readonly entry: MountedView; readonly lookup: PortalsProps['lookup']; readonly errorFallback: ErrorFallback }): ReactElement {
  return createPortal(
    <PlacementBoundary context={entry.target.context} fallback={errorFallback}>
      <PlacementView definition={lookup(entry.target.placement.viewType)} target={entry.target} />
    </PlacementBoundary>,
    entry.host,
    String(entry.key),
  );
});

/** Renders every mounted view through a portal into its host element (contracts.md 18.2 rule 6). */
export function ViewPortals({ hub, lookup, errorFallback }: PortalsProps): ReactElement {
  const entries = useSyncExternalStore(hub.subscribe, hub.getSnapshot, hub.getSnapshot);
  return (
    <>
      {entries.map((entry: MountedView) => (
        <PortalEntry key={entry.key} entry={entry} lookup={lookup} errorFallback={errorFallback} />
      ))}
    </>
  );
}

export interface ReactViewMounterOptions {
  /** The window DI scope. Used to find the view owner, the plugin catalog and the plugin loader. */
  readonly services: ScopeReader;
  readonly errorFallback?: ErrorFallback;
  /** Wrap the fallback root in StrictMode. The WorkbenchRenderer root follows its own option. */
  readonly strictMode?: boolean;
}

/**
 * The ViewMounter of the React adapter (contracts.md 18.1). It loads `ui.react` entries of plugins (ensureUi), keeps
 * their view definitions, and mounts a view by adding it to the ViewHub. The hub is drawn by one React root: the
 * WorkbenchRenderer's root, or (when no workbench renderer runs, for example in a plain test) a fallback root that the
 * mounter creates on first use and drops when the last view is gone.
 */
export class ReactViewMounter implements ViewMounter<HTMLElement>, IDisposable {
  readonly rendererId: RendererId = REACT_RENDERER_ID;
  readonly hub: ViewHub = new ViewHub();
  readonly errorFallback: ErrorFallback;
  readonly #services: ScopeReader;
  readonly #strict: boolean;
  /** View type -> its definition and where it came from: 'static' (register(): the app's own bundle) or the plugin id whose ui entry defined it. */
  readonly #definitions = new Map<string, { readonly definition: ReactViewDefinition; readonly source: string }>();
  /** Loading, caching and invalidation of plugin UI modules are renderer-independent (@tessera/dom). This class only maps modules to definitions. */
  readonly #loader: UiModuleLoader;
  /** The view types that each plugin's ui entry defined (dropped when the plugin ends, so a reload imports the entry again). */
  readonly #loadedBy = new Map<string, string[]>();
  readonly #subscription: IDisposable;
  #fallback: { readonly root: Root } | undefined;
  #disposed = false;

  constructor(options: ReactViewMounterOptions) {
    this.#services = options.services;
    this.errorFallback = options.errorFallback ?? DefaultErrorFallback;
    this.#strict = options.strictMode === true;
    this.#loader = new UiModuleLoader(options.services);
    // The loader forgets a plugin's module when the plugin ends: the definitions taken from it go too, and the next ensureUi imports it again.
    this.#subscription = this.#loader.onDidForget((owner) => this.#dropDefinitions(owner));
  }

  /** Drops the ui entry of a plugin (the view definitions it loaded). Definitions from register() stay. */
  forgetUi(owner: string): void {
    this.#loader.forget(owner);
    this.#dropDefinitions(owner);
  }

  /** Deletes only the entries that came from this owner's ui entry: a definition of another source for the same view type stays. */
  #dropDefinitions(owner: string): void {
    for (const viewType of this.#loadedBy.get(owner) ?? []) if (this.#definitions.get(viewType)?.source === owner) this.#definitions.delete(viewType);
    this.#loadedBy.delete(owner);
  }

  /**
   * Registers view definitions directly (tests, or an app that ships views in its own bundle). A static definition outranks a plugin's.
   * A second static definition for a view type throws `view.duplicateDefinition`.
   */
  register(definitions: readonly ReactViewDefinition[]): IDisposable {
    for (const d of definitions) {
      if (this.#definitions.get(d.viewType)?.source === 'static') {
        throw new TesseraError('view.duplicateDefinition', `A React view definition for "${d.viewType}" is registered already`, { details: { viewType: d.viewType } });
      }
    }
    for (const d of definitions) this.#definitions.set(d.viewType, { definition: d, source: 'static' });
    return toDisposable(() => {
      for (const d of definitions) if (this.#definitions.get(d.viewType)?.definition === d) this.#definitions.delete(d.viewType);
    });
  }

  definition(viewType: string): ReactViewDefinition | undefined {
    return this.#definitions.get(viewType)?.definition;
  }

  canMount(viewType: string): boolean {
    return this.#definitions.has(viewType);
  }

  async ensureUi(viewType: string): Promise<boolean> {
    if (this.#definitions.has(viewType)) return true;
    const owner = this.#services.get(ViewRegistry, { optional: true })?.descriptor(viewType)?.owner;
    if (!owner || owner === 'core') return false;
    const module = await this.#loader.loadUi(owner, REACT_RENDERER_ID);
    if (module) {
      // The loader already dropped the views of view types the plugin does not own. An entry of another source is never replaced:
      // a static definition stays, and so does a definition that another plugin's ui entry took.
      const loadedViews: string[] = [];
      for (const view of module.views as readonly ReactViewDefinition[]) {
        if (this.#definitions.has(view.viewType)) continue;
        this.#definitions.set(view.viewType, { definition: view, source: owner });
        loadedViews.push(view.viewType);
      }
      this.#loadedBy.set(owner, [...(this.#loadedBy.get(owner) ?? []), ...loadedViews]);
    }
    return this.#definitions.has(viewType);
  }

  mount(host: HTMLElement, target: MountTarget): IDisposable {
    if (this.#disposed) throw new Error('The ReactViewMounter is disposed.');
    const mark = markPlacementHost(host, target.placement.id);
    const key = this.hub.add(host, target);
    this.#ensureRoot(host.ownerDocument);
    let done = false;
    return toDisposable(() => {
      if (done) return;
      done = true;
      this.hub.remove(key);
      mark.dispose();
      this.#maybeDropFallback();
    });
  }

  #ensureRoot(document: Document): void {
    if (this.hub.external || this.#fallback) return;
    const root = createRoot(document.createElement('div'));
    this.#fallback = { root };
    const portals = <ViewPortals hub={this.hub} lookup={(t) => this.definition(t)} errorFallback={this.errorFallback} />;
    root.render(this.#strict ? <StrictMode>{portals}</StrictMode> : portals);
  }

  #maybeDropFallback(): void {
    const fallback = this.#fallback;
    if (!fallback || this.hub.size > 0) return;
    this.#fallback = undefined;
    // never unmount a root while React is rendering (this runs from effect cleanups)
    queueMicrotask(() => fallback.root.unmount());
  }

  dispose(): void {
    this.#disposed = true;
    this.#subscription.dispose();
    this.#loader.dispose();
    const fallback = this.#fallback;
    this.#fallback = undefined;
    if (fallback) queueMicrotask(() => fallback.root.unmount());
  }
}

import { Emitter, TesseraError, reportError, withTimeout, type Event, type IDisposable } from '@tessera/base';
import { PluginCatalog, PluginLoader, PluginManager, PluginState, ViewRegistry, type RendererId, type UiModule } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';

/** Longest wait for the import of a plugin's ui entry. */
export const UI_LOAD_TIMEOUT_MS = 10_000;

/**
 * Loads the `ui[rendererId]` entry of a plugin and keeps it until the plugin ends. This is renderer-independent: it finds the description
 * in the PluginCatalog, imports the entry with the PluginLoader, checks the module's rendererId, shares one load among concurrent callers and
 * forgets the module when the plugin deactivates, resolves again or is disabled (so a reload imports it again). A renderer adapter
 * (React, Lit, Solid) only maps the modules it gets to its own view definitions.
 */
export class UiModuleLoader implements IDisposable {
  readonly #services: ScopeReader;
  readonly #loading = new Map<string, Promise<UiModule | undefined>>();
  /** Per key: bumped by forget(). A load that finishes under an older number is stale and delivers nothing. */
  readonly #generation = new Map<string, number>();
  readonly #loadTimeoutMs: number;
  readonly #forgotten = new Emitter<string>({ name: 'uiModuleLoader.forgotten', deferInTransaction: false });
  readonly #subscription: IDisposable | undefined;

  constructor(services: ScopeReader, options?: { /** Longest wait for the import of a ui entry. Default 10 s (plugin.uiLoadTimeout). */ readonly loadTimeoutMs?: number }) {
    this.#services = services;
    this.#loadTimeoutMs = options?.loadTimeoutMs ?? UI_LOAD_TIMEOUT_MS;
    // A plugin that deactivates (hot reload, disable, update) takes its cached ui entry with it: the next loadUi imports it again.
    this.#subscription = services.get(PluginManager, { optional: true })?.onDidChangeState((status) => {
      if (status.state === PluginState.Deactivating || status.state === PluginState.Resolved || status.state === PluginState.Disabled) this.forget(status.id);
    });
  }

  /** Fires with the plugin id when a cached module was dropped, so an adapter can drop the view definitions it took from it. */
  get onDidForget(): Event<string> {
    return this.#forgotten.event;
  }

  /**
   * The ui module of `owner` for `rendererId`, or undefined when the plugin has none for this renderer, the load failed or timed out
   * (reported), or forget() ran while the load was pending (the result is stale). The module holds only the views whose view type the
   * plugin owns in the ViewRegistry: a ui entry cannot replace the view component of a type that another owner declared.
   */
  loadUi(owner: string, rendererId: RendererId): Promise<UiModule | undefined> {
    const key = `${owner}#${rendererId}`;
    let loading = this.#loading.get(key);
    if (!loading) {
      const holder: { promise?: Promise<UiModule | undefined> } = {};
      holder.promise = this.#load(owner, rendererId, key, this.#generation.get(key) ?? 0, holder);
      loading = holder.promise;
      this.#loading.set(key, loading);
    }
    return loading;
  }

  async #load(owner: string, rendererId: RendererId, key: string, generation: number, holder: { readonly promise?: Promise<UiModule | undefined> }): Promise<UiModule | undefined> {
    const stale = (): boolean => (this.#generation.get(key) ?? 0) !== generation;
    try {
      const module = await withTimeout(this.#import(owner, rendererId), this.#loadTimeoutMs, `Loading the ui.${rendererId} entry of "${owner}"`).catch((error: unknown) => {
        if (error instanceof TesseraError && error.code === 'timeout') {
          throw new TesseraError('plugin.uiLoadTimeout', `Loading the ui.${rendererId} entry of "${owner}" took longer than ${this.#loadTimeoutMs} ms`, { cause: error, details: { pluginId: owner, ms: this.#loadTimeoutMs } });
        }
        throw error;
      });
      if (stale()) return undefined; // forget() ran meanwhile: the result belongs to a plugin run that ended
      return module === undefined ? undefined : this.#ownedViews(owner, module);
    } catch (error) {
      // Only the load that owns the cache entry may drop it: a failed stale load must not delete the entry of a newer one.
      if (this.#loading.get(key) === holder.promise) this.#loading.delete(key); // a later loadUi may retry
      reportError(error, { source: 'view', pluginId: owner, target: key });
      return undefined;
    }
  }

  async #import(owner: string, rendererId: RendererId): Promise<UiModule | undefined> {
    const description = (await this.#services.get(PluginCatalog).list()).find((d) => d.manifest.id === owner);
    if (!description?.manifest.ui?.[rendererId]) return undefined; // the plugin has no UI for this renderer
    const loaded = (await this.#services.get(PluginLoader).load(description, rendererId)) as { default?: UiModule } | UiModule;
    const module = 'rendererId' in loaded ? loaded : loaded.default;
    if (!module || module.rendererId !== rendererId) throw new Error(`The ui.${rendererId} entry of "${owner}" does not export a ui module for "${rendererId}" as default.`);
    return module;
  }

  /** Keeps the views of view types that `owner` owns. A foreign or undeclared view type is reported once and skipped (view.uiForeignViewType). */
  #ownedViews(owner: string, module: UiModule): UiModule {
    const registry = this.#services.get(ViewRegistry, { optional: true });
    if (!registry) return module;
    const views = module.views.filter((view) => {
      const viewType = (view as { viewType?: unknown } | null)?.viewType;
      if (typeof viewType === 'string' && registry.descriptor(viewType)?.owner === owner) return true;
      const ownedBy = typeof viewType === 'string' ? registry.descriptor(viewType)?.owner : undefined;
      reportError(
        new TesseraError('view.uiForeignViewType', `The ui entry of "${owner}" defines the view type "${String(viewType)}", which ${ownedBy === undefined ? 'no plugin declared' : `"${ownedBy}" owns`}; the definition is ignored`, { details: { pluginId: owner, viewType, ownedBy } }),
        { source: 'view', pluginId: owner, target: `ui:${String(viewType)}` },
      );
      return false;
    });
    return views.length === module.views.length ? module : { ...module, views };
  }

  /** Drops the cached modules of a plugin. A load that is still pending becomes stale: it delivers nothing. */
  forget(owner: string): void {
    let known = false;
    const keys = new Set([...this.#loading.keys(), ...this.#generation.keys()]);
    for (const key of keys) {
      if (!key.startsWith(`${owner}#`)) continue;
      this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
      if (this.#loading.delete(key)) known = true;
    }
    if (known) this.#forgotten.fire(owner); // also for a pending load: the adapter drops what it took from an earlier module
  }

  dispose(): void {
    this.#subscription?.dispose();
    this.#loading.clear();
    this.#forgotten.dispose();
  }
}

import { Emitter, type IDisposable } from '@tessera/base';
import type { PluginCatalog, PluginDescription, PluginLoader } from '@tessera/contracts';

export interface StaticPluginCatalog extends PluginCatalog, IDisposable {
  /** Adds a plugin and fires onDidChange. */
  add(description: PluginDescription): void;
  remove(id: string): void;
  /** Replaces the plugin with the same id (or adds it) and fires onDidChange once. Simulates a manifest edited on disk. */
  replace(description: PluginDescription): void;
}

/** A catalog over a fixed list, for hosts without plugin discovery (web, tests). `add` and `remove` simulate a changing catalog. */
export function staticPluginCatalog(descriptions: readonly PluginDescription[]): StaticPluginCatalog {
  let list = [...descriptions];
  const changed = new Emitter<void>({ name: 'staticPluginCatalog.change', deferInTransaction: false });
  return {
    list: async () => list,
    onDidChange: changed.event,
    add(description) {
      list = [...list, description];
      changed.fire();
    },
    remove(id) {
      list = list.filter((d) => d.manifest.id !== id);
      changed.fire();
    },
    replace(description) {
      list = [...list.filter((d) => d.manifest.id !== description.manifest.id), description];
      changed.fire();
    },
    dispose() {
      changed.dispose();
    },
  };
}

/**
 * A loader over a module map. Keys are the plugin `location` for the main entry and `<location>#<rendererId>` for ui entries.
 * A cache-busting query (`?reload=2`, added by PluginManager.reload) is ignored for the lookup. A value may be a function that
 * returns the module (lazy import).
 */
export function staticPluginLoader(modules: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>): PluginLoader {
  const lookup = (key: string): unknown => (modules instanceof Map ? modules.get(key) : (modules as Record<string, unknown>)[key]);
  return {
    async load(description, entry) {
      const location = description.location.split('?')[0] as string;
      const key = entry === 'main' ? location : `${location}#${entry}`;
      const found = lookup(key);
      if (found === undefined) throw new Error(`staticPluginLoader: no module registered for "${key}"`);
      return typeof found === 'function' ? (found as () => unknown)() : found;
    },
  };
}

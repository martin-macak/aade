import {
  ContributionRegistry,
  LifecycleContribution,
  PluginCatalog,
  PluginLoader,
  PluginManager,
  StorageBackend,
  type LifecyclePhase,
  type PluginDescription,
  type PluginModule,
} from '@tessera/contracts';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { lifecycleModule } from '@tessera/lifecycle';
import { persistenceModule } from '@tessera/persistence';
import { createTestScope, describePlugin, type TestScope } from '@tessera/testing';
import { workItemsModule } from '@tessera/workitems';
import { pluginsModule, type DefaultContributionRegistry, type DefaultPluginManager } from '@tessera/plugins';

export interface Kit {
  readonly t: TestScope;
  readonly manager: DefaultPluginManager;
  readonly registry: DefaultContributionRegistry;
  /** location -> module namespace (or a function that throws) */
  readonly modules: Map<string, unknown>;
  /** Every load() call: 'test://id/#main' */
  readonly loads: string[];
  /** Runs the lifecycle contributions of a phase (what the shell does). */
  runPhase(phase: LifecyclePhase): Promise<void>;
  add(...manifests: unknown[]): Promise<void>;
  /** Registers the module namespace for a plugin id (location test://<id>/). */
  provideModule(id: string, module: PluginModule | (() => never)): void;
}

/** Real service modules (events, commands, workitems, lifecycle, persistence, plugins) in a test scope, without the workbench. */
export function kit(options?: { readonly descriptions?: readonly PluginDescription[] }): Kit {
  const modules = new Map<string, unknown>();
  const loads: string[] = [];
  const t = createTestScope({ modules: [eventsModule, commandsModule, workItemsModule, lifecycleModule, persistenceModule, pluginsModule] });
  const catalog: PluginCatalog = { list: async () => options?.descriptions ?? [], onDidChange: () => ({ dispose() {} }) };
  const loader: PluginLoader = {
    async load(description, entry) {
      const location = description.location.split('?')[0] as string;
      loads.push(`${location}#${entry}`);
      const found = modules.get(location);
      if (found === undefined) throw new Error(`No test module for ${location}`);
      if (typeof found === 'function') return (found as () => unknown)();
      return found;
    },
  };
  t.application.provideValue(PluginCatalog, catalog);
  t.application.provideValue(PluginLoader, loader);
  t.application.provideValue(StorageBackend, t.host.storage);
  const manager = t.window.get(PluginManager) as DefaultPluginManager;
  const registry = t.window.get(ContributionRegistry) as DefaultContributionRegistry;
  return {
    t,
    manager,
    registry,
    modules,
    loads,
    async runPhase(phase) {
      for (const c of t.window.getAll(LifecycleContribution)) if (c.phase === phase) await c.run(new AbortController().signal);
    },
    // fixtures are builtin plugins: the default policy grants a builtin plugin the capabilities it declares (a user plugin gets none)
    add: (...manifests) => manager.add(manifests.map((m) => describePlugin(m, 'builtin'))),
    provideModule: (id, module) => void modules.set(`test://${id}/`, module),
  };
}

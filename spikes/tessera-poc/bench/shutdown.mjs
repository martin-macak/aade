// Shutdown probe: deactivating many plugins (the plugins shutdown step). Run: npm run bench:shutdown
import { LifecycleContribution, LifecyclePhase, PluginCatalog, PluginLoader, PluginManager, StorageBackend } from '@tessera/contracts';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { lifecycleModule } from '@tessera/lifecycle';
import { persistenceModule } from '@tessera/persistence';
import { createTestScope, describePlugin, manifest } from '@tessera/testing';
import { workItemsModule } from '@tessera/workitems';
import { pluginsModule } from '@tessera/plugins';
for (const n of [100, 200, 400, 800]) {
  const t = createTestScope({ modules: [eventsModule, commandsModule, workItemsModule, lifecycleModule, persistenceModule, pluginsModule] });
  const modules = new Map();
  t.application.provideValue(PluginCatalog, { list: async () => [], onDidChange: () => ({ dispose() {} }) });
  t.application.provideValue(PluginLoader, { async load(d) { return modules.get(d.location.split('?')[0]); } });
  t.application.provideValue(StorageBackend, t.host.storage);
  const manager = t.window.get(PluginManager);
  for (const c of t.window.getAll(LifecycleContribution)) if (c.phase === LifecyclePhase.Starting) await c.run(new AbortController().signal);
  const ds = [];
  for (let i = 0; i < n; i++) { const id = `b.p${i}`; ds.push(describePlugin(manifest(id, { activationEvents: ['onStartupFinished'], dependencies: i > 0 && i % 5 ? { [`b.p${i-1}`]: '*' } : undefined }), 'builtin')); modules.set(`test://${id}/`, { activate() {}, deactivate() {} }); }
  await manager.add(ds); await manager.activateByEvent('onStartupFinished');
  const t0 = performance.now();
  await manager.deactivateAll?.();
  console.log(n, 'deactivateAll', (performance.now() - t0).toFixed(0), 'ms', Object.getOwnPropertyNames(Object.getPrototypeOf(manager)).includes('deactivateAll'));
}
process.exit(0);

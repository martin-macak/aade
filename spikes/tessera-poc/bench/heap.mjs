// Heap probe: the retained heap after creating and disposing a plugin set. Run: npm run bench:heap (add --expose-gc for stable numbers)
import { ContributionRegistry, PluginCatalog, PluginLoader, PluginManager, StorageBackend } from '@tessera/contracts';
import { commandsModule } from '@tessera/commands';
import { eventsModule } from '@tessera/events';
import { lifecycleModule } from '@tessera/lifecycle';
import { persistenceModule } from '@tessera/persistence';
import { createTestScope, describePlugin, manifest } from '@tessera/testing';
import { workItemsModule } from '@tessera/workitems';
import { pluginsModule } from '@tessera/plugins';
import { setDevMode } from '@tessera/base';
if (process.argv[3] === 'release') setDevMode(false);
const n = Number(process.argv[2] ?? 500);
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 1048576; };
const t = createTestScope({ modules: [eventsModule, commandsModule, workItemsModule, lifecycleModule, persistenceModule, pluginsModule] });
const modules = new Map();
t.application.provideValue(PluginCatalog, { list: async () => [], onDidChange: () => ({ dispose() {} }) });
t.application.provideValue(PluginLoader, { async load(d) { return modules.get(d.location.split('?')[0]); } });
t.application.provideValue(StorageBackend, t.host.storage);
const manager = t.window.get(PluginManager); void t.window.get(ContributionRegistry);
const descs = [];
for (let i = 0; i < n; i++) {
  const id = `bench.p${i}`;
  const commands = Array.from({ length: 5 }, (_, j) => ({ id: `${id}.cmd${j}`, title: `Cmd ${j}` }));
  descs.push(describePlugin(manifest(id, { activationEvents: ['onStartupFinished'], contributes: { commands } }), 'builtin'));
  modules.set(`test://${id}/`, { activate() {} });
}
const h0 = heap();
await manager.add(descs);
const h1 = heap();
await manager.activateByEvent('onStartupFinished');
const h2 = heap();
console.log(process.argv[3] ?? 'dev', n, 'plugins: +', (h1 - h0).toFixed(1), 'MB resolved (', ((h1 - h0) * 1024 / n).toFixed(1), 'KB/plugin ), +', (h2 - h1).toFixed(1), 'MB activated (', ((h2 - h1) * 1024 / n).toFixed(1), 'KB/plugin )');
process.exit(0);

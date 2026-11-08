// QuickPick probe: ranking a large item array per keystroke (RISK-QUICKPICK-SCALE). Run: npm run bench:qp
import { QuickInputService } from '@tessera/contracts';
import { createTestScope } from '@tessera/testing';
import { workbenchModule } from '@tessera/workbench';
import { eventsModule } from '@tessera/events';
import { commandsModule } from '@tessera/commands';
const t = createTestScope({ modules: [eventsModule, commandsModule, workbenchModule] });
const qi = t.window.get(QuickInputService);
for (const N of [1000, 10000, 100000]) {
  const items = Array.from({ length: N }, (_, i) => ({ id: String(i), label: `src/components/feature${i % 977}/Widget${i}.tsx`, description: `dir ${i % 50}` }));
  const p = qi.pick(items, { matchOnDescription: true });
  const s = qi.current.peek();
  const times = [];
  for (const q of ['w', 'wi', 'wid', 'widg', 'widget1', 'zzz']) {
    const t0 = performance.now(); s.filter.set(q); s.visibleItems.get(); times.push((performance.now() - t0).toFixed(1));
  }
  console.log(N, 'per keystroke ms', times.join(' '));
  s.accept(undefined); await p;
}
process.exit(0);

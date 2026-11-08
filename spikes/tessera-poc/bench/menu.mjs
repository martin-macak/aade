// Menu probe: the cost of a menu with many commands and context changes. Run: npm run bench:menu
import { CommandRegistry, CommandService, ContextKeyService, MenuId, MenuService, MenuRegistry } from '@tessera/contracts';
import { createTestScope } from '@tessera/testing';
import { eventsModule } from '@tessera/events';
import { commandsModule } from '@tessera/commands';
import { effect } from '@tessera/reactive';
const t = createTestScope({ modules: [eventsModule, commandsModule] });
const keys = t.window.get(ContextKeyService);
const win = keys.root.createChild('window'); keys.setFocused(undefined);
const reg = t.window.get(CommandRegistry);
const N = Number(process.argv[2] ?? 1000);
for (let i = 0; i < N; i++) reg.declare({ id: `c.${i}`, title: `Command ${i} thing`, owner: 'core', enablement: i % 10 === 0 ? 'k1' : undefined, category: `Cat${i % 20}` });
const commands = t.window.get(CommandService);
for (let i = 0; i < N; i++) reg.registerHandler(`c.${i}`, { run() {} });
const menus = t.window.get(MenuService);
let t0 = performance.now();
const menu = menus.createMenu(MenuId.CommandPalette, win);
let runs = 0;
const e = effect(() => { menu.groups.get(); runs++; });
console.log('first', (performance.now() - t0).toFixed(1), 'ms runs', runs);
win.set('k1', true);
t0 = performance.now();
for (let i = 0; i < 20; i++) { win.set('k1', i % 2 === 0 ? false : true); }
console.log('20 flips of a key used by 10% of commands:', ((performance.now() - t0) / 20).toFixed(2), 'ms per flip, effect runs', runs);
win.set('unrelated', 1);
t0 = performance.now();
for (let i = 0; i < 20; i++) win.set('unrelated', i + 2);
console.log('20 unrelated key writes:', ((performance.now() - t0) / 20).toFixed(3), 'ms each, runs', runs);
// focus change
const other = keys.root.createChild('other');
t0 = performance.now();
for (let i = 0; i < 20; i++) keys.setFocused(i % 2 ? win : other);
console.log('focus flips', ((performance.now() - t0) / 20).toFixed(2));
process.exit(0);

// B15 heap check (round 2, b15-measured-on-leaking-test-doubles): 100,000 plugin register/dispose cycles must leave the heap flat.
// The test doubles keep bounded history (memoryStorageBackend retainHistory false, 1,000-entry caps elsewhere), so the number measures the framework.
// Run: node --expose-gc bench/leak.mjs   (npm run bench:leak)
import { DisposableStore, setDevMode, toDisposable } from '@tessera/base';
import { state, computed } from '@tessera/reactive';

if (typeof globalThis.gc !== 'function') {
  console.error('Run with --expose-gc (npm run bench:leak).');
  process.exit(2);
}
setDevMode(false); // the production setting: dev mode keeps a registry of named nodes for the debugger
const cycles = 100_000;
const store = new DisposableStore('bench');
const source = state(1);
const live = new Map();
function cycle(i) {
  // what the plugin runtime does for one registration: wrapper in the store, a live-report entry, an observable and its subscription
  const sub = computed(() => source.get() + 1).subscribe(() => undefined);
  const wrapper = toDisposable(() => {
    live.delete(i);
    store.release(wrapper);
    sub.dispose();
  });
  live.set(i, `bench:${i}`);
  store.add(wrapper);
  wrapper.dispose();
}
for (let i = 0; i < 1000; i++) cycle(i);
globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < cycles; i++) cycle(i);
await new Promise((r) => setTimeout(r, 20));
globalThis.gc();
const growthMb = (process.memoryUsage().heapUsed - before) / 1e6;
console.log(`heap growth after ${cycles} register/dispose cycles: ${growthMb.toFixed(2)} MB; store size ${store.size}, live entries ${live.size}`);
process.exit(store.size === 0 && live.size === 0 && growthMb < 8 ? 0 : 1);

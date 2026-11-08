// RPC round trip probe (round 3, perf-budget-coverage-gaps): calls and events over the in-memory transport. Run: npm run bench:rpc
import { Emitter } from '@tessera/base';
import { defineRpcInterface } from '@tessera/contracts';
import { createInMemoryTransportPair, createRpcConnection } from '@tessera/rpc';
const any = { safeParse: (i) => ({ success: true, data: i }) };
const I = defineRpcInterface('p.svc', 1, { methods: { echo: { args: any, result: any } }, events: { onT: any } });
const [a, b] = createInMemoryTransportPair();
const ca = createRpcConnection(a, { name: 'r' });
const cb = createRpcConnection(b, { name: 'm' });
const em = new Emitter({ name: 'x', deferInTransaction: false });
cb.register(I, { echo: async (x) => x, onT: em.event });
await new Promise((r) => setTimeout(r, 10));
const p = ca.getProxy(I);
async function bench(label, payload, n) {
  for (let i = 0; i < 20; i++) await p.echo(payload);
  const t = performance.now();
  for (let i = 0; i < n; i++) await p.echo(payload);
  console.log(label, ((performance.now() - t) / n * 1000).toFixed(1), 'us/roundtrip');
}
await bench('tiny', 1, 5000);
await bench('10KB', 'x'.repeat(10_000), 2000);
await bench('10KB objs', Array.from({length:100},(_, i)=>({id:i,name:'n'+i,tags:['a','b'],v:{x:1,y:2}})), 1000);
await bench('400KB str', 'x'.repeat(400_000), 200);
// concurrent 1000
let t = performance.now();
await Promise.all(Array.from({length:900},()=>p.echo(1)));
console.log('900 concurrent tiny', (performance.now()-t).toFixed(1),'ms');
// events
let got = 0; p.onT(() => got++);
await new Promise((r) => setTimeout(r, 10));
t = performance.now();
for (let i = 0; i < 20000; i++) em.fire({ i, name: 'event' });
await new Promise((r) => setTimeout(r, 50));
console.log('20000 events', got, (performance.now()-t).toFixed(1),'ms');
process.exit(0);

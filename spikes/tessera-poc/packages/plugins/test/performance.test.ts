import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { LifecyclePhase } from '@tessera/contracts';
import { manifest } from '@tessera/testing';
import { kit } from './kit.ts';

// Counter tests, no timing (decision 7): the cost model of plugin management is "work per change", not "work per plugin".
const many = (count: number) => Array.from({ length: count }, (_, i) => manifest(`fixture.p${i}`, { contributes: { commands: [{ id: `p${i}.a`, title: 'A' }, { id: `p${i}.b`, title: 'B' }] }, activationEvents: [`onCommand:p${i}.a`] }));

describe('C17: plugin management cost (plugin-status-republish-quadratic)', () => {
  it('C17: an entry is validated once, when it is applied; activating plugins validates nothing again', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const list = many(40);
    for (const m of list) k.provideModule(m.id, { activate: () => undefined });
    const before = k.registry.validations;
    await k.add(...list);
    const applied = k.registry.validations - before;
    expect(applied).toBe(40 * 2); // two command entries per plugin, one validation each
    for (const m of list) await k.manager.activate(m.id);
    expect(k.registry.validations - before).toBe(applied); // O(1) per activation: zero more
  });

  it('C17: a state change rebuilds the status of that plugin only', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const list = many(60);
    for (const m of list) k.provideModule(m.id, { activate: () => undefined });
    await k.add(...list);
    const before = k.manager.statusesBuilt;
    await k.manager.activate('fixture.p7'); // resolved -> activating -> active: two state changes
    expect(k.manager.statusesBuilt - before).toBe(2);
    const afterActivate = k.manager.statusesBuilt;
    const unchanged = k.manager.status('fixture.p3');
    await k.manager.deactivate('fixture.p7'); // active -> deactivating -> resolved
    expect(k.manager.statusesBuilt - afterActivate).toBe(2);
    expect(k.manager.status('fixture.p3')).toBe(unchanged); // the frozen status object of an untouched plugin is reused
  });

  it('C17: the activation events come from a reverse index: activateByEvent with no match does not wait for an unrelated pending activation', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.slowone', { activate: () => gate.promise });
    await k.add(manifest('fixture.slowone', { activationEvents: ['onStartupFinished'] }));
    const slow = k.manager.activate('fixture.slowone');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.slowone')?.state).toBe('activating');
    await k.manager.activateByEvent('onCommand:nobody.declares.this'); // returns at once
    expect(k.manager.status('fixture.slowone')?.state).toBe('activating');
    expect(k.registry.pluginsForEvent('onStartupFinished').has('fixture.slowone')).toBe(true);
    expect(k.registry.pluginsForEvent('onCommand:nobody.declares.this').size).toBe(0);
    gate.resolve();
    await slow;
  });

  it('C17: but an event of the pending plugin itself waits for that plugin (a command executes while its owner starts)', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.owner', { activate: () => gate.promise });
    await k.add(manifest('fixture.owner', { contributes: { commands: [{ id: 'owner.run', title: 'Run' }] } }));
    const starting = k.manager.activate('fixture.owner');
    await new Promise((r) => setTimeout(r, 0));
    let done = false;
    const waited = k.manager.activateByEvent('onCommand:owner.run').then(() => void (done = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    gate.resolve();
    await Promise.all([starting, waited]);
    expect(done).toBe(true);
  });
});

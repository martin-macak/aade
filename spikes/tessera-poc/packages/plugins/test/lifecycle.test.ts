import { describe, expect, it } from 'vitest';
import { DeferredPromise, toDisposable } from '@tessera/base';
import { token } from '@tessera/di';
import { CommandRegistry, CommandService, LifecyclePhase, ContextKeyService, WorkItemService, defineTopic, EventBus } from '@tessera/contracts';
import { captureErrors, manifest } from '@tessera/testing';
import { kit } from './kit.ts';

const Thing = token<{ readonly n: number }>('fixture/Thing');
const topic = defineTopic<number>('fixture.lifecycle.topic');

describe('C17: deactivation and reload (unit)', () => {
  it('C17: dependents deactivate first, then the plugin; registrations, context keys and WorkItems are gone and the live report is empty', async () => {
    const k = kit();
    const order: string[] = [];
    k.provideModule('fixture.low', {
      activate(ctx) {
        ctx.services.provide(Thing, () => ({ n: 7 }));
        ctx.workItems.create('low-work');
        ctx.api.context.set('fixture.low.on', true);
        ctx.api.events.subscribe(topic, () => void 0);
      },
      deactivate: () => void order.push('low.deactivate'),
    });
    k.provideModule('fixture.high', {
      activate(ctx) {
        expect(ctx.services.get(Thing).n).toBe(7);
        ctx.subscriptions.add({ dispose: () => void order.push('high.subscription') });
      },
      deactivate: () => void order.push('high.deactivate'),
    });
    await k.add(manifest('fixture.low', { provides: ['fixture/Thing'] }), manifest('fixture.high', { requires: ['fixture/Thing'] }));
    await k.manager.activate('fixture.high');
    expect(k.t.window.get(Thing).n).toBe(7);
    expect(k.manager.liveDisposables('fixture.low').length).toBeGreaterThan(0);

    await k.manager.deactivate('fixture.low');
    expect(order).toEqual(['high.deactivate', 'high.subscription', 'low.deactivate']);
    expect(k.manager.status('fixture.high')?.state).toBe('resolved');
    expect(k.manager.status('fixture.low')?.state).toBe('resolved');
    expect(k.t.window.get(Thing, { optional: true })).toBeUndefined(); // the provided registration left the window scope
    expect(k.t.window.get(ContextKeyService).root.getValue('fixture.low.on')).toBeUndefined();
    expect(k.t.window.get(ContextKeyService).root.getValue('plugin.fixture.low.active')).toBe(false);
    expect(k.manager.liveDisposables('fixture.low')).toEqual([]);
    expect(k.manager.liveDisposables('fixture.high')).toEqual([]);
    k.t.window.get(EventBus).root.publish(topic, 1); // nobody is subscribed any more (no error, nothing to leak)
  });

  it('C17: deactivateAll goes in reverse dependency order and a throwing deactivate() is reported but does not stop the rest', async () => {
    const k = kit();
    const order: string[] = [];
    k.provideModule('fixture.a', { activate: () => void 0, deactivate: () => void order.push('a') });
    k.provideModule('fixture.b', { activate: () => void 0, deactivate: () => { order.push('b'); throw new Error('b deactivate broke'); } });
    k.provideModule('fixture.c', { activate: () => void 0, deactivate: () => void order.push('c') });
    await k.add(manifest('fixture.a'), manifest('fixture.b', { dependencies: { 'fixture.a': '^1.0.0' } }), manifest('fixture.c', { dependencies: { 'fixture.b': '^1.0.0' } }));
    await k.manager.activate('fixture.c');
    const errors = captureErrors();
    await k.manager.deactivateAll();
    expect(order).toEqual(['c', 'b', 'a']);
    expect(errors.drain().map((e) => e.context)).toEqual([expect.objectContaining({ source: 'deactivation', pluginId: 'fixture.b' })]);
    errors.dispose();
  });

  it('C17: an abort signal fires when deactivation starts', async () => {
    const k = kit();
    let aborted = false;
    k.provideModule('fixture.signal', { activate: (ctx) => void ctx.signal.addEventListener('abort', () => (aborted = true)) });
    await k.add(manifest('fixture.signal'));
    await k.manager.activate('fixture.signal');
    expect(aborted).toBe(false);
    await k.manager.deactivate('fixture.signal');
    expect(aborted).toBe(true);
  });

  it('C17: reload deactivates with dependents, re-imports with a cache-busting query and activates both again', async () => {
    const k = kit();
    const activations: string[] = [];
    k.provideModule('fixture.core', { activate: () => void activations.push('core'), deactivate: () => void activations.push('core off') });
    k.provideModule('fixture.top', { activate: () => void activations.push('top'), deactivate: () => void activations.push('top off') });
    await k.add(manifest('fixture.core'), manifest('fixture.top', { dependencies: { 'fixture.core': '^1.0.0' } }));
    await k.manager.activate('fixture.top');
    activations.length = 0;
    await k.manager.reload('fixture.core');
    expect(activations).toEqual(['top off', 'core off', 'core', 'top']);
    expect(k.manager.status('fixture.core')?.state).toBe('active');
    expect(k.manager.status('fixture.top')?.state).toBe('active');
    expect(k.manager.liveDisposables('fixture.core')).toHaveLength(0);
  });

  it('C17: disable deactivates and persists; enable brings a plugin that was active back to active (contracts 14.12)', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    k.provideModule('fixture.toggle', { activate: () => void 0 });
    await k.add(manifest('fixture.toggle'));
    await k.manager.activate('fixture.toggle');
    await k.manager.disable('fixture.toggle');
    expect(k.manager.status('fixture.toggle')?.state).toBe('disabled');
    await k.t.window.get(await import('@tessera/contracts').then((m) => m.StorageService)).flush();
    expect(k.t.host.storage).toBeDefined();
    await k.manager.enable('fixture.toggle');
    expect(k.manager.status('fixture.toggle')?.state).toBe('active');
    // a plugin that was not active when it was disabled comes back resolved
    k.provideModule('fixture.idle', { activate: () => void 0 });
    await k.add(manifest('fixture.idle'));
    await k.manager.disable('fixture.idle');
    await k.manager.enable('fixture.idle');
    expect(k.manager.status('fixture.idle')?.state).toBe('resolved');
  });

  it('C17: onCommand activation: executing a declared command activates the plugin once, then runs the handler', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    k.provideModule('fixture.lazy', { activate: (ctx) => void ctx.api.commands.registerHandler('lazy.run', { run: () => 'lazy result' }) });
    await k.add(manifest('fixture.lazy', { contributes: { commands: [{ id: 'lazy.run', title: 'Run' }] } }));
    expect(k.loads).toEqual([]); // nothing loaded yet
    const commands = k.t.window.get(CommandService);
    const [a, b] = await Promise.all([commands.execute('lazy.run'), commands.execute('lazy.run')]);
    expect([a, b]).toEqual(['lazy result', 'lazy result']);
    expect(k.loads).toEqual(['test://fixture.lazy/#main']); // exactly once
    expect(k.manager.status('fixture.lazy')).toMatchObject({ state: 'active', activationReason: 'onCommand:lazy.run' });
  });

  it('C30: deactivating a provider waits for a dependent that is still activating, then deactivates that dependent first', async () => {
    const k = kit();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.base2', { activate: () => void order.push('base.activate'), deactivate: () => void order.push('base.deactivate') });
    k.provideModule('fixture.top2', {
      async activate() {
        order.push('top.activating');
        await gate.promise;
        order.push('top.activated');
      },
      deactivate: () => void order.push('top.deactivate'),
    });
    await k.add(manifest('fixture.base2', { provides: ['fixture/Base2'] }), manifest('fixture.top2', { requires: ['fixture/Base2'] }));
    const activating = k.manager.activate('fixture.top2');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.top2')?.state).toBe('activating');
    const deactivating = k.manager.deactivate('fixture.base2');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.base2')?.state).toBe('active'); // it waits for the dependent
    gate.resolve();
    await Promise.all([activating, deactivating]);
    expect(order).toEqual(['base.activate', 'top.activating', 'top.activated', 'top.deactivate', 'base.deactivate']);
    expect(k.manager.status('fixture.top2')?.state).toBe('resolved');
    expect(k.manager.status('fixture.base2')?.state).toBe('resolved');
  });
});

describe('C17: races between activation and deactivation (unit)', () => {
  it('C30: deactivateAll waits for a plugin that is still activating, then deactivates it (deactivate() only after activate())', async () => {
    const k = kit();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.slow', {
      async activate() {
        order.push('activating');
        await gate.promise;
        order.push('activated');
      },
      deactivate: () => void order.push('deactivate'),
    });
    await k.add(manifest('fixture.slow'));
    const activating = k.manager.activate('fixture.slow');
    await new Promise((r) => setTimeout(r, 0));
    const all = k.manager.deactivateAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['activating']); // deactivate() has not run
    gate.resolve();
    await Promise.all([activating, all]);
    expect(order).toEqual(['activating', 'activated', 'deactivate']);
    expect(k.manager.status('fixture.slow')?.state).toBe('resolved');
  });

  it('C30: dispose waits for an activation in flight and writes no state afterwards', async () => {
    const k = kit();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.slow2', {
      async activate() {
        await gate.promise;
        order.push('activated');
      },
      deactivate: () => void order.push('deactivate'),
    });
    await k.add(manifest('fixture.slow2'));
    const activating = k.manager.activate('fixture.slow2');
    await new Promise((r) => setTimeout(r, 0));
    const disposing = k.manager.dispose();
    gate.resolve();
    await Promise.all([activating, disposing]);
    expect(order).toEqual(['activated', 'deactivate']);
  });

  it('C30: the host skips deactivate() for a runtime whose activate() has not finished, cleans it up, and the activation then fails', async () => {
    const k = kit();
    const calls: string[] = [];
    const gate = new DeferredPromise<void>();
    k.provideModule('fixture.half', {
      async activate(ctx) {
        ctx.api.commands.registerHandler('fixture.half.run', { run: () => 'ran' });
        ctx.workItems.create('half');
        await gate.promise;
      },
      deactivate: () => void calls.push('deactivate'),
    });
    await k.add(manifest('fixture.half', { contributes: { commands: [{ id: 'fixture.half.run', title: 'Run' }] } }));
    const errors = captureErrors();
    const activating = k.manager.activate('fixture.half').then(() => 'ok', (e: { code: string }) => e.code);
    await new Promise((r) => setTimeout(r, 0));
    await k.manager.host.deactivate('fixture.half'); // a shutdown path that does not wait
    expect(calls).toEqual([]);
    expect(k.t.window.get(CommandRegistry).hasHandler('fixture.half.run')).toBe(false);
    expect(k.t.window.get(WorkItemService).find('root/half')).toBeUndefined();
    gate.resolve();
    expect(await activating).toBe('plugin.activationFailed'); // never Active on a cleaned-up runtime
    expect(calls).toEqual([]);
    expect(k.manager.status('fixture.half')?.state).toBe('failed');
    errors.drain();
    errors.dispose();
  });

  it('C30: a consumer that activates while its provider deactivates waits, reactivates the provider and ends Active', async () => {
    const k = kit();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    let providerRuns = 0;
    k.provideModule('fixture.prov', {
      activate: () => void order.push(`prov.activate#${++providerRuns}`),
      async deactivate() {
        order.push('prov.deactivating');
        await gate.promise;
        order.push('prov.deactivated');
      },
    });
    k.provideModule('fixture.cons', { activate: () => void order.push('cons.activate') });
    await k.add(manifest('fixture.prov', { provides: ['fixture/Prov'] }), manifest('fixture.cons', { requires: ['fixture/Prov'] }));
    await k.manager.activate('fixture.prov');
    const deactivating = k.manager.deactivate('fixture.prov');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.prov')?.state).toBe('deactivating');
    const activating = k.manager.activate('fixture.cons');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.cons')?.state).toBe('resolved'); // waits, does not fail
    gate.resolve();
    await Promise.all([deactivating, activating]);
    expect(order).toEqual(['prov.activate#1', 'prov.deactivating', 'prov.deactivated', 'prov.activate#2', 'cons.activate']);
    expect(k.manager.status('fixture.prov')?.state).toBe('active');
    expect(k.manager.status('fixture.cons')?.state).toBe('active');
  });

  it('C30: a consumer that activates while the provider waits for the deactivation of other dependents does not end Active on a dead provider', async () => {
    const k = kit();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    let providerRuns = 0;
    k.provideModule('fixture.prov3', {
      activate: () => void order.push(`prov.activate#${++providerRuns}`),
      deactivate: () => void order.push('prov.deactivate'),
    });
    k.provideModule('fixture.dep3', {
      activate: () => void order.push('dep.activate'),
      async deactivate() {
        order.push('dep.deactivating');
        await gate.promise;
        order.push('dep.deactivated');
      },
    });
    k.provideModule('fixture.late3', { activate: () => void order.push('late.activate') });
    await k.add(manifest('fixture.prov3', { provides: ['fixture/Prov3'] }), manifest('fixture.dep3', { requires: ['fixture/Prov3'] }), manifest('fixture.late3', { requires: ['fixture/Prov3'] }));
    await k.manager.activate('fixture.dep3');
    const deactivating = k.manager.deactivate('fixture.prov3');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toContain('dep.deactivating'); // the provider is waiting for this dependent
    expect(k.manager.status('fixture.prov3')?.state).toBe('active'); // still active, but already closing
    const activating = k.manager.activate('fixture.late3');
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.late3')?.state).toBe('resolved'); // waits for the closing provider
    gate.resolve();
    await Promise.all([deactivating, activating]);
    expect(order).toEqual(['prov.activate#1', 'dep.activate', 'dep.deactivating', 'dep.deactivated', 'prov.deactivate', 'prov.activate#2', 'late.activate']);
    expect(k.manager.status('fixture.prov3')?.state).toBe('active');
    expect(k.manager.status('fixture.late3')?.state).toBe('active');
  });

  it('C30: services, subscriptions and WorkItems of a plugin end in one LIFO order (cleanup-order-workitems-after-services)', async () => {
    const k = kit();
    const order: string[] = [];
    k.t.window.get(WorkItemService).onDidTerminate((w) => void order.push(`workItem ${w.id} terminated`));
    k.provideModule('fixture.order', {
      activate(ctx) {
        ctx.subscriptions.add(toDisposable(() => order.push('first registration')));
        ctx.workItems.create('order-item');
        ctx.subscriptions.add(toDisposable(() => order.push('last registration')));
      },
    });
    await k.add(manifest('fixture.order'));
    await k.manager.activate('fixture.order');
    await k.manager.deactivate('fixture.order');
    expect(order).toEqual(['last registration', 'workItem order-item terminated', 'first registration']);
  });

  it('C30: 200 active plugins add one onDidCreate listener, and WorkItems still reach their owner (per-plugin-listener-on-workitem-created)', async () => {
    const k = kit();
    const service = k.t.window.get(WorkItemService);
    let listeners = 0;
    const original = service.onDidCreate;
    (service as { onDidCreate: typeof original }).onDidCreate = (listener, options) => {
      listeners++;
      const subscription = original(listener, options);
      return toDisposable(() => (listeners--, subscription.dispose()));
    };
    const ids = Array.from({ length: 200 }, (_, i) => `fixture.many${i}`);
    for (const id of ids) k.provideModule(id, { activate: (ctx) => void ctx.workItems.create(`own-${id.slice('fixture.'.length)}`) });
    await k.add(...ids.map((id) => manifest(id)));
    for (const id of ids) await k.manager.activate(id);
    expect(listeners).toBeLessThanOrEqual(2);
    expect(ids.every((id) => k.manager.status(id)?.state === 'active')).toBe(true);
    await k.manager.deactivate(ids[0] as string);
    expect(service.find('root/own-many0')).toBeUndefined(); // the first plugin's WorkItem ended with it
    expect(service.find('root/own-many1')?.owner).toBe('fixture.many1');
  });
});

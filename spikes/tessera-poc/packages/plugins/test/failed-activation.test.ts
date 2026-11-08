import { describe, expect, it } from 'vitest';
import { DeferredPromise, toDisposable } from '@tessera/base';
import { CommandRegistry, CommandService, ContextKeyService, LifecyclePhase, UndoService, WorkItemService, defineTopic, type PluginModule } from '@tessera/contracts';
import { captureErrors, manifest } from '@tessera/testing';
import { kit } from './kit.ts';

const topic = defineTopic<{ n: number }>('fixture.topic');

function withCommand(id: string, extra?: object) {
  return manifest(id, { contributes: { commands: [{ id: `${id}.run`, title: 'Run' }] }, ...extra });
}

describe('C16: failed activation (unit)', () => {
  it('C16: a throwing activate ends failed/activateThrew, never calls deactivate, and leaves no registration behind', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const calls: string[] = [];
    const received: number[] = [];
    k.provideModule('fixture.boom', {
      activate(ctx) {
        ctx.api.commands.registerHandler('fixture.boom.run', { run: () => 'ran' });
        ctx.api.events.subscribe(topic, (e) => received.push(e.n));
        ctx.api.context.set('fixture.boom.flag', true);
        ctx.subscriptions.add(toDisposable(() => calls.push('subscription disposed')));
        throw new Error('nope');
      },
      deactivate() {
        calls.push('deactivate');
      },
    });
    await k.add(withCommand('fixture.boom'));
    const errors = captureErrors();
    await expect(k.manager.activate('fixture.boom')).rejects.toMatchObject({ code: 'plugin.activationFailed' });

    const status = k.manager.status('fixture.boom');
    expect(status?.state).toBe('failed');
    expect(status?.failure).toMatchObject({ cause: 'activateThrew', count: 1 });
    expect(status?.failure?.error.message).toContain('nope');
    expect(calls).toEqual(['subscription disposed']); // deactivate() is never called (OSGi rule)
    expect(k.t.window.get(CommandRegistry).hasHandler('fixture.boom.run')).toBe(false);
    expect(k.t.window.get(ContextKeyService).root.getValue('fixture.boom.flag')).toBeUndefined();
    expect(k.t.window.get(ContextKeyService).root.getValue('plugin.fixture.boom.active')).toBe(false);
    k.t.application.get(await import('@tessera/contracts').then((m) => m.EventBus)).root.publish(topic, { n: 1 });
    expect(received).toEqual([]); // the subscription is gone
    expect(k.manager.liveDisposables('fixture.boom')).toEqual([]);

    const reported = errors.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'activation', pluginId: 'fixture.boom' });
    errors.dispose();
  });

  it('C16: the declared command stays in the registry (contributions stay applied) but executing it now rejects', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    k.provideModule('fixture.boom', { activate: () => void (() => { throw new Error('nope'); })() });
    await k.add(withCommand('fixture.boom'));
    const errors = captureErrors();
    await expect(k.t.window.get(CommandService).execute('fixture.boom.run')).rejects.toMatchObject({ code: 'command.unavailable' });
    expect(k.manager.status('fixture.boom')?.state).toBe('failed');
    expect(k.t.window.get(CommandRegistry).metadata('fixture.boom.run')).toBeDefined();
    errors.drain();
    errors.dispose();
  });

  it('C16: a load failure (missing entry, no default export) is failed/loadFailed', async () => {
    const k = kit();
    k.provideModule('fixture.noentry', (() => {
      throw new Error('404');
    }) as never);
    k.modules.set('test://fixture.nodefault/', { default: { notActivate: true } });
    await k.add(manifest('fixture.noentry'), manifest('fixture.nodefault'));
    const errors = captureErrors();
    await k.manager.activateByEvent('*'); // nobody listens yet: nothing happens
    await expect(k.manager.activate('fixture.noentry')).rejects.toBeDefined();
    await expect(k.manager.activate('fixture.nodefault')).rejects.toBeDefined();
    expect(k.manager.status('fixture.noentry')?.failure?.cause).toBe('loadFailed');
    expect(k.manager.status('fixture.nodefault')?.failure?.cause).toBe('loadFailed');
    expect(errors.drain()).toHaveLength(2);
    errors.dispose();
  });

  it('C16: an activate that never settles times out after 10 s with activateTimeout and cleans up', async () => {
    const k = kit();
    const never = new DeferredPromise<void>();
    let cleaned = false;
    k.provideModule('fixture.slow', {
      activate(ctx) {
        ctx.subscriptions.add(toDisposable(() => (cleaned = true)));
        return never.promise;
      },
    });
    await k.add(manifest('fixture.slow'));
    const errors = captureErrors();
    const result = k.manager.activate('fixture.slow');
    const settled = result.then(() => 'ok', (e: { code: string }) => e.code);
    await new Promise((r) => setTimeout(r, 0));
    k.t.scheduler.advance(9_999);
    await new Promise((r) => setTimeout(r, 0));
    expect(k.manager.status('fixture.slow')?.state).toBe('activating');
    k.t.scheduler.advance(1);
    expect(await settled).toBe('plugin.activationTimeout');
    expect(k.manager.status('fixture.slow')?.failure?.cause).toBe('activateTimeout');
    expect(cleaned).toBe(true);
    errors.drain();
    errors.dispose();
    never.resolve();
  });

  it('C30: calls an abandoned activate() makes after the timeout throw plugin.deactivated and leak nothing; retry() then succeeds', async () => {
    const k = kit();
    const late = new DeferredPromise<void>();
    const attempts: Array<Record<string, unknown>> = [];
    let first = true;
    k.provideModule('fixture.late', {
      async activate(ctx) {
        if (first) {
          first = false;
          await late.promise; // outlives the timeout
          const outcome: Record<string, unknown> = {};
          const attempt = (name: string, fn: () => unknown): void => {
            try {
              fn();
              outcome[name] = 'ok';
            } catch (error) {
              outcome[name] = (error as { code?: string }).code;
            }
          };
          attempt('workItem', () => ctx.workItems.create('late'));
          attempt('context', () => ctx.api.context.set('fixture.late.key', true));
          attempt('undo', () => ctx.api.undo.push({ label: 'late', code: 'late', resource: 'x', undo: () => undefined, redo: () => undefined }));
          attempt('handler', () => ctx.api.commands.registerHandler('fixture.late.run', { run: () => 'late' }));
          attempt('subscription', () => ctx.api.events.subscribe(topic, () => undefined));
          attempts.push(outcome);
          return;
        }
        ctx.workItems.create('late');
        ctx.api.context.set('fixture.late.key', true);
      },
    });
    await k.add(manifest('fixture.late'));
    const errors = captureErrors();
    const result = k.manager.activate('fixture.late').then(() => 'ok', (e: { code: string }) => e.code);
    await new Promise((r) => setTimeout(r, 0));
    k.t.scheduler.advance(10_000);
    expect(await result).toBe('plugin.activationTimeout');

    late.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(attempts).toEqual([{ workItem: 'plugin.deactivated', context: 'plugin.deactivated', undo: 'plugin.deactivated', handler: 'plugin.deactivated', subscription: 'plugin.deactivated' }]);
    const items = k.t.window.get(WorkItemService);
    expect(items.find('root/late')).toBeUndefined(); // no WorkItem
    expect(k.t.window.get(ContextKeyService).root.getValue('fixture.late.key')).toBeUndefined();
    expect(k.t.window.get(UndoService).canUndo('x').peek()).toBe(false); // no undo entry
    expect(k.t.window.get(CommandRegistry).hasHandler('fixture.late.run')).toBe(false);
    expect(k.manager.liveDisposables('fixture.late')).toEqual([]);

    await k.manager.retry('fixture.late'); // no "workItem.duplicate" forever
    expect(k.manager.status('fixture.late')?.state).toBe('active');
    expect(items.find('root/late')).toBeDefined();
    await k.manager.deactivate('fixture.late');
    expect(items.find('root/late')).toBeUndefined();
    errors.drain();
    errors.dispose();
  });

  it('C30: WorkItems made by root.createChild or the WorkItemService, and undo pushed through the UndoService token, are cleaned up after a failed activation; retry() then succeeds', async () => {
    const k = kit();
    const ran: string[] = [];
    let first = true;
    k.provideModule('fixture.owned', {
      activate(ctx) {
        ctx.workItems.root.createChild('via-root');
        ctx.services.get(WorkItemService).root.createChild('via-service').createChild('nested');
        ctx.services.get(UndoService).push({ label: 'x', code: 'x', resource: 'owned', undo: () => void ran.push('undo'), redo: () => undefined });
        if (first) {
          first = false;
          throw new Error('nope');
        }
      },
    });
    await k.add(manifest('fixture.owned'));
    const errors = captureErrors();
    await expect(k.manager.activate('fixture.owned')).rejects.toMatchObject({ code: 'plugin.activationFailed' });
    const items = k.t.window.get(WorkItemService);
    for (const path of ['root/via-root', 'root/via-service', 'root/via-service/nested']) expect(items.find(path)).toBeUndefined();
    expect(await k.t.window.get(UndoService).undo('owned')).toBe(false);
    expect(ran).toEqual([]);

    await k.manager.retry('fixture.owned'); // no "workItem.duplicate" forever
    expect(k.manager.status('fixture.owned')?.state).toBe('active');
    expect(items.find('root/via-root')).toBeDefined();
    await k.manager.deactivate('fixture.owned');
    expect(items.find('root/via-root')).toBeUndefined();
    expect(items.find('root/via-service')).toBeUndefined();
    expect(await k.t.window.get(UndoService).undo('owned')).toBe(false);
    errors.drain();
    errors.dispose();
  });

  it('C16: a dependent of a failed plugin fails with dependencyFailed and its code is never loaded', async () => {
    const k = kit();
    k.provideModule('fixture.base', { activate: () => { throw new Error('base broke'); } });
    k.provideModule('fixture.top', { activate: () => void 0 });
    await k.add(manifest('fixture.base'), manifest('fixture.top', { dependencies: { 'fixture.base': '^1.0.0' } }));
    const errors = captureErrors();
    await expect(k.manager.activate('fixture.top')).rejects.toMatchObject({ code: 'plugin.dependencyFailed' });
    expect(k.manager.status('fixture.base')?.failure?.cause).toBe('activateThrew');
    expect(k.manager.status('fixture.top')?.failure?.cause).toBe('dependencyFailed');
    expect(k.loads.filter((l) => l.includes('fixture.top'))).toEqual([]);
    expect(errors.drain().map((e) => e.context.pluginId).sort()).toEqual(['fixture.base', 'fixture.top']);
    errors.dispose();
  });

  it('C16: a dependent that failed with dependencyFailed returns to resolved when its provider recovers, and the failure count stays (dependency-failed-sticky)', async () => {
    const k = kit();
    let broken = true;
    k.provideModule('fixture.base3', { activate: () => { if (broken) throw new Error('base broke'); } });
    k.provideModule('fixture.top3', { activate: () => void 0 });
    await k.add(manifest('fixture.base3'), manifest('fixture.top3', { dependencies: { 'fixture.base3': '^1.0.0' } }));
    const errors = captureErrors();
    await expect(k.manager.activate('fixture.top3')).rejects.toMatchObject({ code: 'plugin.dependencyFailed' });
    expect(k.manager.status('fixture.top3')).toMatchObject({ state: 'failed', failure: { cause: 'dependencyFailed', count: 1 } });
    broken = false;
    await k.manager.retry('fixture.base3'); // the provider recovers
    expect(k.manager.status('fixture.base3')?.state).toBe('active');
    expect(k.manager.status('fixture.top3')).toMatchObject({ state: 'resolved', failure: undefined });
    await k.manager.activate('fixture.top3'); // activates on its next trigger
    expect(k.manager.status('fixture.top3')?.state).toBe('active');
    errors.drain();
    errors.dispose();
  });

  it('C16: a late rejection of an activate() that timed out is reported with target lateRejection (abandoned-activate-error-silent)', async () => {
    const k = kit();
    const late = new DeferredPromise<void>();
    k.provideModule('fixture.slow', { activate: () => late.promise });
    await k.add(manifest('fixture.slow'));
    const errors = captureErrors();
    const activation = k.manager.activate('fixture.slow').catch((e: unknown) => e);
    for (let i = 0; i < 20; i++) await Promise.resolve(); // the entry load (bounded) ends, then activate() starts its own timer
    k.t.scheduler.advance(10_000); // the activate timeout
    expect(await activation).toMatchObject({ code: 'plugin.activationTimeout' });
    errors.drain();
    late.reject(new Error('rejected after the timeout'));
    await Promise.resolve();
    await Promise.resolve();
    const reported = errors.drain();
    errors.dispose();
    expect(reported.map((r) => [r.context.source, r.context.pluginId, r.context.target])).toEqual([['activation', 'fixture.slow', 'lateRejection']]);
  });

  it('C16: failed is final in the session (no auto retry); retry() goes back to resolved and activates a fixed plugin', async () => {
    const k = kit();
    let broken = true;
    k.provideModule('fixture.flaky', { activate: () => { if (broken) throw new Error('first time'); } });
    await k.add(manifest('fixture.flaky', { activationEvents: ['*'] }));
    const errors = captureErrors();
    await k.manager.activateByEvent('*');
    expect(k.manager.status('fixture.flaky')?.state).toBe('failed');
    await k.manager.activateByEvent('*'); // a failed plugin is not tried again
    expect(k.loads).toHaveLength(1);
    broken = false;
    await k.manager.retry('fixture.flaky');
    expect(k.manager.status('fixture.flaky')).toMatchObject({ state: 'active', failure: undefined });
    errors.drain();
    errors.dispose();
  });

  it('C16: a throwing activation interceptor fails the activation (activateThrew) and is reported', async () => {
    const k = kit();
    k.t.interceptors.register({ id: 'veto-all', kinds: ['activation'], mode: 'guard', phase: 'guard', async intercept() { throw new Error('policy says no'); } });
    k.provideModule('fixture.guarded', { activate: () => void 0 });
    await k.add(manifest('fixture.guarded'));
    const errors = captureErrors();
    await expect(k.manager.activate('fixture.guarded')).rejects.toBeDefined();
    expect(k.manager.status('fixture.guarded')?.state).toBe('failed');
    expect(k.loads).toEqual([]);
    errors.drain();
    errors.dispose();
  });

  it('C16: a throwing command handler rejects only that call; the plugin stays active and the error names the plugin', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    k.provideModule('fixture.cmd', {
      activate(ctx) {
        ctx.api.commands.registerHandler('fixture.cmd.run', {
          run(args: { fail: boolean }) {
            if (args.fail) throw new Error('handler broke');
            return 'fine';
          },
        });
      },
    });
    await k.add(withCommand('fixture.cmd'));
    const commands = k.t.window.get(CommandService);
    const errors = captureErrors();
    await expect(commands.execute('fixture.cmd.run', { fail: true })).rejects.toThrow('handler broke');
    expect(await commands.execute('fixture.cmd.run', { fail: false })).toBe('fine');
    expect(k.manager.status('fixture.cmd')?.state).toBe('active');
    expect(errors.drain().map((e) => e.context)).toEqual([expect.objectContaining({ source: 'command', pluginId: 'fixture.cmd' })]);
    errors.dispose();
  });
});

describe('C16: concurrency of activateByEvent', () => {
  it('C16: independent plugins activate in parallel, at most 4 at a time (2 for onStartupFinished)', async () => {
    for (const [event, limit] of [['*', 4], ['onStartupFinished', 2]] as const) {
      const k = kit();
      let running = 0;
      let peak = 0;
      const gates: DeferredPromise<void>[] = [];
      for (let i = 0; i < 6; i++) {
        const gate = new DeferredPromise<void>();
        gates.push(gate);
        k.provideModule(`fixture.p${i}`, {
          async activate() {
            running++;
            peak = Math.max(peak, running);
            await gate.promise;
            running--;
          },
        });
      }
      await k.add(...Array.from({ length: 6 }, (_, i) => manifest(`fixture.p${i}`, { activationEvents: [event] })));
      const all = k.manager.activateByEvent(event);
      for (let round = 0; round < 12; round++) {
        await new Promise((r) => setTimeout(r, 0));
        for (const g of gates) g.resolve();
      }
      await all;
      expect(peak, event).toBe(limit);
      expect([...k.manager.plugins.peek().values()].every((s) => s.state === 'active')).toBe(true);
      await k.t.dispose();
    }
  });

  it('C16: providers activate before consumers; the dependency is pulled in even if it listens to no event', async () => {
    const k = kit();
    const order: string[] = [];
    k.provideModule('fixture.provider', { activate: () => void order.push('provider') });
    k.provideModule('fixture.consumer', { activate: () => void order.push('consumer') });
    await k.add(
      manifest('fixture.consumer', { activationEvents: ['*'], requires: ['fixture/Thing'] }),
      manifest('fixture.provider', { provides: ['fixture/Thing'] }),
    );
    await k.manager.activateByEvent('*');
    expect(order).toEqual(['provider', 'consumer']);
  });
});

export type { PluginModule };

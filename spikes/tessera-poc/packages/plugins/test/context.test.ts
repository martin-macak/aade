import { describe, expect, it } from 'vitest';
import { token } from '@tessera/di';
import { CommandService, LifecyclePhase, EventBus, defineTopic, type PluginContext } from '@tessera/contracts';
import { manifest } from '@tessera/testing';
import { kit } from './kit.ts';

const Provided = token<number>('fixture/Provided');
const Other = token<number>('fixture/Other');
const topic = defineTopic<number>('fixture.ctx.topic');

async function activeContext(k: ReturnType<typeof kit>, id: string, extra?: Parameters<typeof manifest>[1]): Promise<PluginContext> {
  let captured: PluginContext | undefined;
  k.provideModule(id, { activate: (ctx) => void (captured = ctx) });
  await k.add(manifest(id, extra));
  await k.manager.activate(id);
  return captured as PluginContext;
}

describe('C19: plugin services and capabilities (unit)', () => {
  it('C19: ctx.services.get refuses a token that is neither declared nor public, with plugin.capabilityDenied', async () => {
    const k = kit();
    k.t.application.provideValue(Other, 1);
    const ctx = await activeContext(k, 'fixture.deny');
    expect(() => ctx.services.get(Other)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    expect(() => ctx.services.getOptional(Other)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    expect(ctx.services.get(CommandService)).toBeDefined(); // public token needs no declaration
  });

  it('C19: a declared token resolves; provide() accepts declared provides only and registers in the window scope', async () => {
    const k = kit();
    await k.add(manifest('fixture.other'));
    k.t.application.provideValue(Other, 5, { owner: 'fixture.other' }); // a plugin's registration: optional grants it
    const ctx = await activeContext(k, 'fixture.allow', { optional: ['fixture/Other'], provides: ['fixture/Provided'] });
    expect(ctx.services.get(Other)).toBe(5);
    expect(() => ctx.services.provide(Other, () => 1)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    ctx.services.provide(Provided, () => 99);
    expect(k.t.window.get(Provided)).toBe(99); // visible from the window scope, so from WorkItems and placements too
  });

  it('C29: the plugin gets no container: ctx.services has no scope member (the plugin scope is internal)', async () => {
    const k = kit();
    const ctx = await activeContext(k, 'fixture.private');
    expect('scope' in ctx.services).toBe(false);
    expect(Object.keys(ctx.services).sort()).toEqual(['get', 'getAll', 'getOptional', 'observeAll', 'provide', 'provideMany']);
  });

  it('C18: context keys need the plugin id prefix unless the capability context.global is granted', async () => {
    const k = kit();
    const plain = await activeContext(k, 'fixture.keys');
    plain.api.context.set('fixture.keys.ok', true);
    expect(() => plain.api.context.set('other.key', true)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    const global = await activeContext(k, 'fixture.global', { capabilities: ['context.global'] });
    expect(() => global.api.context.set('other.key', true)).not.toThrow();
  });

  it('C18: interceptors must be declared (plugin.undeclaredInterceptor); a guard needs the capability interceptors.guard (plugin.capabilityDenied)', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const decl = (mode: 'guard' | 'observer') => ({ interceptors: [{ id: 'watch', kinds: ['command'], match: '**', mode }] });
    const noCap = await activeContext(k, 'fixture.nocap', { contributes: decl('guard') });
    expect(() => noCap.interceptors.register('undeclared', async (_c, next) => next())).toThrowError(expect.objectContaining({ code: 'plugin.undeclaredInterceptor' }));
    expect(() => noCap.interceptors.register('watch', async (_c, next) => next())).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    const withCap = await activeContext(k, 'fixture.withcap', { capabilities: ['interceptors.guard'], contributes: decl('guard') });
    const registration = withCap.interceptors.register('watch', async (_c, next) => next());
    expect(k.t.interceptors.list('command').some((i) => i.id === 'fixture.withcap:watch' && i.owner === 'fixture.withcap')).toBe(true);
    registration.dispose();
    expect(k.t.interceptors.list('command').some((i) => i.id === 'fixture.withcap:watch')).toBe(false);
  });

  it('C18: an observer interceptor sees command executions and its registration is removed on deactivation', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const seen: string[] = [];
    k.provideModule('fixture.watch', {
      activate(ctx) {
        ctx.interceptors.register('watch', async (c, next) => {
          seen.push(c.target);
          return next();
        });
        ctx.api.commands.registerHandler('fixture.watch.run', { run: () => 1 });
      },
    });
    await k.add(manifest('fixture.watch', { contributes: { commands: [{ id: 'fixture.watch.run', title: 'Run' }], interceptors: [{ id: 'watch', kinds: ['command'], match: '**' }] } }));
    await k.t.window.get(CommandService).execute('fixture.watch.run');
    expect(seen).toEqual(['fixture.watch.run']);
    await k.manager.deactivate('fixture.watch');
    expect(k.t.interceptors.list('command').filter((i) => i.owner === 'fixture.watch')).toEqual([]);
  });

  it('C16: events published through the facade reach subscribers; a throwing subscriber is attributed to its plugin and does not hurt others', async () => {
    const k = kit();
    const seen: number[] = [];
    const bad = await activeContext(k, 'fixture.badsub');
    bad.api.events.subscribe(topic, () => {
      throw new Error('subscriber broke');
    });
    const good = await activeContext(k, 'fixture.goodsub');
    good.api.events.subscribe(topic, (n) => void seen.push(n));
    const { captureErrors } = await import('@tessera/testing');
    const errors = captureErrors();
    good.api.events.publish(topic, 42);
    expect(seen).toEqual([42]);
    const reported = errors.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'subscriber', pluginId: 'fixture.badsub' });
    errors.dispose();
    void EventBus;
  });

  it('C17: plugin storage keys are namespaced plugin:<id>:<key> in the matching scope', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const ctx = await activeContext(k, 'fixture.store');
    const schema = { version: 1, schema: { safeParse: (i: unknown) => (typeof i === 'number' ? { success: true as const, data: i } : { success: false as const, error: { issues: [] } }) }, initial: () => 0 };
    ctx.storage.project.set('counter', 5, schema);
    expect(ctx.storage.project.get('counter', schema)).toBe(5);
    expect(ctx.storage.project.keys()).toEqual(['counter']);
    const { StorageService } = await import('@tessera/contracts');
    expect(k.t.window.get(StorageService).keys('project', 'plugin:fixture.store:')).toEqual(['plugin:fixture.store:counter']);
    expect(k.t.window.get(StorageService).keys('application', 'plugin:fixture.store:')).toEqual([]);
  });
});

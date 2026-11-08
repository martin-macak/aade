import { describe, expect, it } from 'vitest';
import { DeferredPromise, type TesseraError } from '@tessera/base';
import { captureErrors, createTestScope } from '@tessera/testing';
import { createInterceptorRegistry, type Interceptor } from '@tessera/interceptors';
import { commandData } from './kit.ts';

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function setup(options?: Parameters<typeof createInterceptorRegistry>[0]) {
  const t = createTestScope({ flat: true });
  const registry = createInterceptorRegistry(options);
  const run = (target = 'tasks.add', terminal: () => Promise<string> = async () => 'result') => registry.run(registry.createContext('command', target, commandData(target, 1)), terminal);
  return { t, registry, run };
}

describe('C9: an observer cannot hang the pipeline (observer-interceptor-hangs-pipeline)', () => {
  it('C9: an observer that never settles is cut off after 200 ms: the command runs, and one report names the plugin', async () => {
    const { t, registry, run } = setup();
    const errors = captureErrors();
    const hung: Interceptor<'command', string> = { id: 'hung', kinds: ['command'], mode: 'observer', owner: 'acme.audit', intercept: () => new Promise<string>(() => undefined) };
    registry.register(hung);
    let ran = 0;
    const result = run('tasks.add', async () => (ran++, 'result'));
    await ticks();
    expect(ran).toBe(0); // the observer holds the pipeline until its budget is used
    t.scheduler.advance(199);
    await ticks();
    expect(ran).toBe(0);
    t.scheduler.advance(1);
    await expect(result).resolves.toBe('result');
    expect(ran).toBe(1);
    const reported = errors.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'interceptor.observerTimeout' });
    expect(reported[0]?.context).toMatchObject({ source: 'interceptor', pluginId: 'acme.audit' });
    // the second invocation is cut off again, but the report is not repeated
    const second = run();
    await ticks();
    t.scheduler.advance(200);
    await expect(second).resolves.toBe('result');
    expect(errors.drain()).toEqual([]);
    errors.dispose();
  });

  it('C9: the time behind next() does not count: an observer that awaits a slow command is not cut off', async () => {
    const { t, registry, run } = setup();
    const errors = captureErrors();
    const seen: string[] = [];
    registry.register<'command', string>({
      id: 'timing',
      kinds: ['command'],
      mode: 'observer',
      async intercept(_c, next) {
        const value = await next();
        seen.push(`after ${value}`);
        return value;
      },
    });
    const gate = new DeferredPromise<string>();
    const result = run('tasks.add', () => gate.promise);
    await ticks();
    t.scheduler.advance(5000); // far above the budget, but the observer itself is idle
    gate.resolve('slow result');
    await expect(result).resolves.toBe('slow result');
    await ticks();
    expect(seen).toEqual(['after slow result']);
    expect(errors.drain()).toEqual([]);
    errors.dispose();
  });

  it('C9: an observer that hangs after next() returned does not hold back the result', async () => {
    const { t, registry, run } = setup();
    const errors = captureErrors();
    registry.register<'command', string>({
      id: 'tail',
      kinds: ['command'],
      mode: 'observer',
      async intercept(_c, next) {
        await next();
        await new Promise<void>(() => undefined);
        return 'never';
      },
    });
    const result = run();
    await ticks();
    t.scheduler.advance(200);
    await expect(result).resolves.toBe('result');
    expect(errors.drain().map((e) => (e.error as TesseraError).code)).toEqual(['interceptor.observerTimeout']);
    errors.dispose();
  });

  it('C9: an aborted invocation ends the wait for the observer at once', async () => {
    const { registry } = setup();
    const errors = captureErrors();
    registry.register<'command', string>({ id: 'hung', kinds: ['command'], mode: 'observer', intercept: () => new Promise<string>(() => undefined) });
    const abort = new AbortController();
    const result = registry.run(registry.createContext('command', 'tasks.add', commandData('tasks.add'), { signal: abort.signal }), async () => 'result');
    await ticks();
    abort.abort();
    await expect(result).resolves.toBe('result');
    errors.drain();
    errors.dispose();
  });

  it('C9: the budget is configurable (observerBudgetMs)', async () => {
    const { t, registry, run } = setup({ observerBudgetMs: 50 });
    const errors = captureErrors();
    registry.register<'command', string>({ id: 'hung', kinds: ['command'], mode: 'observer', intercept: () => new Promise<string>(() => undefined) });
    const result = run();
    await ticks();
    t.scheduler.advance(50);
    await expect(result).resolves.toBe('result');
    errors.drain();
    errors.dispose();
  });
});

describe('C9: a guard may have a time limit (timeoutMs)', () => {
  it('C9: a guard that does not decide in time rejects the invocation with interceptor.guardTimeout', async () => {
    const { t, registry, run } = setup();
    registry.register<'command', string>({ id: 'slow-guard', kinds: ['command'], mode: 'guard', timeoutMs: 100, intercept: () => new Promise<string>(() => undefined) });
    let ran = false;
    const result = run('tasks.add', async () => (ran = true, 'result'));
    const settled = result.then(
      () => undefined,
      (e: unknown) => e as TesseraError,
    );
    await ticks();
    t.scheduler.advance(100);
    const failure = await settled;
    expect(failure).toMatchObject({ code: 'interceptor.guardTimeout' });
    expect(ran).toBe(false);
  });

  it('C9: the time behind next() does not count for a guard either', async () => {
    const { t, registry, run } = setup();
    registry.register<'command', string>({ id: 'guard', kinds: ['command'], mode: 'guard', timeoutMs: 100, intercept: (_c, next) => next() });
    const gate = new DeferredPromise<string>();
    const result = run('tasks.add', () => gate.promise);
    await ticks();
    t.scheduler.advance(1000);
    gate.resolve('late but fine');
    await expect(result).resolves.toBe('late but fine');
  });
});

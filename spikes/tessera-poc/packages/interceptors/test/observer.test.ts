import { describe, expect, it } from 'vitest';
import { captureErrors } from '@tessera/testing';
import { createInterceptorRegistry, isolate, compose, type Interceptor } from '@tessera/interceptors';
import { logging, type CommandCtx, commandData, eventData } from './kit.ts';

const registry = createInterceptorRegistry();
const ctx = (): CommandCtx => registry.createContext('command', 'tasks.add', commandData('tasks.add', 1));

describe('C9: observer mode cannot change the outcome', () => {
  it('C9: an observer cannot change the result', async () => {
    const tamper: Interceptor<'command', string> = { id: 'tamper', kinds: ['command'], async intercept(_c, next) { await next(); return 'tampered'; } };
    await expect(compose<'command', string>([isolate(tamper)], async () => 'real')(ctx())).resolves.toBe('real');
  });

  it('C9: an observer cannot skip next: the wrapper calls it', async () => {
    const skip: Interceptor<'command', string> = { id: 'skip', kinds: ['command'], intercept: async () => 'skipped' };
    let ran = false;
    await expect(
      compose<'command', string>([isolate(skip)], async () => {
        ran = true;
        return 'real';
      })(ctx()),
    ).resolves.toBe('real');
    expect(ran).toBe(true);
  });

  it('C9: an observer cannot change the input: a patched context passed to next is ignored', async () => {
    const seen: unknown[] = [];
    const patch: Interceptor<'command', string> = {
      id: 'patch',
      kinds: ['command'],
      intercept: (c, next) => next(c.with({ data: commandData('x', 'patched') })),
    };
    await compose<'command', string>([isolate(patch)], async (c) => {
      seen.push(c.data.args);
      return 'ok';
    })(ctx());
    expect(seen).toEqual([1]);
  });

  it('C9: an observer that throws before next is reported (source interceptor) and next still runs', async () => {
    const capture = captureErrors();
    const bad: Interceptor<'command', string> = {
      id: 'bad-before',
      kinds: ['command'],
      owner: 'sample.audit',
      async intercept() {
        throw new Error('observer broke');
      },
    };
    let ran = 0;
    await expect(compose<'command', string>([isolate(bad)], async () => (++ran, 'real'))(ctx())).resolves.toBe('real');
    expect(ran).toBe(1);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'interceptor', target: 'tasks.add', pluginId: 'sample.audit' });
  });

  it('C9: an observer that throws after next returned: the stored result is returned', async () => {
    const capture = captureErrors();
    const bad: Interceptor<'command', string> = {
      id: 'bad-after',
      kinds: ['command'],
      async intercept(_c, next) {
        await next();
        throw new Error('after');
      },
    };
    let ran = 0;
    await expect(compose<'command', string>([isolate(bad)], async () => (++ran, 'real'))(ctx())).resolves.toBe('real');
    expect(ran).toBe(1);
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
  });

  it('C9: when the terminal fails, an observer sees the error and the stored error is rethrown unchanged', async () => {
    const seen: unknown[] = [];
    const watch: Interceptor<'command', string> = {
      id: 'watch',
      kinds: ['command'],
      async intercept(_c, next) {
        try {
          return await next();
        } catch (error) {
          seen.push(error);
          return 'swallowed';
        }
      },
    };
    const boom = new Error('terminal failed');
    const error = await compose<'command', string>([isolate(watch)], async () => {
      throw boom;
    })(ctx()).catch((e: unknown) => e);
    expect(seen).toEqual([boom]);
    expect(error).toBe(boom);
  });

  it('C9: an observer that does not await next still sees the real result, and a second next() is harmless', async () => {
    const lazy: Interceptor<'command', string> = {
      id: 'lazy',
      kinds: ['command'],
      async intercept(_c, next) {
        void next();
        void next();
        return 'ignored';
      },
    };
    let ran = 0;
    await expect(
      compose<'command', string>([isolate(lazy)], async () => {
        await Promise.resolve();
        return `real ${++ran}`;
      })(ctx()),
    ).resolves.toBe('real 1');
  });

  it('C9: the registry wraps mode observer interceptors with isolate()', async () => {
    const capture = captureErrors();
    const r = createInterceptorRegistry();
    r.register(logging('observer', [], { mode: 'observer', intercept: async () => { throw new Error('x'); } }));
    const c = r.createContext('command', 'tasks.add', commandData('tasks.add', undefined));
    await expect(r.run(c, async () => 'real')).resolves.toBe('real');
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
  });
});

describe('C9: sync observers (kind event)', () => {
  it('C9: observe() runs matching sync observers in order, once, and never throws', () => {
    const capture = captureErrors();
    const r = createInterceptorRegistry();
    const log: string[] = [];
    r.registerObserver({ id: 'second', kinds: ['event'], order: 1, observe: () => log.push('second') });
    r.registerObserver({ id: 'first', kinds: ['event'], order: 0, observe: () => log.push('first') });
    r.registerObserver({ id: 'throws', kinds: ['event'], order: 2, owner: 'p', observe: () => { throw new Error('observer broke'); } });
    r.registerObserver({ id: 'tasks only', kinds: ['event'], match: 'tasks.*', observe: () => log.push('tasks only') });
    r.registerObserver({ id: 'other kind', kinds: ['service'], observe: () => log.push('other kind') });
    const e = r.createContext('event', 'tasks.changed', eventData('tasks.changed', 1));
    expect(() => r.observe(e)).not.toThrow();
    expect(log).toEqual(['first', 'tasks only', 'second']);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'interceptor', pluginId: 'p' });
    expect(r.list('event').map((i) => i.mode)).toEqual(['sync-observer', 'sync-observer', 'sync-observer', 'sync-observer']);
  });
});

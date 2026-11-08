import { describe, expect, it, vi } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { createInterceptorRegistry, compose, type Interceptor } from '@tessera/interceptors';
import { commandData } from './kit.ts';
import type { CommandCtx } from './kit.ts';

const registry = createInterceptorRegistry({ maxDepth: 3 });
const ctx = (parent?: CommandCtx): CommandCtx =>
  registry.createContext('command', 'tasks.add', commandData('tasks.add', undefined), parent ? { parent } : undefined);

describe('C9: pipeline guards', () => {
  it('C9: calling next twice rejects with interceptor.nextTwice', async () => {
    const twice: Interceptor<'command', string> = {
      id: 'twice',
      kinds: ['command'],
      async intercept(_c, next) {
        await next();
        return next();
      },
    };
    const error = (await compose<'command', string>([twice], async () => 'x')(ctx()).catch((e: unknown) => e)) as { code: string; interceptorId: string };
    expect(error.code).toBe('interceptor.nextTwice');
    expect(error.interceptorId).toBe('twice');
  });

  it('C9: the invocation fails with nextTwice even when the interceptor ignores the second rejection', async () => {
    const sloppy: Interceptor<'command', string> = {
      id: 'sloppy',
      kinds: ['command'],
      async intercept(_c, next) {
        const first = await next();
        await next().catch(() => {});
        return first;
      },
    };
    await expect(compose<'command', string>([sloppy], async () => 'x')(ctx())).rejects.toMatchObject({ code: 'interceptor.nextTwice' });
  });

  it('C9: a missing await rejects with interceptor.missingAwait', async () => {
    let finished = false;
    const forgetful: Interceptor<'command', string> = {
      id: 'forgetful',
      kinds: ['command'],
      async intercept(_c, next) {
        void next(); // no await: the interceptor settles before the downstream work does
        return 'early';
      },
    };
    const gate = new DeferredPromise<void>();
    const slow = compose<'command', string>([forgetful], async () => {
      await gate.promise;
      finished = true;
      return 'late';
    });
    const error = (await slow(ctx()).catch((e: unknown) => e)) as { code: string; interceptorId: string };
    expect(error.code).toBe('interceptor.missingAwait');
    expect(error.interceptorId).toBe('forgetful');
    expect(finished).toBe(false);
    gate.resolve(); // the downstream work still runs to its end after the failure
    await vi.waitFor(() => expect(finished).toBe(true));
  });

  it('C9: returning the next() promise without await is fine (it settles together with the downstream work)', async () => {
    const passthrough: Interceptor<'command', string> = { id: 'pass', kinds: ['command'], intercept: (_c, next) => next() };
    await expect(compose<'command', string>([passthrough], async () => 'ok')(ctx())).resolves.toBe('ok');
  });

  it('C9: an interceptor that never calls next is not a missing await', async () => {
    const deny: Interceptor<'command', string> = { id: 'deny', kinds: ['command'], intercept: async () => 'denied' };
    await expect(compose<'command', string>([deny], async () => 'x')(ctx())).resolves.toBe('denied');
  });

  it('C9: createContext sets depth from the parent and run() rejects above maxDepth with interceptor.depth', async () => {
    let current = ctx();
    expect(current.depth).toBe(0);
    for (let i = 1; i <= 3; i++) {
      current = ctx(current);
      expect(current.depth).toBe(i);
      expect(current.traceId).toBe(current.parent?.traceId);
    }
    await expect(registry.run(current, async () => 'depth 3 is allowed')).resolves.toBe('depth 3 is allowed');
    const tooDeep = ctx(current);
    expect(tooDeep.depth).toBe(4);
    await expect(registry.run(tooDeep, async () => 'never')).rejects.toMatchObject({ code: 'interceptor.depth' });
  });

  it('C9: the default depth limit is 8', async () => {
    const defaultRegistry = createInterceptorRegistry();
    let current = defaultRegistry.createContext('command', 'x', commandData('x', undefined));
    for (let i = 0; i < 8; i++) current = defaultRegistry.createContext('command', 'x', commandData('x', undefined), { parent: current });
    await expect(defaultRegistry.run(current, async () => 1)).resolves.toBe(1);
    const tooDeep = defaultRegistry.createContext('command', 'x', commandData('x', undefined), { parent: current });
    await expect(defaultRegistry.run(tooDeep, async () => 1)).rejects.toMatchObject({ code: 'interceptor.depth' });
  });

  it('C9: async interceptors registered for kind event are rejected with interceptor.kindMismatch', () => {
    const r = createInterceptorRegistry();
    expect(() => r.register({ id: 'async-event', kinds: ['event'], intercept: (_c, next) => next() })).toThrow(
      expect.objectContaining({ code: 'interceptor.kindMismatch', interceptorId: 'async-event' }),
    );
    expect(() => r.register({ id: 'mixed', kinds: ['command', 'event'], intercept: (_c, next) => next() })).toThrow(
      expect.objectContaining({ code: 'interceptor.kindMismatch' }),
    );
  });
});

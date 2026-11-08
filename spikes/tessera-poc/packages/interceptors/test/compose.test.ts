import { describe, expect, it } from 'vitest';
import { createInterceptorRegistry, compose } from '@tessera/interceptors';
import { commandData, logging, type CommandCtx } from './kit.ts';

const registry = createInterceptorRegistry();
const ctx = (): CommandCtx => registry.createContext('command', 'tasks.add', commandData('tasks.add', { title: 'a' }));

describe('C9: compose runs the onion, first is outermost', () => {
  it('C9: runs interceptors outside in, the terminal, then inside out', async () => {
    const log: string[] = [];
    const run = compose<'command', string>([logging('a', log), logging('b', log), logging('c', log)], async () => {
      log.push('terminal');
      return 'result';
    });
    await expect(run(ctx())).resolves.toBe('result');
    expect(log).toEqual(['a in', 'b in', 'c in', 'terminal', 'c out', 'b out', 'a out']);
  });

  it('C9: with no interceptors the terminal runs', async () => {
    await expect(compose<'command', string>([], async () => 'direct')(ctx())).resolves.toBe('direct');
  });

  it('C9: an interceptor can pass a changed copy of the context downstream with ctx.with()', async () => {
    const seen: unknown[] = [];
    const run = compose<'command', string>(
      [
        {
          id: 'rewrite',
          kinds: ['command'],
          intercept: (c, next) => next(c.with({ data: commandData(c.data.commandId, { title: 'rewritten' }) })),
        },
      ],
      async (c) => {
        seen.push(c.data.args);
        return 'ok';
      },
    );
    const original = ctx();
    await run(original);
    expect(seen).toEqual([{ title: 'rewritten' }]);
    expect(original.data.args).toEqual({ title: 'a' }); // the original is untouched
  });

  it('C9: context data is read-only and with() shares the meta notes', async () => {
    const original = ctx();
    expect(Object.isFrozen(original.data)).toBe(true);
    const key = Symbol('note');
    original.meta.set(key, 1);
    const copy = original.with({ target: 'other' });
    expect(copy.target).toBe('other');
    expect(copy.meta.get(key)).toBe(1);
    copy.meta.set(key, 2);
    expect(original.meta.get(key)).toBe(2);
    expect(copy.traceId).toBe(original.traceId);
  });

  it('C9: a guard may skip next and answer itself (deny, cache, mock)', async () => {
    const log: string[] = [];
    const run = compose<'command', string>(
      [
        { id: 'cache', kinds: ['command'], intercept: async () => 'cached' },
        logging('never reached', log),
      ],
      async () => {
        log.push('terminal');
        return 'fresh';
      },
    );
    await expect(run(ctx())).resolves.toBe('cached');
    expect(log).toEqual([]);
  });

  it('C9: an error from the terminal passes through every interceptor unchanged', async () => {
    const boom = new Error('terminal failed');
    const run = compose<'command', string>([logging('a', []), logging('b', [])], async () => {
      throw boom;
    });
    await expect(run(ctx())).rejects.toBe(boom);
  });

  it('C9: an error thrown by an interceptor is wrapped in InterceptorError with its id and the original as cause', async () => {
    const original = new Error('bad interceptor');
    const run = compose<'command', string>(
      [
        {
          id: 'broken',
          kinds: ['command'],
          intercept: async () => {
            throw original;
          },
        },
      ],
      async () => 'x',
    );
    const error = (await run(ctx()).catch((e: unknown) => e)) as { code: string; interceptorId: string; cause: unknown };
    expect(error.code).toBe('interceptor.failed');
    expect(error.interceptorId).toBe('broken');
    expect(error.cause).toBe(original);
  });

  it('C9: an interceptor that maps a downstream error produces an InterceptorError that keeps the mapped error as cause', async () => {
    const mapped = new Error('mapped');
    const run = compose<'command', string>(
      [
        {
          id: 'mapper',
          kinds: ['command'],
          async intercept(_c, next) {
            try {
              return await next();
            } catch {
              throw mapped;
            }
          },
        },
      ],
      async () => {
        throw new Error('raw');
      },
    );
    const error = (await run(ctx()).catch((e: unknown) => e)) as { cause: unknown; code: string };
    expect(error.code).toBe('interceptor.failed');
    expect(error.cause).toBe(mapped);
  });
});

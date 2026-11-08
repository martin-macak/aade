import { describe, expect, it } from 'vitest';
import { createInterceptorRegistry } from '@tessera/interceptors';
import { logging, commandData } from './kit.ts';

describe('C9: fast path', () => {
  it('C9: with no match the terminal is called directly with the same context object', async () => {
    const registry = createInterceptorRegistry();
    registry.register(logging('other', [], { match: 'other.*' }));
    const ctx = registry.createContext('command', 'tasks.add', commandData('tasks.add', undefined));
    let received: unknown;
    const result = await registry.run(ctx, async (c) => {
      received = c;
      return 'direct';
    });
    expect(result).toBe('direct');
    expect(received).toBe(ctx);
  });

  it('C9: with no interceptors at all, run() returns the terminal promise itself (no wrapping)', () => {
    const registry = createInterceptorRegistry();
    const ctx = registry.createContext('command', 'tasks.add', commandData('tasks.add', undefined));
    const terminalPromise = Promise.resolve('x');
    expect(registry.run(ctx, () => terminalPromise)).toBe(terminalPromise);
  });

  it('C9: a registration change clears the cached chain: a new interceptor applies to the next run', async () => {
    const registry = createInterceptorRegistry();
    const log: string[] = [];
    const ctx = () => registry.createContext('command', 'tasks.add', commandData('tasks.add', undefined));
    await registry.run(ctx(), async () => log.push('terminal'));
    const handle = registry.register(logging('added later', log));
    await registry.run(ctx(), async () => log.push('terminal'));
    handle.dispose();
    await registry.run(ctx(), async () => log.push('terminal'));
    expect(log).toEqual(['terminal', 'added later in', 'terminal', 'added later out', 'terminal']);
  });

  it('createContext defaults: source api, depth 0, a fresh trace id, a signal that never aborts', () => {
    const registry = createInterceptorRegistry();
    const a = registry.createContext('command', 'x', commandData('x', undefined));
    const b = registry.createContext('command', 'x', commandData('x', undefined), { source: 'palette' });
    expect(a.source).toBe('api');
    expect(b.source).toBe('palette');
    expect(a.depth).toBe(0);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.signal.aborted).toBe(false);
  });
});

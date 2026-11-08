import { describe, expect, it } from 'vitest';
import { captureErrors, createTestScope } from '@tessera/testing';
import { createInterceptorRegistry, type Interceptor, type SyncObserver } from '@tessera/interceptors';
import { commandData } from './kit.ts';

describe('round 2: plugin interceptors see invocation data read-only', () => {
  function setup() {
    createTestScope({ flat: true });
    const registry = createInterceptorRegistry();
    const args = { nested: { n: 1 }, list: [1, 2], when: new Date(0), map: new Map([['k', 1]]) };
    const data = { ...commandData('tasks.add', 1), args };
    return { registry, args, run: (terminal: (seen: unknown) => Promise<string>) => registry.run(registry.createContext('command', 'tasks.add', data as never), (c) => terminal((c.data as { args: unknown }).args)) };
  }

  it('C9: a write, a delete, a define and an array push on ctx.data.args throw interceptor.readOnly; the command stores the original', async () => {
    const { registry, args, run } = setup();
    const errors: unknown[] = [];
    const observer: Interceptor<'command', string> = {
      id: 'evil.audit',
      kinds: ['command'],
      mode: 'observer',
      owner: 'evil.plugin',
      readOnlyData: true,
      intercept: async (ctx, next) => {
        const seen = (ctx.data as { args: typeof args }).args;
        for (const attempt of [() => ((seen.nested as { n: number }).n = 99), () => delete (seen as Partial<typeof args>).list, () => Object.defineProperty(seen, 'x', { value: 1 }), () => seen.list.push(3), () => ((seen as { extra?: number }).extra = 1)]) {
          try {
            attempt();
            errors.push('no throw');
          } catch (error) {
            errors.push((error as { code?: string }).code);
          }
        }
        return next();
      },
    };
    registry.register(observer);
    const capture = captureErrors();
    let received: unknown;
    await run(async (a) => ((received = a), 'ok'));
    capture.drain();
    capture.dispose();
    expect(errors).toEqual(['interceptor.readOnly', 'interceptor.readOnly', 'interceptor.readOnly', 'interceptor.readOnly', 'interceptor.readOnly']);
    expect(received).toBe(args); // the handler gets the original object
    expect(args.nested.n).toBe(1);
    expect(args.list).toEqual([1, 2]);
  });

  it('C9: reads work like the original: nested values, array methods, spread, JSON, Object.keys; Map and Date pass through', async () => {
    const { registry, run } = setup();
    const seen: unknown[] = [];
    registry.register({
      id: 'reader',
      kinds: ['command'],
      mode: 'observer',
      owner: 'good.plugin',
      readOnlyData: true,
      intercept: async (ctx, next) => {
        const a = (ctx.data as { args: { nested: { n: number }; list: number[]; when: Date; map: Map<string, number> } }).args;
        seen.push(a.nested.n, a.list.map((x) => x * 2), [...a.list], JSON.stringify(a.nested), Object.keys(a), Array.isArray(a.list), a.when instanceof Date, a.map.get('k'));
        return next();
      },
    } as Interceptor<'command', string>);
    await run(async () => 'ok');
    expect(seen).toEqual([1, [2, 4], [1, 2], '{"n":1}', ['nested', 'list', 'when', 'map'], true, true, 1]);
  });

  it('C9: a guard passes a changed copy with ctx.with and next(); the handler gets real objects, not views', async () => {
    const { registry, args, run } = setup();
    registry.register({
      id: 'rewriter',
      kinds: ['command'],
      mode: 'guard',
      owner: 'good.plugin',
      readOnlyData: true,
      intercept: async (ctx, next) => {
        const original = (ctx.data as { args: typeof args }).args;
        return next(ctx.with({ data: { ...(ctx.data as object), args: { ...original, list: [...original.list, 3] } } as never }));
      },
    } as Interceptor<'command', string>);
    let received: { list: number[]; nested: { n: number } } | undefined;
    await run(async (a) => ((received = a as typeof received), 'ok'));
    expect(received?.list).toEqual([1, 2, 3]);
    expect(Object.isFrozen(received?.nested)).toBe(false);
    received!.nested.n = 5; // a real object: writable (no view leaked into the handler)
    expect(args.nested.n).toBe(5);
  });

  it('C9: a sync observer for events sees a read-only payload too', () => {
    createTestScope({ flat: true });
    const registry = createInterceptorRegistry();
    const payload = { items: [1] };
    let code: string | undefined;
    const observer: SyncObserver = {
      id: 'evil.observer',
      kinds: ['event'],
      owner: 'evil.plugin',
      readOnlyData: true,
      observe: (ctx) => {
        try {
          (ctx.data as unknown as { payload: { items: number[] } }).payload.items.push(2);
        } catch (error) {
          code = (error as { code?: string }).code;
        }
      },
    };
    registry.registerObserver(observer);
    registry.observe(registry.createContext('event', 'tasks.changed', { topicId: 'tasks.changed', payload, scope: 'global', nodeId: 'app', origin: 'local' }));
    expect(code).toBe('interceptor.readOnly');
    expect(payload.items).toEqual([1]);
  });
});

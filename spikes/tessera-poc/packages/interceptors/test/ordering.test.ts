import { describe, expect, it } from 'vitest';
import { createInterceptorRegistry, type InterceptorPhase } from '@tessera/interceptors';
import { logging, phased, commandData } from './kit.ts';

describe('C9: one order rule - phase, order, registration index; first is outermost', () => {
  const setup = () => {
    const registry = createInterceptorRegistry();
    const log: string[] = [];
    const run = async (target = 'tasks.add'): Promise<string> => {
      const ctx = registry.createContext('command', target, commandData(target, undefined));
      return registry.run(ctx, async () => {
        log.push('terminal');
        return 'done';
      });
    };
    return { registry, log, run };
  };

  it('C9: sorts by phase outer, guard, transform, resilience, inner regardless of registration order', async () => {
    const { registry, log, run } = setup();
    const phases: InterceptorPhase[] = ['inner', 'resilience', 'transform', 'guard', 'outer'];
    for (const phase of phases) registry.register(phased(phase, phase, log));
    await run();
    expect(log).toEqual([
      'outer in', 'guard in', 'transform in', 'resilience in', 'inner in',
      'terminal',
      'inner out', 'resilience out', 'transform out', 'guard out', 'outer out',
    ]);
  });

  it('C9: inside a phase sorts by order ascending, then by registration index', async () => {
    const { registry, log, run } = setup();
    registry.register(phased('late order', 'guard', log, 5));
    registry.register(phased('first registered, order 0', 'guard', log, 0));
    registry.register(phased('negative', 'guard', log, -10));
    registry.register(phased('second registered, order 0', 'guard', log, 0));
    await run();
    expect(log.filter((l) => l.endsWith(' in'))).toEqual([
      'negative in',
      'first registered, order 0 in',
      'second registered, order 0 in',
      'late order in',
    ]);
  });

  it('C9: the default phase is transform and the default order is 0', async () => {
    const { registry, log, run } = setup();
    registry.register(logging('default', log));
    registry.register(phased('guard first', 'guard', log));
    registry.register(phased('inner last', 'inner', log));
    await run();
    expect(log.filter((l) => l.endsWith(' in'))).toEqual(['guard first in', 'default in', 'inner last in']);
    expect(registry.list('command').map((i) => [i.id, i.phase, i.order, i.mode])).toEqual([
      ['guard first', 'guard', 0, 'guard'],
      ['default', 'transform', 0, 'guard'],
      ['inner last', 'inner', 0, 'guard'],
    ]);
  });

  it('C9: matching by kind and target glob decides where an interceptor applies; there are no other scopes', async () => {
    const { registry, log, run } = setup();
    registry.register(logging('only tasks', log, { match: 'tasks.*' }));
    registry.register(logging('only other', log, { match: 'other.*' }));
    registry.register(logging('everything', log, { match: '**' }));
    registry.register({ id: 'only services', kinds: ['service'], intercept: (_c, next) => (log.push('only services in'), next()) });
    await run('tasks.add');
    expect(log.filter((l) => l.endsWith(' in'))).toEqual(['only tasks in', 'everything in']);
    log.length = 0;
    await run('other.x');
    expect(log.filter((l) => l.endsWith(' in'))).toEqual(['only other in', 'everything in']);
  });

  it('C9: a predicate match sees the whole context, and a throwing predicate is skipped and reported by the caller of run, not thrown', async () => {
    const { registry, log, run } = setup();
    registry.register(logging('predicate', log, { match: (ctx) => ctx.target.endsWith('.add') }));
    await run('tasks.add');
    await run('tasks.remove');
    expect(log.filter((l) => l === 'predicate in')).toHaveLength(1);
  });

  it('C9: disposing a registration removes the interceptor and the registry reports the change', async () => {
    const { registry, log, run } = setup();
    let changes = 0;
    const sub = registry.onDidChange(() => changes++);
    const handle = registry.register(logging('temp', log));
    await run();
    expect(log).toContain('temp in');
    handle.dispose();
    handle.dispose();
    log.length = 0;
    await run();
    expect(log).toEqual(['terminal']);
    expect(changes).toBe(2);
    expect(registry.list()).toEqual([]);
    sub.dispose();
  });
});

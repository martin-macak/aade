import { describe, expect, it } from 'vitest';
import { injectScope, multiToken, token, type Scope } from '@tessera/di';
import { errorOf, useRoots } from './helpers.ts';

function disposable(name: string, log: string[], extra?: () => void): { dispose(): void } {
  return {
    dispose() {
      log.push(name);
      extra?.();
    },
  };
}

describe('C3: scope disposal', () => {
  const root = useRoots();

  it('C3: disposes children first (reverse creation order), then owned instances in reverse creation order', async () => {
    const log: string[] = [];
    const First = token<object>('d.first');
    const Second = token<object>('d.second');
    const app = root();
    app.provide(First, () => disposable('app first', log));
    app.provide(Second, () => disposable('app second', log));
    const c1 = app.createChild('workItem', 'c1');
    const c2 = app.createChild('workItem', 'c2');
    c1.provide(token<object>('d.c1'), () => disposable('c1 service', log));
    c2.provide(token<object>('d.c2'), () => disposable('c2 service', log));
    app.get(First);
    app.get(Second);
    c1.get(token<object>('d.c1'));
    c2.get(token<object>('d.c2'));
    await app.dispose();
    expect(log).toEqual(['c2 service', 'c1 service', 'app second', 'app first']);
    expect(app.state).toBe('disposed');
    expect(c1.state).toBe('disposed');
  });

  it('C3: nested children are disposed deepest first', async () => {
    const log: string[] = [];
    const app = root();
    const a = app.createChild('workItem', 'a');
    const b = a.createChild('view', 'b');
    const c = b.createChild('placement', 'c');
    for (const [scope, name] of [[app, 'app'], [a, 'a'], [b, 'b'], [c, 'c']] as const) {
      scope.onWillDispose(() => log.push(`will ${name}`));
      const T = token<object>(`d.${name}`);
      scope.provide(T, () => disposable(name, log));
      scope.get(T);
    }
    await app.dispose();
    expect(log).toEqual(['will app', 'will a', 'will b', 'will c', 'c', 'b', 'a', 'app']);
  });

  it('C3: errors are collected, everything is still disposed, and one AggregateError is thrown at the end', async () => {
    const log: string[] = [];
    const app = root();
    const child = app.createChild('workItem', 'c');
    const make = (scope: Scope, name: string, fail: boolean): void => {
      const T = token<object>(`d.${name}`);
      scope.provide(T, () => disposable(name, log, fail ? () => { throw new Error(`${name} failed`); } : undefined));
      scope.get(T);
    };
    make(app, 'a1', false);
    make(app, 'a2', true);
    make(child, 'c1', true);
    make(child, 'c2', false);
    const error = await errorOf(() => app.dispose());
    expect(error).toBeInstanceOf(AggregateError);
    expect(log).toEqual(['c2', 'c1', 'a2', 'a1']);
    expect((error as AggregateError).errors.length).toBeGreaterThan(0);
    expect(app.state).toBe('disposed');
  });

  it('C3: a second dispose() returns the first call\'s promise', async () => {
    const app = root();
    const first = app.dispose();
    const second = app.dispose();
    expect(second).toBe(first);
    await first;
  });

  it('awaits asynchronous disposal, preferring Symbol.asyncDispose', async () => {
    const log: string[] = [];
    const T = token<object>('d.async');
    const app = root();
    app.provide(T, () => ({
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        log.push('async done');
      },
      dispose() {
        log.push('sync dispose');
      },
    }));
    app.get(T);
    await app.dispose();
    expect(log).toEqual(['async done']);
  });

  it('transient disposable results are owned by the resolving scope', async () => {
    const log: string[] = [];
    const T = token<object>('d.transient');
    const app = root();
    let n = 0;
    app.provide(T, () => disposable(`t${++n}`, log), { lifetime: 'transient' });
    const child = app.createChild('workItem', 'c');
    app.get(T);
    child.get(T);
    child.get(T);
    await child.dispose();
    expect(log).toEqual(['t3', 't2']);
    await app.dispose();
    expect(log).toEqual(['t3', 't2', 't1']);
  });

  it('scoped instances are disposed with the resolving scope', async () => {
    const log: string[] = [];
    const T = token<object>('d.scoped');
    const app = root();
    app.provide(T, () => disposable(injectScope().path, log), { lifetime: 'scoped' });
    const child = app.createChild('workItem', 'c');
    child.get(T);
    app.get(T);
    await child.dispose();
    expect(log).toEqual([child.path]);
    await app.dispose();
    expect(log).toEqual([child.path, app.path]);
  });

  it('multi-bindings are disposed with their home scope', async () => {
    const log: string[] = [];
    const M = multiToken<object>('d.multi');
    const app = root();
    app.provideMany(M, () => disposable('m1', log));
    app.provideMany(M, () => disposable('m2', log));
    app.getAll(M);
    await app.dispose();
    expect(log).toEqual(['m2', 'm1']);
  });

  it('C3: disposing a registration handle disposes every instance created from it, in any scope, newest first', () => {
    const log: string[] = [];
    const T = token<object>('d.handle');
    const app = root();
    const handle = app.provide(T, () => disposable(`inst@${injectScope().path}`, log), { lifetime: 'scoped' });
    const a = app.createChild('workItem', 'a');
    const b = app.createChild('workItem', 'b');
    a.get(T);
    b.get(T);
    app.get(T);
    handle.dispose();
    expect(log).toEqual([`inst@${app.path}`, `inst@${b.path}`, `inst@${a.path}`]);
    expect(() => a.get(T)).toThrow(expect.objectContaining({ code: 'di.noProvider' }));
  });

  it('C3: handle disposal of a singleton disposes its instance once, and the scope does not dispose it again', async () => {
    const log: string[] = [];
    const T = token<object>('d.single');
    const app = root();
    const handle = app.provide(T, () => disposable('single', log));
    app.get(T);
    handle.dispose();
    await app.dispose();
    expect(log).toEqual(['single']);
  });

  it('after handle disposal a parent registration is used again and gets its own instance', () => {
    const T = token<{ readonly from: string }>('d.fallback');
    const app = root();
    const child = app.createChild('workItem', 'c');
    app.provide(T, () => ({ from: 'parent' }));
    const handle = child.provide(T, () => ({ from: 'child' }));
    expect(child.get(T).from).toBe('child');
    handle.dispose();
    expect(child.get(T).from).toBe('parent');
  });
});

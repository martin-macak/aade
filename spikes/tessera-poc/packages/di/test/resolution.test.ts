import { describe, expect, it } from 'vitest';
import { inject, injectLazy, injectScope, token, type ResolutionError } from '@tessera/di';
import { errorOf, useRoots } from './helpers.ts';

describe('C3: lifetimes', () => {
  const root = useRoots();

  it('C3: singleton lives in the registering scope: one instance for every resolving scope below', () => {
    const Svc = token<{ readonly scopePath: string }>('t.svc');
    const app = root();
    app.provide(Svc, () => ({ scopePath: injectScope().path }));
    const a = app.createChild('workItem', 'a');
    const b = app.createChild('workItem', 'b');
    const first = a.get(Svc);
    expect(b.get(Svc)).toBe(first);
    expect(app.get(Svc)).toBe(first);
    expect(first.scopePath).toBe(app.path);
  });

  it('C3: scoped creates one instance per resolving scope', () => {
    const Svc = token<{ readonly scopePath: string }>('t.scoped');
    const app = root();
    app.provide(Svc, () => ({ scopePath: injectScope().path }), { lifetime: 'scoped' });
    const a = app.createChild('workItem', 'a');
    const b = app.createChild('workItem', 'b');
    expect(a.get(Svc)).toBe(a.get(Svc));
    expect(a.get(Svc)).not.toBe(b.get(Svc));
    expect(a.get(Svc).scopePath).toBe(a.path);
    expect(b.get(Svc).scopePath).toBe(b.path);
    expect(app.get(Svc).scopePath).toBe(app.path);
  });

  it('C3: transient creates a new instance per request', () => {
    const Svc = token<{ readonly id: number }>('t.transient');
    const app = root();
    let n = 0;
    app.provide(Svc, () => ({ id: ++n }), { lifetime: 'transient' });
    expect(app.get(Svc)).not.toBe(app.get(Svc));
    expect(app.get(Svc).id).toBe(3);
  });

  it('C3: a singleton sees only its home scope and ancestors, never descendants', () => {
    const Local = token<string>('t.local');
    const Svc = token<string>('t.sees');
    const app = root();
    const child = app.createChild('workItem', 'c');
    child.provideValue(Local, 'only in child');
    app.provide(Svc, () => inject(Local, { optional: true }) ?? 'not visible');
    expect(child.get(Svc)).toBe('not visible');
  });

  it('C3: factories are lazy: nothing runs until the first get', () => {
    const Svc = token<string>('t.lazy');
    const app = root();
    let created = 0;
    app.provide(Svc, () => `v${++created}`);
    expect(created).toBe(0);
    app.get(Svc);
    app.get(Svc);
    expect(created).toBe(1);
  });

  it('C3: dependencies resolve through inject() in factories and class field initializers', () => {
    const Dep = token<string>('t.dep');
    class Consumer {
      readonly dep = inject(Dep);
      readonly scope = injectScope();
    }
    const Svc = token<Consumer>('t.consumer');
    const app = root();
    app.provideValue(Dep, 'dependency');
    app.provideClass(Svc, Consumer);
    const c = app.get(Svc);
    expect(c.dep).toBe('dependency');
    expect(c.scope).toBe(app);
    const made = app.createInstance(Consumer);
    expect(made.dep).toBe('dependency');
    expect(app.run(() => inject(Dep))).toBe('dependency');
  });
});

describe('C3: captive dependencies, cycles and async factories', () => {
  const root = useRoots();

  it('C3: a singleton that resolves a scoped token throws di.captive', () => {
    const Scoped = token<object>('t.scoped');
    const Single = token<object>('t.single');
    const app = root();
    app.provide(Scoped, () => ({}), { lifetime: 'scoped' });
    app.provide(Single, () => ({ dep: inject(Scoped) }));
    let error: ResolutionError | undefined;
    try {
      app.get(Single);
    } catch (e) {
      error = e as ResolutionError;
    }
    expect(error?.code).toBe('di.captive');
    expect(error?.path.length).toBeGreaterThan(0);
  });

  it('C3: a scoped or transient factory may resolve scoped tokens', () => {
    const Scoped = token<object>('t.scoped');
    const Other = token<object>('t.other');
    const app = root();
    app.provide(Scoped, () => ({}), { lifetime: 'scoped' });
    app.provide(Other, () => ({ dep: inject(Scoped) }), { lifetime: 'scoped' });
    expect(() => app.get(Other)).not.toThrow();
  });

  it('C3: a cycle throws di.cycle and the message lists the full path', () => {
    const A = token<object>('t.a');
    const B = token<object>('t.b');
    const C = token<object>('t.c');
    const app = root();
    app.provide(A, () => ({ b: inject(B) }));
    app.provide(B, () => ({ c: inject(C) }));
    app.provide(C, () => ({ a: inject(A) }));
    let error: ResolutionError | undefined;
    try {
      app.get(A);
    } catch (e) {
      error = e as ResolutionError;
    }
    expect(error?.code).toBe('di.cycle');
    expect(error?.path.map((p) => p.split('@')[0])).toEqual(['t.a', 't.b', 't.c', 't.a']);
    expect(error?.message).toContain('t.a@');
    // the failed resolution leaves no state behind
    expect(() => app.get(A)).toThrow(expect.objectContaining({ code: 'di.cycle' }));
  });

  it('C3: injectLazy breaks a cycle', () => {
    interface NodeA { readonly b: NodeB }
    interface NodeB { readonly a: { readonly value: NodeA } }
    const A = token<NodeA>('t.lazy.a');
    const B = token<NodeB>('t.lazy.b');
    const app = root();
    app.provide(A, () => ({ b: inject(B) }));
    app.provide(B, () => ({ a: injectLazy(A) }));
    const a = app.get(A);
    expect(a.b.a.value).toBe(a);
  });

  it('C3: a factory that returns a promise throws di.asyncFactory', async () => {
    const Svc = token<unknown>('t.async');
    const app = root();
    app.provide(Svc, () => Promise.resolve(1));
    const error = await errorOf(() => app.get(Svc));
    expect((error as ResolutionError).code).toBe('di.asyncFactory');
    // resolution state is clean afterwards
    const Ok = token<number>('t.ok');
    app.provideValue(Ok, 1);
    expect(app.get(Ok)).toBe(1);
  });

  it('a throwing factory does not cache and leaves the resolution stack clean', () => {
    const Svc = token<string>('t.flaky');
    const app = root();
    let calls = 0;
    app.provide(Svc, () => {
      if (++calls === 1) throw new Error('first call fails');
      return 'ok';
    });
    expect(() => app.get(Svc)).toThrow('first call fails');
    expect(app.get(Svc)).toBe('ok');
  });
});

describe('C3: scope helpers', () => {
  const root = useRoots();

  it('createInstance gives the scope no ownership; track() adopts the instance', async () => {
    const log: string[] = [];
    class Thing {
      dispose(): void {
        log.push('disposed');
      }
    }
    const app = root();
    const free = app.createInstance(Thing);
    await app.dispose();
    expect(log).toEqual([]);
    const other = root();
    const adopted = other.track(other.createInstance(Thing));
    await other.dispose();
    expect(log).toEqual(['disposed']);
    expect(adopted).toBeInstanceOf(Thing);
    expect(free).toBeInstanceOf(Thing);
  });

  it('provideValue does not dispose the value unless dispose is true', async () => {
    const log: string[] = [];
    const V1 = token<{ dispose(): void }>('t.v1');
    const V2 = token<{ dispose(): void }>('t.v2');
    const app = root();
    app.provideValue(V1, { dispose: () => log.push('v1') });
    app.provideValue(V2, { dispose: () => log.push('v2') }, { dispose: true });
    app.get(V1);
    app.get(V2);
    await app.dispose();
    expect(log).toEqual(['v2']);
  });

  it('onWillDispose fires with the scope before children are disposed', async () => {
    const log: string[] = [];
    const app = root();
    const child = app.createChild('workItem', 'c');
    app.onWillDispose((s) => log.push(`will ${s.kind}`));
    child.onWillDispose((s) => log.push(`will ${s.kind}`));
    await app.dispose();
    expect(log).toEqual(['will application', 'will workItem']);
  });
});

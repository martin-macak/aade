import { describe, expect, it } from 'vitest';
import { inject, injectAll, injectLazy, injectScope, isInInjectionContext, multiToken, runFiltered, token, ResolutionError, type InjectionFilter } from '@tessera/di';
import { errorOf, useRoots } from './helpers.ts';

describe('C3: injection context', () => {
  const root = useRoots();

  it('C3: inject() outside a context throws di.noContext', () => {
    const T = token<string>('ctx.a');
    expect(isInInjectionContext()).toBe(false);
    expect(() => inject(T)).toThrow(expect.objectContaining({ code: 'di.noContext' }));
    expect(() => injectScope()).toThrow(expect.objectContaining({ code: 'di.noContext' }));
    expect(() => injectAll(multiToken('ctx.m'))).toThrow(ResolutionError);
    expect(() => injectLazy(T)).toThrow(ResolutionError);
  });

  it('C3: inject() after an await throws di.noContext; capturing injectScope() first works', async () => {
    const Dep = token<string>('ctx.dep');
    const Svc = token<{ ready: Promise<string>; late: Promise<string> }>('ctx.svc');
    const app = root();
    app.provideValue(Dep, 'dependency');
    app.provide(Svc, () => {
      const scope = injectScope();
      const ready = (async () => {
        await Promise.resolve();
        return inject(Dep); // context is gone here
      })();
      const late = (async () => {
        await Promise.resolve();
        return scope.get(Dep);
      })();
      ready.catch(() => {});
      return { ready, late };
    });
    const svc = app.get(Svc);
    const error = await errorOf(() => svc.ready);
    expect((error as ResolutionError).code).toBe('di.noContext');
    await expect(svc.late).resolves.toBe('dependency');
  });

  it('the context exists only while the factory runs and is restored afterwards, also when nested', () => {
    const Inner = token<boolean>('ctx.inner');
    const Outer = token<{ readonly inside: boolean; readonly scope: string }>('ctx.outer');
    const app = root();
    const child = app.createChild('workItem', 'c');
    app.provide(Inner, () => isInInjectionContext());
    child.provide(Outer, () => ({ inside: inject(Inner) && isInInjectionContext(), scope: injectScope().path }));
    expect(child.get(Outer)).toEqual({ inside: true, scope: child.path });
    expect(isInInjectionContext()).toBe(false);
    expect(child.run(() => isInInjectionContext())).toBe(true);
    expect(isInInjectionContext()).toBe(false);
  });

  it('injectAll returns the multi-bindings visible from the context scope', () => {
    const M = multiToken<string>('ctx.multi');
    const app = root();
    const child = app.createChild('workItem', 'c');
    app.provideMany(M, () => 'app');
    child.provideMany(M, () => 'child');
    expect(child.run(() => injectAll(M))).toEqual(['app', 'child']);
  });

  it('injectLazy resolves on first access from the captured scope', () => {
    const T = token<string>('ctx.lazy');
    const app = root();
    let created = 0;
    app.provide(T, () => `value ${++created}`);
    const lazy = app.run(() => injectLazy(T));
    expect(created).toBe(0);
    expect(lazy.value).toBe('value 1');
    expect(lazy.value).toBe('value 1');
    expect(created).toBe(1);
  });

  it('C29: runFiltered refuses tokens by id for inject, injectAll and injectLazy, refuses injectScope, wraps values, and leaves nested factories alone', () => {
    const Allowed = token<string>('flt.allowed');
    const Denied = token<string>('flt.denied');
    const Core = token<string>('flt.core');
    const Many = multiToken<number>('flt.many');
    const app = root();
    app.provideValue(Allowed, 'ok');
    app.provideValue(Denied, 'secret');
    app.provide(Core, () => `core sees ${inject(Denied)}`); // a core factory: no filter in its own frame
    app.provideMany(Many, () => 1);
    const filter: InjectionFilter = {
      check(id) {
        if (id !== 'flt.allowed' && id !== 'flt.core') throw new Error(`denied ${id}`);
      },
      wrap: <T>(id: string, value: T): T => (id === 'flt.allowed' ? (`wrapped ${String(value)}` as T) : value),
    };
    const seen = app.run(() =>
      runFiltered(filter, () => ({
        allowed: inject(Allowed),
        rebuilt: (() => {
          try {
            return inject(token<string>('flt.denied')); // a token rebuilt from the id is refused like the original
          } catch (error) {
            return (error as Error).message;
          }
        })(),
        core: inject(Core), // the filter applies to the direct call, not to the factory that runs below it
        all: (() => {
          try {
            return injectAll(Many);
          } catch (error) {
            return (error as Error).message;
          }
        })(),
        lazy: (() => {
          const lazy = injectLazy(Denied);
          try {
            return lazy.value;
          } catch (error) {
            return (error as Error).message;
          }
        })(),
        scope: (() => {
          try {
            return injectScope();
          } catch (error) {
            return (error as ResolutionError).code;
          }
        })(),
      })),
    );
    expect(seen).toEqual({ allowed: 'wrapped ok', rebuilt: 'denied flt.denied', core: 'core sees secret', all: 'denied flt.many', lazy: 'denied flt.denied', scope: 'di.filtered' });
    expect(app.run(() => inject(Denied))).toBe('secret'); // the filter ended with the call
    expect(runFiltered(filter, () => 42)).toBe(42); // outside a context there is nothing to filter
  });
});

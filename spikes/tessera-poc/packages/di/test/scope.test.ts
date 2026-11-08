import { describe, expect, it } from 'vitest';
import { multiToken, token, inject, ResolutionError } from '@tessera/di';
import { useRoots } from './helpers.ts';

const Name = token<string>('test.name');
const Counter = token<{ readonly n: number }>('test.counter');
const Plugins = multiToken<string>('test.plugins');

describe('C3: scopes resolve child-first through the scope chain', () => {
  const root = useRoots();

  it('C3: resolves a token registered in an ancestor, child registrations shadow parents', () => {
    const app = root({ kind: 'application' });
    const win = app.createChild('window', 'w1');
    const item = win.createChild('workItem', 'tasks');
    const view = item.createChild('view', 'tasks.list');
    const placement = view.createChild('placement', 'p-1');
    app.provideValue(Name, 'application');
    expect(placement.get(Name)).toBe('application');
    win.provideValue(Name, 'window');
    expect(placement.get(Name)).toBe('window');
    item.provideValue(Name, 'workItem');
    expect(placement.get(Name)).toBe('workItem');
    placement.provideValue(Name, 'placement');
    expect(placement.get(Name)).toBe('placement');
    expect(view.get(Name)).toBe('workItem');
    expect(app.get(Name)).toBe('application');
  });

  it('C3: lookup never walks down or sideways', () => {
    const app = root();
    const a = app.createChild('workItem', 'a');
    const b = app.createChild('workItem', 'b');
    const child = a.createChild('view', 'v');
    child.provideValue(Name, 'in child of a');
    a.provideValue(Counter, { n: 1 });
    expect(a.get(Name, { optional: true })).toBeUndefined();
    expect(b.get(Counter, { optional: true })).toBeUndefined();
    expect(app.get(Name, { optional: true })).toBeUndefined();
    expect(() => b.get(Counter)).toThrow(ResolutionError);
    expect(a.has(Name)).toBe(false);
    expect(child.has(Name)).toBe(true);
    expect(child.has(Counter)).toBe(true);
  });

  it('C3: reports the scope path and kind', () => {
    const app = root({ kind: 'application' });
    const win = app.createChild('window', 'w1');
    const item = win.createChild('workItem', 'tasks');
    const view = item.createChild('view', 'tasks.list');
    const placement = view.createChild('placement', 'p-1f3a');
    expect(placement.path).toBe('application/window/workItem:tasks/view:tasks.list/placement:p-1f3a');
    expect(placement.kind).toBe('placement');
    expect(placement.parent).toBe(view);
    expect(placement.state).toBe('active');
  });

  it('C3: a missing provider throws di.noProvider with the resolution path', () => {
    const app = root();
    const A = token<string>('t.a');
    const B = token<string>('t.b');
    app.provide(A, () => inject(B));
    let error: ResolutionError | undefined;
    try {
      app.get(A);
    } catch (e) {
      error = e as ResolutionError;
    }
    expect(error).toBeInstanceOf(ResolutionError);
    expect(error?.code).toBe('di.noProvider');
    expect(error?.path.map((p) => p.split('@')[0])).toEqual(['t.a', 't.b']);
    expect(app.get(B, { optional: true })).toBeUndefined();
  });

  it('C3: a duplicate registration in one scope throws di.duplicate unless replace is set', () => {
    const app = root();
    app.provideValue(Name, 'one');
    expect(() => app.provideValue(Name, 'two')).toThrow(expect.objectContaining({ code: 'di.duplicate' }));
    app.provide(Name, () => 'replaced', { replace: true });
    expect(app.get(Name)).toBe('replaced');
    // a child may register the same id without conflict
    app.createChild('window', 'w').provideValue(Name, 'child');
  });

  it('C3: a registration handle removes the registration; the parent registration shows through again', () => {
    const app = root();
    const win = app.createChild('window', 'w');
    app.provideValue(Name, 'parent');
    const handle = win.provideValue(Name, 'child');
    expect(win.get(Name)).toBe('child');
    handle.dispose();
    expect(win.get(Name)).toBe('parent');
    handle.dispose();
  });

  it('C3: multi-bindings collect from the root down, order then registration order inside one scope', () => {
    const app = root();
    const win = app.createChild('window', 'w');
    win.provideMany(Plugins, () => 'win b');
    win.provideMany(Plugins, () => 'win first by order', { order: -1 });
    app.provideMany(Plugins, () => 'app 2');
    app.provideMany(Plugins, () => 'app 1', { order: -5 });
    expect(win.getAll(Plugins)).toEqual(['app 1', 'app 2', 'win first by order', 'win b']);
    expect(app.getAll(Plugins)).toEqual(['app 1', 'app 2']);
    expect(win.has(Plugins)).toBe(true);
  });

  it('C3: a Token and a MultiToken with the same id clash with di.tokenKindClash', () => {
    const app = root();
    app.provideValue(token<string>('t.same'), 'single');
    expect(() => app.createChild('window', 'w').provideMany(multiToken<string>('t.same'), () => 'multi')).toThrow(
      expect.objectContaining({ code: 'di.tokenKindClash' }),
    );
  });

  it('createChild, provide and get on a disposed scope throw di.disposed', async () => {
    const app = root();
    const child = app.createChild('workItem', 'x');
    await child.dispose();
    expect(child.state).toBe('disposed');
    expect(() => child.get(Name)).toThrow(expect.objectContaining({ code: 'di.disposed' }));
    expect(() => child.provideValue(Name, 'x')).toThrow(expect.objectContaining({ code: 'di.disposed' }));
    expect(() => child.createChild('view', 'v')).toThrow(expect.objectContaining({ code: 'di.disposed' }));
    expect(() => app.createChild('workItem', 'y')).not.toThrow();
  });
});

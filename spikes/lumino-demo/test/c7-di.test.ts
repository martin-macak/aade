import { Token } from '@lumino/coreutils';
import { type IDisposable } from '@lumino/disposable';
import { describe, expect, it } from 'vitest';
import { Scope } from '../src/cap7-di.ts';

const log: string[] = [];
const disposable = (name: string): IDisposable => ({ isDisposed: false, dispose: () => void log.push(name) });
const Greeting = new Token<string>('greeting');
const Plugin = new Token<{ name: string }>('plugin');
const Counter = new Token<{ n: number }>('counter');

function chain() {
  const app = new Scope('application');
  const win = app.createChild('window');
  const item = win.createChild('workitem');
  const view = item.createChild('view');
  return { app, win, item, view };
}

describe('C7 dependency injection with hierarchical scopes', () => {
  it('C7: a binding is visible in the scope that declares it and in every descendant, never in an ancestor', () => {
    const { app, win, item, view } = chain();
    win.bind(Greeting, () => 'hello');
    expect(view.get(Greeting)).toBe('hello');
    expect(item.get(Greeting)).toBe('hello');
    expect(win.get(Greeting)).toBe('hello');
    expect(() => app.get(Greeting)).toThrow(/No binding/);
    expect(app.tryGet(Greeting)).toBeUndefined();
  });

  it('C7: the nearest binding wins (a child shadows its parent)', () => {
    const { win, item, view } = chain();
    win.bind(Greeting, () => 'window');
    item.bind(Greeting, () => 'workitem');
    expect(view.get(Greeting)).toBe('workitem');
    expect(win.get(Greeting)).toBe('window');
  });

  it('C7: a singleton lives in the declaring scope; a scoped binding makes one instance per requesting scope', () => {
    const { win, item, view } = chain();
    const other = item.createChild('view');
    win.bind(Counter, () => ({ n: 0 }));
    expect(view.get(Counter)).toBe(other.get(Counter));
    const scopedHost = new Scope('window');
    const a = scopedHost.createChild('view');
    const b = scopedHost.createChild('view');
    scopedHost.bind(Plugin, () => ({ name: 'x' }), { scoped: true });
    expect(a.get(Plugin)).toBe(a.get(Plugin));
    expect(a.get(Plugin)).not.toBe(b.get(Plugin));
  });

  it('C7: multi-bindings are collected outermost scope first, and get() on a multi token refuses', () => {
    const { app, win, view } = chain();
    app.bind(Plugin, () => ({ name: 'a' }), { multi: true });
    win.bind(Plugin, () => ({ name: 'b' }), { multi: true });
    win.bind(Plugin, () => ({ name: 'c' }), { multi: true });
    view.bind(Plugin, () => ({ name: 'd' }), { multi: true });
    expect(view.getAll(Plugin).map((p) => p.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(win.getAll(Plugin).map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect(() => view.get(Plugin)).toThrow(/multi-bound/);
  });

  it('C7: binding a single token twice in one scope throws (Lumino plugin tokens silently override instead)', () => {
    const { win } = chain();
    win.bind(Greeting, () => 'one');
    expect(() => win.bind(Greeting, () => 'two')).toThrow(/already bound/);
  });

  it('C7: disposal is deterministic: children first (newest first), then own instances (newest first)', () => {
    log.length = 0;
    const app = new Scope('application');
    const win = app.createChild('window');
    const first = win.createChild('workitem');
    const second = win.createChild('workitem');
    first.own(disposable('first/a'));
    first.own(disposable('first/b'));
    second.own(disposable('second/a'));
    win.own(disposable('win/a'));
    win.bind(Counter, () => Object.assign({ n: 1 }, disposable('win/instance')));
    win.get(Counter); // created after win/a, so disposed before it
    app.dispose();
    expect(log).toEqual(['second/a', 'first/b', 'first/a', 'win/instance', 'win/a']);
    expect(app.isDisposed && win.isDisposed && first.isDisposed && second.isDisposed).toBe(true);
  });

  it('C7: every disposable runs even when one throws, and the failures are reported together', () => {
    log.length = 0;
    const scope = new Scope('window');
    scope.own(disposable('a'));
    scope.own({ isDisposed: false, dispose: () => { throw new Error('boom'); } });
    scope.own(disposable('c'));
    expect(() => scope.dispose()).toThrow(AggregateError);
    expect(log).toEqual(['c', 'a']);
    scope.dispose(); // idempotent
  });

  it('C7: a disposed scope detaches from its parent and refuses further use', () => {
    const { win, item } = chain();
    item.dispose();
    expect(win.children).not.toContain(item);
    expect(() => item.get(Greeting)).toThrow(/disposed/);
    expect(() => item.bind(Greeting, () => 'x')).toThrow(/disposed/);
  });

  it('C7: a circular dependency is reported, not a stack overflow', () => {
    const scope = new Scope('window');
    const A = new Token<object>('A');
    const B = new Token<object>('B');
    scope.bind(A, (s) => ({ b: s.get(B) }));
    scope.bind(B, (s) => ({ a: s.get(A) }));
    expect(() => scope.get(A)).toThrow(/Circular/);
  });
});

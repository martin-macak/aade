import { describe, expect, it } from 'vitest';
import { transact } from '@tessera/reactive';
import { WhenSyntaxError, type ContextChange } from '@tessera/contracts';
import { DefaultContextKeyService } from '@tessera/commands';
import { kit } from './kit.ts';

describe('C10: context keys resolve through hierarchical context-key scopes', () => {
  it('C10: a read walks up the chain, child values shadow parent values, reset falls through again', () => {
    const service = new DefaultContextKeyService();
    const win = service.root.createChild('window');
    const item = win.createChild('workItem:tasks');
    const placement = item.createChild('placement:p1');
    service.root.set('platform', 'mac');
    win.set('focusedView', 'tasks.list');
    item.set('view', 'item-level');
    placement.set('view', 'tasks.list');
    expect(placement.getValue('platform')).toBe('mac');
    expect(placement.getValue('focusedView')).toBe('tasks.list');
    expect(placement.getValue('view')).toBe('tasks.list');
    expect(item.getValue('view')).toBe('item-level');
    expect(win.getValue('view')).toBeUndefined();
    expect(service.root.getValue('focusedView')).toBeUndefined(); // never down, never sideways
    const key = placement.createKey('view');
    key.reset();
    expect(placement.getValue('view')).toBe('item-level');
    expect(key.get()).toBe('item-level');
    key.set('again');
    expect(key.get()).toBe('again');
    service.dispose();
  });

  it('C10: setting undefined removes the value of that scope', () => {
    const service = new DefaultContextKeyService();
    const child = service.root.createChild('c');
    service.root.set('k', 'root');
    child.set('k', 'child');
    child.set('k', undefined);
    expect(child.getValue('k')).toBe('root');
    service.dispose();
  });

  it('C10: createKey with an initial value sets it; keys hold strings, numbers, booleans, null and string arrays', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const count = scope.createKey('tasks.selectionCount', 0);
    const flags = scope.createKey('flags', ['a', 'b']);
    expect(count.name).toBe('tasks.selectionCount');
    expect(count.get()).toBe(0);
    expect(flags.get()).toEqual(['a', 'b']);
    scope.set('nothing', null);
    expect(scope.getValue('nothing')).toBeNull();
    service.dispose();
  });

  it('C10: evaluate() accepts undefined (always true), a string (parsed and cached) or a parsed expression', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    scope.set('a', true);
    expect(scope.evaluate(undefined)).toBe(true);
    expect(scope.evaluate('a')).toBe(true);
    expect(scope.evaluate('!a')).toBe(false);
    expect(scope.evaluate(service.parse('a && !b'))).toBe(true);
    expect(service.parse('a')).toBe(service.parse('a'));
    expect(service.cacheSize).toBe(3);
    expect(() => scope.evaluate('a &&')).toThrow(WhenSyntaxError);
    service.dispose();
  });

  it('C10: tryParse returns the syntax error instead of throwing', () => {
    const service = new DefaultContextKeyService();
    expect(service.tryParse('a')).toMatchObject({ source: 'a' });
    expect(service.tryParse('a &&')).toBeInstanceOf(WhenSyntaxError);
    service.dispose();
  });

  it('C10: snapshot() merges the chain', () => {
    const service = new DefaultContextKeyService();
    const child = service.root.createChild('c');
    service.root.set('a', 1);
    service.root.set('b', 2);
    child.set('b', 3);
    child.set('c', 4);
    expect(child.snapshot()).toEqual({ a: 1, b: 3, c: 4 });
    expect(service.root.snapshot()).toEqual({ a: 1, b: 2 });
    service.dispose();
  });

  it('disposing a scope disposes its children and detaches it', () => {
    const service = new DefaultContextKeyService();
    const parent = service.root.createChild('p');
    const child = parent.createChild('c');
    const seen: string[] = [];
    child.onDidChange(() => seen.push('change'));
    parent.dispose();
    child.set('k', 1);
    expect(seen).toEqual([]);
    expect(() => parent.createChild('late')).toThrow();
    service.dispose();
  });
});

describe('C10: change events', () => {
  it('fires one event per set outside a transaction, listing the key', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const events: string[][] = [];
    scope.onDidChange((e) => events.push([...e.keys]));
    scope.set('a', 1);
    scope.set('a', 1); // no change
    scope.set('b', 2);
    expect(events).toEqual([['a'], ['b']]);
    service.dispose();
  });

  it('C10: one event per transaction, listing all changed keys, delivered after commit', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const events: string[][] = [];
    scope.onDidChange((e) => events.push([...e.keys].toSorted()));
    transact(() => {
      scope.set('a', 1);
      scope.set('b', 2);
      scope.set('a', 3);
      expect(events).toEqual([]);
    });
    expect(events).toEqual([['a', 'b']]);
    service.dispose();
  });

  it('C10: bufferChanges() sends one event for all changes made inside', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const events: ContextChange[] = [];
    scope.onDidChange((e) => events.push(e));
    const result = scope.bufferChanges(() => {
      scope.set('x', 1);
      scope.set('y', 2);
      scope.bufferChanges(() => scope.set('z', 3));
      return 'done';
    });
    expect(result).toBe('done');
    expect(events).toHaveLength(1);
    expect([...(events[0]?.keys ?? [])].toSorted()).toEqual(['x', 'y', 'z']);
    expect(events[0]?.affects(new Set(['y', 'q']))).toBe(true);
    expect(events[0]?.affects(new Set(['q']))).toBe(false);
    service.dispose();
  });

  it('a scope hears changes made in its ancestors, an ancestor does not hear descendants', () => {
    const service = new DefaultContextKeyService();
    const parent = service.root.createChild('p');
    const child = parent.createChild('c');
    const seen: string[] = [];
    child.onDidChange((e) => seen.push(`child heard ${[...e.keys]}`));
    parent.onDidChange((e) => seen.push(`parent heard ${[...e.keys]}`));
    parent.set('a', 1);
    child.set('b', 1);
    expect(seen).toEqual(['child heard a', 'parent heard a', 'child heard b']);
    service.dispose();
  });
});

describe('ContextKeyService', () => {
  it('focused starts at the root; setFocused(undefined) resets to the window scope', () => {
    const k = kit();
    expect(k.keys.focused.peek()).toBe(k.win); // kit resets to the window scope after creating it
    const placement = k.win.createChild('placement:p1');
    k.keys.setFocused(placement);
    expect(k.keys.focused.peek()).toBe(placement);
    k.keys.setFocused(undefined);
    expect(k.keys.focused.peek()).toBe(k.win);
  });

  it('without a window scope setFocused(undefined) resets to the root', () => {
    const service = new DefaultContextKeyService();
    const other = service.root.createChild('not-the-window');
    service.setFocused(other);
    service.setFocused(undefined);
    expect(service.focused.peek()).toBe(service.root);
    service.dispose();
  });

  it('the application service is provided through DI and disposed with its scope', async () => {
    const k = kit();
    const seen: string[] = [];
    k.win.onDidChange(() => seen.push('x'));
    await k.t.dispose();
    k.win.set('a', 1);
    expect(seen).toEqual([]);
  });
});

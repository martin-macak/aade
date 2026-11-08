import { describe, expect, it } from 'vitest';
import { effect, transact } from '@tessera/reactive';
import type { ContextReader, WhenExpr } from '@tessera/contracts';
import { DefaultContextKeyService } from '@tessera/commands';

/** A when-expression that counts how often it is evaluated and which keys it read. */
function counting(keys: string[], decide: (get: (key: string) => unknown) => boolean): WhenExpr & { calls: number } {
  const expression = {
    source: `counting(${keys.join(',')})`,
    keys: new Set(keys),
    calls: 0,
    evaluate(context: ContextReader): boolean {
      expression.calls++;
      return decide((key) => context.getValue(key));
    },
  };
  return expression;
}

describe('C10: observe() re-evaluates only when a key it read changes', () => {
  it('C10: an unrelated key change does not re-evaluate; a relevant one does', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const expression = counting(['a'], (get) => get('a') === true);
    const result = scope.observe(expression);
    const seen: boolean[] = [];
    const sub = result.subscribe((v) => seen.push(v));
    expect(result.peek()).toBe(false);
    expect(expression.calls).toBe(1);
    scope.set('unrelated', 1);
    scope.set('other', 'x');
    expect(result.peek()).toBe(false);
    expect(expression.calls).toBe(1);
    scope.set('a', true);
    expect(result.peek()).toBe(true);
    expect(expression.calls).toBe(2);
    expect(seen).toEqual([true]);
    sub.dispose();
    service.dispose();
  });

  it('C10: a key that is read but not defined anywhere triggers re-evaluation when it is defined later, also in an ancestor', () => {
    const service = new DefaultContextKeyService();
    const win = service.root.createChild('window');
    const placement = win.createChild('p');
    const result = placement.observe('tasks.hasSelection');
    const seen: boolean[] = [];
    const sub = result.subscribe((v) => seen.push(v));
    expect(result.peek()).toBe(false);
    win.set('tasks.hasSelection', true); // defined in an ancestor scope
    expect(seen).toEqual([true]);
    placement.set('tasks.hasSelection', false); // shadowed in the placement
    expect(seen).toEqual([true, false]);
    placement.set('tasks.hasSelection', undefined);
    expect(seen).toEqual([true, false, true]);
    sub.dispose();
    service.dispose();
  });

  it('C10: the observable only notifies when the boolean result changes', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const result = scope.observe('n > 1');
    const seen: boolean[] = [];
    const sub = result.subscribe((v) => seen.push(v));
    scope.set('n', 2);
    scope.set('n', 3);
    scope.set('n', 4);
    scope.set('n', 0);
    expect(seen).toEqual([true, false]);
    sub.dispose();
    service.dispose();
  });

  it('C10: a short circuit stops depending on keys it did not read', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const expression = counting(['a', 'b'], (get) => get('a') === true && get('b') === true);
    const result = scope.observe(expression);
    const sub = result.subscribe(() => {});
    expect(expression.calls).toBe(1);
    scope.set('b', true); // a is false, b was never read
    expect(expression.calls).toBe(1);
    scope.set('a', true);
    expect(expression.calls).toBe(2);
    expect(result.peek()).toBe(true);
    sub.dispose();
    service.dispose();
  });

  it('C10: several key changes in one transaction evaluate once', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const expression = counting(['a', 'b'], (get) => get('a') === true && get('b') === true);
    const result = scope.observe(expression);
    const seen: boolean[] = [];
    const sub = result.subscribe((v) => seen.push(v));
    const before = expression.calls;
    transact(() => {
      scope.set('a', true);
      scope.set('b', true);
    });
    expect(seen).toEqual([true]);
    expect(expression.calls - before).toBe(1 + 0); // one evaluation for the whole transaction
    sub.dispose();
    service.dispose();
  });

  it('C10: observe() works inside an effect, and observe(undefined) is constant true', () => {
    const service = new DefaultContextKeyService();
    const scope = service.root.createChild('s');
    const log: boolean[] = [];
    const visible = scope.observe('visible');
    const fx = effect(() => {
      log.push(visible.get());
    });
    scope.set('visible', true);
    scope.set('visible', false);
    expect(log).toEqual([false, true, false]);
    expect(scope.observe(undefined).peek()).toBe(true);
    fx.dispose();
    service.dispose();
  });
});

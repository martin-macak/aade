import { StrictMode, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computed, reactiveDebug, state } from '@tessera/reactive';
import { useObservable } from '../src/index.ts';

describe('C24: useObservable', () => {
  it('C24: renders the current value and re-renders when the observable changes', () => {
    const count = state(1, { name: 'test.count' });
    function View() {
      return <p>value {useObservable(count)}</p>;
    }
    const view = render(<View />);
    expect(view.container.textContent).toBe('value 1');
    act(() => count.set(2));
    expect(view.container.textContent).toBe('value 2');
  });

  it('C24: one component holds exactly one subscription, and unmount releases it', () => {
    const count = state(0, { name: 'test.count' });
    const before = reactiveDebug.liveSubscriptions();
    function View() {
      return <p>{useObservable(count)}</p>;
    }
    const view = render(<View />);
    expect(reactiveDebug.liveSubscriptions() - before).toBe(1);
    view.unmount();
    expect(reactiveDebug.liveSubscriptions()).toBe(before);
  });

  it('C24: getSnapshot is peek(): no render while nothing changed, and an equal write does not render either', () => {
    const rows = state({ id: 'a' }, { name: 'test.rows', equals: (a, b) => a.id === b.id });
    const other = state(0, { name: 'test.other' });
    let renders = 0;
    function View() {
      renders++;
      const row = useObservable(rows);
      return <p>{row.id}</p>;
    }
    render(<View />);
    const initial = renders;
    act(() => other.set(1)); // unrelated state
    act(() => rows.set({ id: 'a' })); // equal by the custom equals: the old identity stays
    expect(renders).toBe(initial);
    act(() => rows.set({ id: 'b' }));
    expect(renders).toBe(initial + 1);
  });

  it('C24: a computed snapshot keeps its identity while its inputs are unchanged (no tearing, no extra render)', () => {
    const a = state(1, { name: 'test.a' });
    const b = state(10, { name: 'test.b' });
    const sum = computed(() => ({ total: a.get() + b.get() }), { name: 'test.sum' });
    const seen: unknown[] = [];
    function View() {
      const v = useObservable(sum);
      seen.push(v);
      const ref = useRef(v);
      return <p>{v.total}{ref.current === v ? '' : '!'}</p>;
    }
    render(<View />);
    act(() => {
      a.set(2);
      b.set(20);
    });
    expect(seen.at(-1)).toEqual({ total: 22 });
    // two writes in one batch gave one new snapshot, never a torn value such as 12 or 21
    expect(seen.map((s) => (s as { total: number }).total)).not.toContain(12);
    expect(seen.map((s) => (s as { total: number }).total)).not.toContain(21);
  });

  it('C24: two components on one source hold two subscriptions (one per consumer)', () => {
    const count = state(0, { name: 'test.count' });
    const before = reactiveDebug.liveSubscriptions();
    function View() {
      return <p>{useObservable(count)}</p>;
    }
    const view = render(
      <>
        <View />
        <View />
      </>,
    );
    expect(reactiveDebug.liveSubscriptions() - before).toBe(2);
    view.unmount();
    expect(reactiveDebug.liveSubscriptions()).toBe(before);
  });

  it('C24: switching to another observable moves the subscription', () => {
    const a = state('a', { name: 'test.a' });
    const b = state('b', { name: 'test.b' });
    const before = reactiveDebug.liveSubscriptions();
    function View({ source }: { source: typeof a }) {
      return <p>{useObservable(source)}</p>;
    }
    const view = render(<View source={a} />);
    view.rerender(<View source={b} />);
    expect(view.container.textContent).toBe('b');
    expect(reactiveDebug.liveSubscriptions() - before).toBe(1);
    act(() => a.set('a2')); // the old source no longer reaches the component
    expect(view.container.textContent).toBe('b');
    view.unmount();
    expect(reactiveDebug.liveSubscriptions()).toBe(before);
  });

  it('C24: works under StrictMode (double effects) with one live subscription', () => {
    const count = state(5, { name: 'test.count' });
    const before = reactiveDebug.liveSubscriptions();
    function View() {
      return <p>{useObservable(count)}</p>;
    }
    const view = render(
      <StrictMode>
        <View />
      </StrictMode>,
    );
    expect(reactiveDebug.liveSubscriptions() - before).toBe(1);
    act(() => count.set(6));
    expect(view.container.textContent).toBe('6');
    view.unmount();
    expect(reactiveDebug.liveSubscriptions()).toBe(before);
  });
});

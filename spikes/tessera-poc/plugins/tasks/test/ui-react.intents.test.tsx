import { createElement } from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactUiModule, ViewUiContext } from '@tessera/react/ui';
import ui from '../src/ui-react.tsx';
import type { TaskListIntents, TaskListState } from '../src/task-list.ts';

// C26 (b): the React view of tasks.list rendered against a STUB presenter. Every outbound call must be an intent, and nothing
// else is reachable: the ViewContext is a trap that throws on any use, and the state is deeply frozen.

type Call = readonly [name: string, ...args: unknown[]];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const trapContext = new Proxy({} as ViewUiContext, {
  get(_target, prop) {
    throw new Error(`the view used ViewUiContext.${String(prop)}: views read state and call intents only`);
  },
});

function stubIntents(calls: Call[]): TaskListIntents {
  const record =
    (name: string) =>
    (...args: unknown[]): Promise<void> | void => {
      calls.push([name, ...args]);
      return name === 'add' || name === 'complete' ? Promise.resolve() : undefined;
    };
  return {
    select: record('select'),
    scrolled: record('scrolled'),
    toggleGroup: record('toggleGroup'),
    setLocalFilter: record('setLocalFilter'),
    setSharedFilter: record('setSharedFilter'),
    setPinned: record('setPinned'),
    add: record('add') as TaskListIntents['add'],
    complete: record('complete') as TaskListIntents['complete'],
  };
}

const baseState: TaskListState = deepFreeze({
  groups: [
    {
      project: 'project-a',
      title: 'Project A',
      expanded: true,
      rows: [
        { id: 't1', title: 'Write tests', done: false, selected: false },
        { id: 't2', title: 'Old news', done: true, selected: false },
      ],
    },
    { project: 'project-b', title: 'Project B', expanded: false, rows: [{ id: 't3', title: 'Hidden row', done: false, selected: false }] },
  ],
  selectedId: undefined,
  remaining: 2,
  total: 3,
  scrollTop: 0,
  sharedFilter: '',
  localFilter: '',
  pinned: false,
});

function mountView(state: TaskListState = baseState) {
  const calls: Call[] = [];
  const definition = (ui as ReactUiModule).views[0]!;
  const intents = stubIntents(calls);
  const view = render(createElement(definition.component, { state: state as never, intents: intents as never, context: trapContext }));
  return { calls, view: view.container };
}

describe('C26: tasks.list React view against a stub presenter', () => {
  it('C26: the UI entry declares exactly one React view, tasks.list, for the react renderer', () => {
    expect((ui as ReactUiModule).rendererId).toBe('react');
    expect((ui as ReactUiModule).views.map((v) => v.viewType)).toEqual(['tasks.list']);
  });

  it('C26: it renders state only: groups, rows, done and expanded flags, the summary; a collapsed group shows no rows', () => {
    const { view, calls } = mountView();
    expect([...view.querySelectorAll('li > span')].map((e) => e.textContent)).toEqual(['Write tests', 'Old news']);
    expect(view.querySelector('.tasks-summary')?.textContent).toBe('2 of 3 open');
    expect(within(view).getByRole('button', { name: /Project B/ }).getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector('li[data-task-id="t2"]')?.querySelector('button')).toBeNull(); // a done task has no Done button
    expect(calls).toEqual([]); // rendering calls nothing
  });

  it('C26: every user action calls exactly one intent with plain data, and nothing else', () => {
    const { view, calls } = mountView();
    fireEvent.change(within(view).getByLabelText('Shared filter'), { target: { value: 'wri' } });
    fireEvent.change(within(view).getByLabelText('Local filter'), { target: { value: 'loc' } });
    fireEvent.click(within(view).getByLabelText('Pin this view'));
    fireEvent.click(within(view).getByRole('button', { name: 'Add task' }));
    fireEvent.click(within(view).getByRole('button', { name: /Project A/ }));
    fireEvent.click(view.querySelector('li[data-task-id="t1"]')!);
    fireEvent.click(within(view).getByRole('button', { name: 'Complete Write tests' }));
    expect(calls).toEqual([
      ['setSharedFilter', 'wri'],
      ['setLocalFilter', 'loc'],
      ['setPinned', true],
      ['add'],
      ['toggleGroup', 'project-a'],
      ['select', 't1'],
      ['complete', 't1'], // the Done button stops the click: the row is not selected as well
    ]);
  });

  it('C26: clicking the selected row asks to clear the selection; scrolling reports the offset', () => {
    const selected: TaskListState = deepFreeze({ ...baseState, selectedId: 't1', groups: [{ ...baseState.groups[0]!, rows: [{ id: 't1', title: 'Write tests', done: false, selected: true }] }] });
    const { view, calls } = mountView(selected);
    fireEvent.click(view.querySelector('li[data-task-id="t1"]')!);
    const scroller = view.querySelector('.tasks-scroll') as HTMLElement;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    expect(calls).toEqual([['select', undefined], ['scrolled', 120]]);
  });

  it('C26: the used intent set is a subset of the presenter intents, and the view needs no other prop (the context trap never fired)', () => {
    const { view, calls } = mountView();
    fireEvent.click(within(view).getByRole('button', { name: 'Add task' }));
    const known = ['select', 'scrolled', 'toggleGroup', 'setLocalFilter', 'setSharedFilter', 'setPinned', 'add', 'complete'];
    expect(calls.every(([name]) => known.includes(name))).toBe(true);
  });

  it('C26: re-rendering with new state changes the DOM without any call (state flows one way)', () => {
    const calls: Call[] = [];
    const definition = (ui as ReactUiModule).views[0]!;
    const props = (state: TaskListState) => ({ state: state as never, intents: stubIntents(calls) as never, context: trapContext });
    const view = render(createElement(definition.component, props(baseState)));
    act(() => view.rerender(createElement(definition.component, props(deepFreeze({ ...baseState, remaining: 1, total: 3, pinned: true })))));
    expect(view.container.querySelector('.tasks-summary')?.textContent).toBe('1 of 3 open');
    expect((within(view.container).getByLabelText('Pin this view') as HTMLInputElement).checked).toBe(true);
    expect(calls).toEqual([]);
  });
});

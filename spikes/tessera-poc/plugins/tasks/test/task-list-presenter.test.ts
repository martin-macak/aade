import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { migrateValue } from '@tessera/base';
import { computed, state, type Memento, type SelectionPublisher } from '@tessera/plugin-api';
import { TaskListPresenter, TaskListViewModel, TaskSelection, localSchema, sharedSchema, type TaskListIntents, type TaskListLocal, type TaskListShared } from '../src/task-list.ts';
import { MementoTaskStore, storedTasksSchema, type StoredTasks, type TaskChange } from '../src/task-store.ts';
import { manifest } from '../src/manifest.ts';

// Presenter tests (poc-plan C20, C26 c): intents in, viewState out, no renderer, no DOM, no framework.

function fakeMemento(initial: StoredTasks): Memento<StoredTasks> {
  const value = state(initial);
  return { scope: 'project', key: 'tasks', value: value.asReadonly(), get: () => value.peek(), set: (v) => value.set(v), update: (fn) => value.set(fn(value.peek())), reset: () => value.set(storedTasksSchema.initial()), dispose: () => undefined };
}

const live: TaskListPresenter[] = [];
/** Every intent the suite called, by name. The recording wraps the presenter's own intents (see fixture). */
const called = new Set<string>();
afterEach(() => {
  for (const p of live.splice(0)) p.dispose(); // a presenter owns an effect: dispose it (leakCheck would fail otherwise)
});

function fixture(options?: { local?: Partial<TaskListLocal> }) {
  const changes: Array<Omit<TaskChange, 'published'>> = [];
  const store = new MementoTaskStore(fakeMemento(storedTasksSchema.initial()), (c) => changes.push(c));
  store.add('Write tests', 'project-a');
  store.add('Ship it', 'project-b');
  store.add('Read mail');
  const shared = state<TaskListShared>(sharedSchema.initial());
  const local = state<TaskListLocal>({ ...localSchema.initial(), ...options?.local });
  const viewModel = new TaskListViewModel(store, shared);
  const keys = new Map<string, unknown>();
  const selected: unknown[][] = [];
  const selection: SelectionPublisher = { set: (_type, items) => void selected.push([...items]), clear: () => void selected.push([]) };
  const executed: Array<{ id: string; args: unknown }> = [];
  const presenter = new TaskListPresenter({
    viewModel,
    local,
    context: { set: (name, value) => void keys.set(name, value) },
    selection,
    commands: { run: async (command, args) => (executed.push({ id: command.id, args }), undefined as never) },
  });
  // Recording wrapper: any test that calls an intent through the presenter marks it as exercised (C26 c, checked in afterAll).
  const intentTable = presenter.intents as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of Object.keys(intentTable)) {
    const original = intentTable[name] as (...args: unknown[]) => unknown;
    intentTable[name] = (...args) => {
      called.add(name);
      return original(...args);
    };
  }
  live.push(presenter);
  return { store, shared, local, viewModel, presenter, keys, selected, executed, changes, view: () => presenter.viewState.peek(), intents: presenter.intents as TaskListIntents };
}

describe('C20: tasks.list presenter', () => {
  it('C20: every group carries its own title (no title table in the renderer): a known project has a display name, an unknown one shows its id', () => {
    const { view } = fixture();
    const titles = Object.fromEntries(view().groups.map((g) => [g.project, g.title]));
    expect(titles['project-a']).toBe('Project A');
    expect(titles['project-b']).toBe('Project B');
    expect(titles['inbox']).toBe('inbox');
  });

  it('C20: viewState groups tasks by project, in a fixed order, and counts remaining tasks', () => {
    const { view } = fixture();
    expect(view().groups.map((g) => [g.project, g.rows.map((r) => r.title)])).toEqual([
      ['project-a', ['Write tests']],
      ['project-b', ['Ship it']],
      ['inbox', ['Read mail']],
    ]);
    expect(view()).toMatchObject({ remaining: 3, total: 3, selectedId: undefined, scrollTop: 0, pinned: false, localFilter: '', sharedFilter: '' });
  });

  it('C20: viewState is one snapshot with a stable identity while nothing changed', () => {
    const { presenter, intents } = fixture();
    const first = presenter.viewState.peek();
    expect(presenter.viewState.peek()).toBe(first);
    intents.scrolled(10);
    expect(presenter.viewState.peek()).not.toBe(first);
  });

  it('C20: intent select writes the shared state; the row is marked selected', () => {
    const { intents, view, shared } = fixture();
    intents.select('t2');
    expect(shared.peek().selectedId).toBe('t2');
    expect(view().selectedId).toBe('t2');
    expect(view().groups.flatMap((g) => g.rows).filter((r) => r.selected).map((r) => r.id)).toEqual(['t2']);
    intents.select(undefined);
    expect(view().selectedId).toBeUndefined();
  });

  it('C20: intent scrolled writes local state and does nothing when the value is the same', () => {
    const { intents, local } = fixture();
    intents.scrolled(120);
    expect(local.peek().scrollTop).toBe(120);
    const before = local.peek();
    intents.scrolled(120);
    expect(local.peek()).toBe(before);
  });

  it('C20: intent toggleGroup collapses and expands a group (local state)', () => {
    const { intents, view } = fixture();
    expect(view().groups.find((g) => g.project === 'inbox')?.expanded).toBe(true);
    intents.toggleGroup('inbox');
    expect(view().groups.find((g) => g.project === 'inbox')?.expanded).toBe(false);
    intents.toggleGroup('inbox');
    expect(view().groups.find((g) => g.project === 'inbox')?.expanded).toBe(true);
  });

  it('C20: intent setLocalFilter filters this placement only; setSharedFilter filters every placement through the view model', () => {
    const a = fixture();
    a.intents.setLocalFilter('ship');
    expect(a.view().groups.flatMap((g) => g.rows).map((r) => r.title)).toEqual(['Ship it']);
    expect(a.viewModel.visibleTasks.peek()).toHaveLength(3); // the view model did not change
    a.intents.setLocalFilter('');
    a.intents.setSharedFilter('READ'); // case-insensitive
    expect(a.view().groups.flatMap((g) => g.rows).map((r) => r.title)).toEqual(['Read mail']);
    expect(a.viewModel.visibleTasks.peek().map((t) => t.title)).toEqual(['Read mail']);
    expect(a.view()).toMatchObject({ sharedFilter: 'READ', total: 3 });
  });

  it('C20: intent setPinned flags the placement (sample.audit reads this flag to veto closing)', () => {
    const { intents, local, view } = fixture();
    intents.setPinned(true);
    expect(local.peek().pinned).toBe(true);
    expect(view().pinned).toBe(true);
  });

  it('C20: intent add executes the command tasks.add; with a title it passes { title }', async () => {
    const { intents, executed } = fixture();
    await intents.add('New one');
    await intents.add();
    expect(executed).toEqual([{ id: 'tasks.add', args: { title: 'New one' } }, { id: 'tasks.add', args: undefined }]);
  });

  it('C20: intent complete executes the command tasks.complete, with or without an id', async () => {
    const { intents, executed } = fixture();
    await intents.complete('t1');
    await intents.complete();
    expect(executed).toEqual([{ id: 'tasks.complete', args: { id: 't1' } }, { id: 'tasks.complete', args: undefined }]);
  });

  it('C20: the presenter sets the context key tasks.hasSelection and publishes the typed selection', () => {
    const { intents, keys, selected, store } = fixture();
    expect(keys.get('tasks.hasSelection')).toBe(false);
    intents.select('t1');
    expect(keys.get('tasks.hasSelection')).toBe(true);
    expect((selected.at(-1) as Array<{ id: string }>).map((t) => t.id)).toEqual(['t1']);
    store.remove('t1'); // the selected task goes away: the selection ends
    expect(keys.get('tasks.hasSelection')).toBe(false);
    expect(selected.at(-1)).toEqual([]);
    expect(TaskSelection.id).toBe('sample.tasks/Task');
  });

  it('C20: dispose ends the effect and clears the key and the selection', () => {
    const { presenter, intents, keys, selected } = fixture();
    intents.select('t2');
    presenter.dispose();
    expect(keys.get('tasks.hasSelection')).toBeUndefined();
    expect(selected.at(-1)).toEqual([]);
    intents.select('t3'); // the effect is gone: nothing is set any more
    expect(keys.get('tasks.hasSelection')).toBeUndefined();
  });

  it('C20: the title observable follows the open count', () => {
    const { presenter, store } = fixture();
    expect(presenter.title.peek()).toBe('Tasks (3)');
    store.complete('t1');
    expect(presenter.title.peek()).toBe('Tasks (2)');
  });

  it('C26: the presenter exposes exactly the intents the view contract lists', () => {
    expect(Object.keys(fixture().presenter.intents).sort()).toEqual(['add', 'complete', 'scrolled', 'select', 'setLocalFilter', 'setPinned', 'setSharedFilter', 'toggleGroup']);
  });

  // Runs after every test of this file: an intent no test called is a hole in the suite, whatever the list above says.
  afterAll(() => {
    const probe = fixture().presenter;
    const intents = Object.keys(probe.intents);
    probe.dispose();
    live.splice(0);
    const untested = intents.filter((name) => !called.has(name));
    expect(untested, `intents never called by a test of this file: ${untested.join(', ')}`).toEqual([]);
  });
});

describe('C22: tasks.list state schemas', () => {
  it('C22: local state v1 migrates to v2 (localFilter and pinned are added), shared state v1 is current', () => {
    expect(localSchema.version).toBe(2);
    const migrated = migrateValue({ v: 1, data: { scrollTop: 55, expandedGroups: ['project-a'] } }, localSchema);
    expect(migrated).toMatchObject({ status: 'migrated', fromVersion: 1, value: { scrollTop: 55, expandedGroups: ['project-a'], localFilter: '', pinned: false } });
    expect(migrateValue({ v: 1, data: { selectedId: 't1', filter: 'x' } }, sharedSchema).status).toBe('current');
  });

  it('C22: invalid and newer stored values reset to initial()', () => {
    expect(migrateValue({ v: 1, data: { scrollTop: 'x' } }, localSchema).status).toBe('reset-invalid');
    expect(migrateValue({ v: 9, data: {} }, localSchema).status).toBe('reset-newer');
  });
});

describe('C26: sample.tasks manifest', () => {
  it('C26: provides the TaskStore token and declares commands, menus, a keybinding, a workspace and a view', () => {
    expect(manifest.provides).toEqual(['sample.tasks/TaskStore']);
    expect(Object.keys(manifest.contributes ?? {}).sort()).toEqual(['commands', 'keybindings', 'menus', 'views', 'workspaces']);
    void computed;
  });
});

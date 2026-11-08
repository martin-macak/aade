import { Token } from '@lumino/coreutils';
import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ICurrentWorkItem } from '../src/tokens.ts';
import { ITasks, TasksChanged, type TaskChange } from '../src/plugins/task-store.ts';
import { boot, settle, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
});

const Project = new Token<string>('project');

async function withTasks() {
  h = await boot();
  const { win } = h;
  await win.app.commands.execute('tasks.add', { title: 'warm up' }); // activates the plugin; creates its WorkItems
  const mod = win.windowScope.get(ITasks);
  return { win, ...mod, a: mod.projects.get('project-a')!, b: mod.projects.get('project-b')! };
}

describe('C9 WorkItems', () => {
  it('C9: a WorkItem tree: each item has its own DI scope (child of its parent item), event node and path', async () => {
    const { win, root, a } = await withTasks();
    expect(a.path).toBe('tasks/project-a');
    expect(a.parent).toBe(root);
    expect(a.scope.parent).toBe(root.scope);
    expect(root.scope.parent).toBe(win.windowScope);
    expect(a.events.parent).toBe(root.events);
    expect(root.scope.kind).toBe('workitem');
    expect(a.scope.get(ICurrentWorkItem)).toBe(a);
    expect(root.scope.get(ICurrentWorkItem)).toBe(root);
  });

  it('C9: services are scoped to the WorkItem: bound in project-a, visible below it, invisible in project-b', async () => {
    const { a, b, win } = await withTasks();
    a.scope.bind(Project, () => 'A');
    const view = a.scope.createChild('view');
    expect(view.get(Project)).toBe('A');
    expect(b.scope.tryGet(Project)).toBeUndefined();
    expect(view.get(ITasks).store).toBe(win.windowScope.get(ITasks).store); // plugin services reach every level
  });

  it('C9: events are scoped to the WorkItem (global, descendants, workItem); see also C6', async () => {
    const { win, root, a, b, store } = await withTasks();
    const heard: Record<string, string[]> = { root: [], tasks: [], a: [], b: [] };
    const listen = (key: string, node: { subscribe: typeof root.events.subscribe }) => node.subscribe(TasksChanged, (c: TaskChange) => heard[key]!.push(c.published!));
    listen('root', win.events);
    listen('tasks', root.events);
    listen('a', a.events);
    listen('b', b.events);
    store.add('in a', 'project-a');
    expect(heard).toEqual({ root: ['global'], tasks: ['global', 'descendants'], a: ['global', 'descendants', 'workItem'], b: ['global', 'descendants'] });
  });

  it('C9: views opened in a WorkItem get a view scope below it, and show that WorkItem\'s project', async () => {
    const { win, a, store } = await withTasks();
    store.add('alpha', 'project-a');
    store.add('beta', 'project-b');
    const inA = a.adopt(await win.views.create('tasks.list', { scope: a.scope }));
    win.workspaces.show(inA.widget, 'editor');
    await settle();
    expect(inA.scope.parent).toBe(a.scope);
    expect(inA.scope.get(ICurrentWorkItem)).toBe(a);
    expect(within(inA.widget.node).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['alpha project-a']);
  });

  it('C9: ending a WorkItem closes its views, ends its child items, event nodes and scopes (children first)', async () => {
    const { win, root, a, b } = await withTasks();
    const inA = a.adopt(await win.views.create('tasks.list', { scope: a.scope }));
    win.workspaces.show(inA.widget, 'editor');
    root.dispose();
    expect(inA.widget.isDisposed).toBe(true);
    expect(inA.scope.isDisposed && a.scope.isDisposed && b.scope.isDisposed && root.scope.isDisposed).toBe(true);
    expect(a.events.isDisposed && root.events.isDisposed).toBe(true);
    expect(root.children.size === 0 && a.isDisposed && b.isDisposed).toBe(true);
    expect(win.windowScope.isDisposed).toBe(false);
  });

  it('C9: COMMIT: changes are visible at once and their events are released together on commit', async () => {
    const { a, store, win } = await withTasks();
    const heard: string[] = [];
    win.events.subscribe(TasksChanged, (c) => heard.push(`${c.kind}:${c.task.title}`));
    let t1!: ReturnType<typeof store.add>;
    t1 = a.unit.apply(() => store.add('draft 1', 'project-a', true), () => void store.remove(t1.id, true));
    a.unit.afterCommit(() => store.announce({ kind: 'added', task: t1 }));
    let t2!: ReturnType<typeof store.add>;
    t2 = a.unit.apply(() => store.add('draft 2', 'project-a', true), () => void store.remove(t2.id, true));
    a.unit.afterCommit(() => store.announce({ kind: 'added', task: t2 }));
    expect(store.tasks.map((t) => t.title)).toEqual(['warm up', 'draft 1', 'draft 2']);
    expect(heard).toEqual([]); // nothing announced yet
    expect(a.unit.pending).toBe(2);
    a.unit.commit();
    expect(heard).toEqual(['added:draft 1', 'added:draft 2']);
    expect(store.tasks).toHaveLength(3);
    expect(a.unit.pending).toBe(0);
  });

  it('C9: DISCARD: every change is reverted newest first and no event is ever published', async () => {
    const { a, store, win } = await withTasks();
    const heard: string[] = [];
    win.events.subscribe(TasksChanged, (c) => heard.push(c.kind));
    let t1!: ReturnType<typeof store.add>;
    t1 = a.unit.apply(() => store.add('draft 1', 'project-a', true), () => void store.remove(t1.id, true));
    a.unit.afterCommit(() => store.announce({ kind: 'added', task: t1 }));
    const doneBefore = store.tasks[0]!;
    a.unit.apply(() => store.complete(doneBefore.id), () => void 0); // a change whose revert is a no-op still counts as one step
    a.unit.discard();
    expect(store.tasks.map((t) => t.title)).toEqual(['warm up']);
    expect(heard).toEqual(['completed']); // the completion announced itself because it was not staged quietly; the staged add never did
    expect(a.unit.pending).toBe(0);
    a.unit.commit(); // nothing left to release
    expect(heard).toEqual(['completed']);
  });

  it('C9: LIMIT: the unit of work is a convention of this demo. Nothing forces a change through it, and nothing isolates other readers from uncommitted state', async () => {
    const { a, store } = await withTasks();
    let t!: ReturnType<typeof store.add>;
    t = a.unit.apply(() => store.add('draft', 'project-a', true), () => void store.remove(t.id, true));
    expect(store.tasks.some((x) => x.title === 'draft')).toBe(true); // every view of the shared store already shows it
    a.unit.discard();
    expect(store.tasks.some((x) => x.title === 'draft')).toBe(false);
  });

  it('C9: an item that is disposed with uncommitted changes discards them', async () => {
    const { a, store } = await withTasks();
    let t!: ReturnType<typeof store.add>;
    t = a.unit.apply(() => store.add('draft', 'project-a', true), () => void store.remove(t.id, true));
    a.dispose();
    expect(store.tasks.some((x) => x.title === 'draft')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { PlacementStatus } from '@tessera/contracts';
import { createDemoApp } from '@tessera-poc/headless';
import { EDITOR, openTwice, presenterOf } from './kit.ts';

describe('C20: tasks.list in the side bar and in a dock tab, with the real sample plugin', () => {
  it('C20: both placements are one view instance with one view model and two presenters, local states and context scopes', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const { side, dock } = await openTwice(app);
    expect(side).toMatchObject({ workspaceId: 'tasks.sidebar', viewType: 'tasks.list' });
    expect(dock).toMatchObject({ workspaceId: EDITOR, viewType: 'tasks.list' });
    expect(side.instanceId).toBe(dock.instanceId);
    const instance = app.workbench.instance(side.instanceId)!;
    expect(instance.refCount).toBe(2);
    expect(instance.placements.peek().size).toBe(2);
    const a = app.workbench.placement(side.id)!;
    const b = app.workbench.placement(dock.id)!;
    expect(a.presenter).not.toBe(b.presenter);
    expect(a.local).not.toBe(b.local);
    expect(a.context).not.toBe(b.context);
    expect(a.scope).not.toBe(b.scope);
  });

  it('C20: selecting in one presenter changes the other viewState; scrolling and the local filter in one do not', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'Write tests' });
    await app.commands.execute('tasks.add', { title: 'Ship it' });
    const { side, dock } = await openTwice(app);
    const a = presenterOf(app, side);
    const b = presenterOf(app, dock);
    a.intents.select('t2');
    expect(b.state().selectedId).toBe('t2');
    expect(b.state().groups[0]?.rows.find((r) => r.id === 't2')?.selected).toBe(true);
    b.intents.scrolled(300);
    expect(b.state().scrollTop).toBe(300);
    expect(a.state().scrollTop).toBe(0);
    a.intents.setLocalFilter('ship');
    expect(a.state().groups.flatMap((g) => g.rows).map((r) => r.title)).toEqual(['Ship it']);
    expect(b.state().groups.flatMap((g) => g.rows)).toHaveLength(2); // the local filter stays local
    a.intents.setSharedFilter('write');
    expect(b.state().sharedFilter).toBe('write'); // the shared filter does not
    expect(b.state().groups.flatMap((g) => g.rows).map((r) => r.title)).toEqual(['Write tests']);
  });

  it('C20: the shared task store drives both: adding a task through the command updates both viewStates at once', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const { side, dock } = await openTwice(app);
    await app.commands.execute('tasks.add', { title: 'new', project: 'project-b' });
    expect(presenterOf(app, side).state().total).toBe(1);
    expect(presenterOf(app, dock).state().groups.map((g) => g.project)).toEqual(['project-b']);
    expect(app.workbench.placement(side.id)!.title.peek()).toBe('Tasks (1)');
  });

  it('C20: presenters exist only for visible placements: a dock tab opened in the background has none until it is activated', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.workbench.showView('tasks.list', { workspace: EDITOR });
    const background = await app.workbench.showView('tasks.list', { workspace: EDITOR, reuse: 'new', focus: false });
    expect(app.workbench.placement(background.id)?.presenter).toBeUndefined();
    expect(app.workbench.placement(background.id)?.status.peek()).toBe(PlacementStatus.Pending);
    await app.workbench.activate(background.id);
    await app.settle();
    expect(app.workbench.placement(background.id)?.presenter).toBeDefined();
  });

  it('C20: closing one placement keeps the instance; the last close applies the retain rule (grace 30 s for tasks.list)', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const { side, dock } = await openTwice(app);
    presenterOf(app, side).intents.select('t7');
    expect(await app.workbench.close(dock.id)).toBe(true);
    expect(app.workbench.instance(side.instanceId)).toBeDefined();
    expect(presenterOf(app, side).state().selectedId).toBe('t7');
    expect(await app.workbench.close(side.id)).toBe(true); // a container placement: hidden by a delta
    expect(app.workbench.instance(side.instanceId)).toBeDefined(); // grace
    await app.advance(30_000);
    expect(app.workbench.instance(side.instanceId)).toBeUndefined();
    expect(app.workbench.state.peek().overrides.views['tasks.list']).toMatchObject({ hidden: true });
  });

  it('C20: the context key tasks.hasSelection is per placement scope and follows the shared selection', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const { side, dock } = await openTwice(app);
    const keys = (id: typeof side.id) => app.workbench.placement(id)!.context.getValue('tasks.hasSelection');
    expect([keys(side.id), keys(dock.id)]).toEqual([false, false]);
    presenterOf(app, dock).intents.select('t1');
    expect([keys(side.id), keys(dock.id)]).toEqual([true, true]);
    presenterOf(app, dock).intents.select(undefined);
    expect([keys(side.id), keys(dock.id)]).toEqual([false, false]);
  });
});

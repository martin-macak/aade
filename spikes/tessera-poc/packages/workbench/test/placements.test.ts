import { describe, expect, it } from 'vitest';
import { CoreTopics, EventBus, PlacementStatus, type PlacementId } from '@tessera/contracts';
import { DeferredPromise } from '@tessera/base';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';
import { listApp, listManifest, listModule, listProvider, showTwice, type ListIntents, type ListState } from './kit.ts';

/** The command service reports every failed command; a test that expects the rejection captures that report. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const errors = captureErrors();
  try {
    return await promise.then(() => undefined, (e: unknown) => e);
  } finally {
    errors.drain();
    errors.dispose();
  }
}

const intents = (app: Awaited<ReturnType<typeof listApp>>, id: PlacementId): ListIntents => app.workbench.placement(id)!.presenter!.intents as ListIntents;
const viewState = (app: Awaited<ReturnType<typeof listApp>>, id: PlacementId): ListState => app.workbench.placement(id)!.presenter!.viewState.peek() as ListState;

describe('C20: one view type in two placements', () => {
  it('C20: the view is a known type before its plugin runs, and showing it activates the plugin exactly once', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    expect(app.plugins.status('fixture.view')?.state).toBe('resolved'); // declared, not loaded
    expect(log).toEqual([]);
    const [a, b] = await Promise.all([app.workbench.showView('fixture.list'), app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' })]);
    expect(a.instanceId).toBe(b.instanceId);
    expect(log.filter((l) => l === 'activate')).toHaveLength(1);
  });

  it('C20: both placements share one instance and one view model, and keep two local states and two presenters', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    const { side, dock } = await showTwice(app);
    expect(side.workspaceId).toBe('fixture.side');
    expect(dock.workspaceId).toBe('workbench.editorArea');
    expect(side.instanceId).toBe(dock.instanceId);
    expect(log.filter((l) => l === 'viewModel')).toHaveLength(1); // one view model for the instance
    expect(log.filter((l) => l.startsWith('presenter'))).toHaveLength(2); // one presenter per placement
    const sidePlacement = app.workbench.placement(side.id)!;
    const dockPlacement = app.workbench.placement(dock.id)!;
    expect(sidePlacement.presenter).not.toBe(dockPlacement.presenter);
    expect(sidePlacement.local).not.toBe(dockPlacement.local);
    expect(app.workbench.instance(side.instanceId)?.placements.peek().size).toBe(2);
    expect(app.workbench.instance(side.instanceId)?.refCount).toBe(2);
    expect(sidePlacement.scope?.kind).toBe('placement');
    expect(sidePlacement.scope?.parent).toBe(app.workbench.instance(side.instanceId)?.scope); // placement scope under the view scope
  });

  it('C20: selecting in one presenter changes the other presenter viewState; scrolling or a local change in one does not', async () => {
    const app = await listApp();
    const { side, dock } = await showTwice(app);
    expect(viewState(app, side.id).selectedId).toBeUndefined();
    intents(app, side.id).select('b');
    expect(viewState(app, dock.id).selectedId).toBe('b'); // shared state
    intents(app, dock.id).scrolled(120);
    expect(viewState(app, dock.id).scrollTop).toBe(120);
    expect(viewState(app, side.id).scrollTop).toBe(0); // local state stays local
    intents(app, side.id).scrolled(7);
    expect(viewState(app, dock.id).scrollTop).toBe(120);
  });

  it('C20: viewState keeps its identity while nothing changed and changes when a dependency changes', async () => {
    const app = await listApp();
    const { side } = await showTwice(app);
    const presenter = app.workbench.placement(side.id)!.presenter!;
    expect(presenter.viewState.peek()).toBe(presenter.viewState.peek());
    const before = presenter.viewState.peek();
    (presenter.intents as ListIntents).select('c');
    expect(presenter.viewState.peek()).not.toBe(before);
  });

  it('C20: showing again reuses (activates) the placement of the target workspace; reuse "new" adds another in a dock', async () => {
    const app = await listApp();
    const first = await app.workbench.showView('fixture.list');
    const again = await app.workbench.showView('fixture.list');
    expect(again.id).toBe(first.id);
    const d1 = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const d2 = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea', reuse: 'new' });
    expect(d2.id).not.toBe(d1.id);
    expect(app.workbench.state.peek().workspaces['workbench.editorArea']?.members).toEqual([d1.id, d2.id]);
  });

  it('C20: presenters exist only for visible placements: a dock tab that is never shown has none, and it appears when the tab is activated', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    const shown = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const background = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea', reuse: 'new', focus: false });
    expect(app.workbench.placement(shown.id)?.status.peek()).toBe(PlacementStatus.Attached);
    expect(app.workbench.placement(background.id)?.presenter).toBeUndefined();
    expect(app.workbench.placement(background.id)?.status.peek()).toBe(PlacementStatus.Pending);
    expect(log.filter((l) => l.startsWith('presenter'))).toHaveLength(1);
    await app.workbench.activate(background.id);
    await app.settle();
    expect(app.workbench.placement(background.id)?.presenter).toBeDefined();
    // the first tab is hidden now but keeps its presenter and state (15.7 rule 2)
    expect(app.workbench.placement(shown.id)?.status.peek()).toBe(PlacementStatus.Hidden);
    expect(app.workbench.placement(shown.id)?.presenter).toBeDefined();
  });

  it('C20: a placement context-key scope exists with the keys view, workspace, placement.visible and placement.focused', async () => {
    const app = await listApp();
    const { dock } = await showTwice(app);
    const context = app.workbench.placement(dock.id)!.context;
    expect(context.getValue('view')).toBe('fixture.list');
    expect(context.getValue('workspace')).toBe('workbench.editorArea');
    expect(context.getValue('placement.visible')).toBe(true);
    expect(context.getValue('placement.focused')).toBe(true);
    expect(app.contextKeys.focused.peek()).toBe(context);
  });
});

describe('C20: show view errors and rules', () => {
  it('C20: an unknown view type rejects with workbench.unknownView after trying onView activation', async () => {
    const app = await listApp();
    expect(await rejection(app.workbench.showView('nobody.knows'))).toMatchObject({ code: 'workbench.unknownView' });
  });

  it('C20: a view whose when-clause is false rejects with workbench.viewNotApplicable, and shows once the key is set', async () => {
    const m = listManifest({ contributes: { workspaces: [], views: [{ id: 'fixture.list', title: 'List', visibleByDefault: false, when: 'fixture.enabled' }] } });
    const app = await listApp({ manifest: m });
    expect(await rejection(app.workbench.showView('fixture.list'))).toMatchObject({ code: 'workbench.viewNotApplicable' });
    app.contextKeys.root.set('fixture.enabled', true);
    await expect(app.workbench.showView('fixture.list')).resolves.toMatchObject({ viewType: 'fixture.list' });
  });

  it('C20: a keyed view type needs a key, and two keys give two instances; a singleton ignores the key', async () => {
    const m = listManifest({ contributes: { views: [{ id: 'fixture.list', title: 'Doc', multiplicity: 'keyed' }] } });
    const app = await listApp({ manifest: m });
    expect(await rejection(app.workbench.showView('fixture.list'))).toMatchObject({ code: 'workbench.keyRequired' });
    const a = await app.workbench.showView('fixture.list', { key: 'file:///a' });
    const b = await app.workbench.showView('fixture.list', { key: 'file:///b' });
    const a2 = await app.workbench.showView('fixture.list', { key: 'file:///a' });
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(a2.id).toBe(a.id);
    expect(app.workbench.state.peek().instances[a.instanceId]?.key).toBe('file:///a');
  });

  it('C20: an unknown target workspace rejects with workbench.unknownWorkspace', async () => {
    const app = await listApp();
    expect(await rejection(app.workbench.showView('fixture.list', { workspace: 'no.such.workspace' }))).toMatchObject({ code: 'workbench.unknownWorkspace' });
  });

  it('C20: an owner WorkItem that does not exist falls back to the root WorkItem with a warning in the log, not an error', async () => {
    const m = listManifest({ contributes: { views: [{ id: 'fixture.list', title: 'List', visibleByDefault: false, workItem: 'root/missing' }] } });
    const app = await listApp({ manifest: m });
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    expect(app.workbench.placement(p.id)?.presenter).toBeDefined();
    expect(app.workbench.instance(p.instanceId)?.scope.parent).toBe(app.workItems.root.scope);
    expect(app.logs.some((l) => l.level >= 3 && l.message.includes('root/missing'))).toBe(true);
  });

  it('C20: an options.workItem owns the new instance, and its DI scope is the parent of the view scope', async () => {
    const app = await listApp();
    const project = app.workItems.root.createChild('project-a');
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea', workItem: project });
    expect(app.workbench.instance(p.instanceId)?.scope.parent).toBe(project.scope);
    expect(app.workbench.instance(p.instanceId)?.workItemPath).toBe('root/project-a');
  });

  it('C20: a presenter that throws becomes a placeholder with a problem text and is reported with source view and the plugin id', async () => {
    const description = describePlugin(listManifest());
    const errors = captureErrors();
    const app = await (await import('@tessera/testing')).createTestApp({
      plugins: [description],
      modules: {
        [description.location]: {
          activate: (ctx: { views: { registerProvider(p: unknown): void } }) =>
            ctx.views.registerProvider({
              viewType: 'fixture.list',
              createPresenter: () => {
                throw new Error('presenter exploded');
              },
            }),
        },
      },
    });
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const placement = app.workbench.placement(p.id)!;
    expect(placement.status.peek()).toBe(PlacementStatus.Placeholder);
    expect(placement.problem).toContain('presenter exploded');
    const reported = errors.drain();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'view', pluginId: 'fixture.view' });
    errors.dispose();
    void manifest;
    void listModule;
  });
});

describe('C20: close is idempotent per placement (placement-close-not-idempotent)', () => {
  async function gatedApp() {
    const gate = new DeferredPromise<boolean>();
    let asked = 0;
    const provider = listProvider();
    const wrapped = {
      ...provider,
      createPresenter: (ctx: Parameters<typeof provider.createPresenter>[0]) => ({
        ...provider.createPresenter(ctx),
        canClose: () => {
          asked++;
          return gate.promise;
        },
      }),
    };
    const description = describePlugin(listManifest());
    const app = await createTestApp({
      plugins: [description],
      modules: { [description.location]: { activate: (ctx: { views: { registerProvider(p: unknown): void } }) => ctx.views.registerProvider(wrapped) } },
    });
    return { app, gate, asked: () => asked };
  }

  it('C20: two concurrent close() calls run canClose once, close once, and give the same result', async () => {
    const { app, gate, asked } = await gatedApp();
    const topicLog: string[] = [];
    app.application.get(EventBus).root.subscribe(CoreTopics.placementClosed, (e) => void topicLog.push(e.placement.id), { delivery: 'sync' });
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const a = app.workbench.close(p.id);
    const b = app.workbench.close(p.id);
    await app.settle();
    gate.resolve(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(asked()).toBe(1);
    expect(topicLog).toEqual([p.id]);
    expect(app.workbench.placement(p.id)).toBeUndefined();
  });

  it('C20: a veto gives false to both callers, and a later close starts a new attempt', async () => {
    const { app, gate, asked } = await gatedApp();
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const a = app.workbench.close(p.id);
    const b = app.workbench.close(p.id);
    await app.settle();
    gate.resolve(false);
    expect(await Promise.all([a, b])).toEqual([false, false]);
    expect(asked()).toBe(1);
    expect(await app.workbench.close(p.id)).toBe(false);
    expect(asked()).toBe(2);
  });

  it('C20: a force call during a pending canClose escalates it: the close goes on without waiting', async () => {
    const { app, gate } = await gatedApp();
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    const soft = app.workbench.close(p.id);
    await app.settle();
    const forced = app.workbench.close(p.id, { force: true });
    expect(await Promise.all([soft, forced])).toEqual([true, true]);
    expect(app.workbench.placement(p.id)).toBeUndefined();
    gate.resolve(false); // too late to matter
  });
});

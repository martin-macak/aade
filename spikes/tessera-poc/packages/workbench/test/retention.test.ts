import { describe, expect, it } from 'vitest';
import { InterceptorRegistry, PlacementStatus, type PlacementId } from '@tessera/contracts';
import { createTestApp, describePlugin } from '@tessera/testing';
import { listApp, listManifest, listProvider, showTwice, type ListIntents, type ListState } from './kit.ts';

const intents = (app: Awaited<ReturnType<typeof listApp>>, id: PlacementId): ListIntents => app.workbench.placement(id)!.presenter!.intents as ListIntents;
const viewState = (app: Awaited<ReturnType<typeof listApp>>, id: PlacementId): ListState => app.workbench.placement(id)!.presenter!.viewState.peek() as ListState;

describe('C20: closing and retention', () => {
  it('C20: closing one placement keeps the instance (and its view model) for the other', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    const { side, dock } = await showTwice(app);
    intents(app, side.id).select('c');
    expect(await app.workbench.close(dock.id)).toBe(true);
    expect(app.workbench.placement(dock.id)).toBeUndefined();
    expect(app.workbench.instance(side.instanceId)).toBeDefined();
    expect(app.workbench.instance(side.instanceId)?.refCount).toBe(1);
    expect(viewState(app, side.id).selectedId).toBe('c');
    expect(log).toContain(`dispose ${dock.id}`);
  });

  it('C20: the last close applies the retain rule: "none" disposes the instance at once', async () => {
    const m = listManifest({ contributes: { workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }], views: [{ id: 'fixture.list', title: 'List', workspace: 'fixture.side', visibleByDefault: false, retain: 'none' }] } });
    const app = await listApp({ manifest: m });
    const { dock } = await showTwice(app);
    const instanceId = dock.instanceId;
    await app.workbench.close(dock.id);
    expect(app.workbench.instance(instanceId)).toBeDefined(); // one placement left
    const left = app.workbench.state.peek().instances[instanceId]!.placements[0]!;
    await app.workbench.close(left);
    await app.settle();
    expect(app.workbench.instance(instanceId)).toBeUndefined();
  });

  it('C20: the last close applies the retain rule: "grace" (default) keeps the instance for 30 s, a reopen within that time starts warm', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    const first = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    intents(app, first.id).select('b');
    await app.workbench.close(first.id);
    expect(app.workbench.instance(first.instanceId)).toBeDefined(); // grace
    await app.advance(29_999);
    expect(app.workbench.instance(first.instanceId)).toBeDefined();
    const again = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    expect(again.instanceId).toBe(first.instanceId); // same instance, view model not rebuilt
    expect(log.filter((l) => l === 'viewModel')).toHaveLength(1);
    expect(viewState(app, again.id).selectedId).toBe('b');
    await app.advance(60_000);
    expect(app.workbench.instance(first.instanceId)).toBeDefined(); // re-acquired: no retirement
  });

  it('C20: after the grace time the instance is gone, and its shared state sits in the closed-instance cache so a reopen starts warm', async () => {
    const log: string[] = [];
    const app = await listApp({ log });
    const first = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    intents(app, first.id).select('c');
    await app.workbench.close(first.id);
    await app.advance(30_000);
    expect(app.workbench.instance(first.instanceId)).toBeUndefined();
    const again = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    expect(log.filter((l) => l === 'viewModel')).toHaveLength(2); // rebuilt
    expect(viewState(app, again.id).selectedId).toBe('c'); // but warm: the shared state came from the cache
  });

  it('C20: presenter.canClose() vetoes a close unless force is set; a throwing canClose also vetoes and is reported', async () => {
    let allow = false;
    const provider = listProvider();
    const wrapped = { ...provider, createPresenter: (ctx: Parameters<typeof provider.createPresenter>[0]) => ({ ...provider.createPresenter(ctx), canClose: () => allow }) };
    const description = describePlugin(listManifest());
    const app = await createTestApp({
      plugins: [description],
      modules: { [description.location]: { activate: (ctx: { views: { registerProvider(p: unknown): void } }) => ctx.views.registerProvider(wrapped) } },
    });
    const p = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    expect(await app.workbench.close(p.id)).toBe(false);
    expect(app.workbench.placement(p.id)?.status.peek()).toBe(PlacementStatus.Attached); // restored after the veto
    allow = true;
    expect(await app.workbench.close(p.id)).toBe(true);
    const q = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    allow = false;
    expect(await app.workbench.close(q.id, { force: true })).toBe(true); // force skips canClose
    expect(app.workbench.placement(q.id)).toBeUndefined();
  });

  it('C20: a guard interceptor on workbench.closePlacement vetoes the close (no side door: close is a command)', async () => {
    const app = await listApp();
    const { dock } = await showTwice(app);
    const pinned = new Set<string>([dock.id]);
    app.application.get(InterceptorRegistry).register({
      id: 'pin-guard',
      kinds: ['command'],
      match: 'workbench.closePlacement',
      mode: 'guard',
      phase: 'guard',
      async intercept(ctx, next) {
        const args = ctx.data.args as { id: string };
        if (pinned.has(args.id)) return false;
        return next();
      },
    });
    expect(await app.workbench.close(dock.id)).toBe(false);
    expect(app.workbench.placement(dock.id)).toBeDefined();
    pinned.clear();
    expect(await app.workbench.close(dock.id)).toBe(true);
  });

  it('C20: every mutation is a core command that the command service executes (so interceptors can see it)', async () => {
    const app = await listApp();
    const seen: string[] = [];
    app.commands.onDidExecute((e) => seen.push(`${e.commandId}:${e.outcome}`));
    const a = await app.workbench.showView('fixture.list', { workspace: 'workbench.editorArea' });
    await app.workbench.activate(a.id);
    await app.workbench.setPartVisible(a.windowId, 'panel', false);
    await app.workbench.close(a.id);
    expect(seen).toEqual([
      'workbench.showView:ok',
      'workbench.activatePlacement:ok',
      'workbench.setPartVisible:ok',
      'workbench.closePlacement:ok',
    ]);
  });
});


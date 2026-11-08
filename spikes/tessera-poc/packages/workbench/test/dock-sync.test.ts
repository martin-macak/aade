import { describe, expect, it } from 'vitest';
import { InterceptorRegistry, WorkbenchAdapterApi, type DockChange, type PlacementId } from '@tessera/contracts';
import { captureErrors, dockSurfaceConformance, fakeDockSurface, type FakeDockSurface, type TestApp } from '@tessera/testing';
import { listApp, listManifest } from './kit.ts';

const EDITOR = 'workbench.editorArea';

const keyedManifest = (extra?: { readonly canMove?: boolean }) =>
  listManifest({ contributes: { views: [{ id: 'fixture.list', title: 'Doc', multiplicity: 'keyed', ...(extra as object) }] } });

async function setup(manifest = keyedManifest()): Promise<{ app: TestApp; fake: FakeDockSurface }> {
  const app = await listApp({ manifest });
  const fake = app.dock!.surfaces.get(EDITOR)!;
  return { app, fake };
}

const open = (app: TestApp, key: string, focus = true) => app.workbench.showView('fixture.list', { key, workspace: EDITOR, focus });
const members = (app: TestApp): PlacementId[] => [...(app.workbench.state.peek().workspaces[EDITOR]?.members ?? [])];

describe('C21: the fake surface passes the DockSurface conformance suite', () => {
  dockSurfaceConformance('fakeDockSurface', () => {
    const surface = fakeDockSurface();
    return { surface, host: undefined, mounter: { rendererId: 'none', ensureUi: async () => false, canMount: () => false, mount: () => ({ dispose() {} }) }, panelIds: () => surface.panelIds() };
  });
});

describe('C21: model and dock surface sync', () => {
  it('C21: panel ids equal workspace members after opening, closing and activating', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    const b = await open(app, 'b');
    const c = await open(app, 'c');
    expect([...fake.panelIds()].sort()).toEqual([a.id, b.id, c.id].sort());
    await app.workbench.close(b.id);
    expect([...fake.panelIds()].sort()).toEqual([a.id, c.id].sort());
    expect((app.workbench as unknown as { checkDockInvariantFor(id: string): string | undefined }).checkDockInvariantFor(EDITOR)).toBeUndefined();
  });

  it('C21: the surface reports which tab is visible, and the workbench creates presenters for those only', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    const b = await open(app, 'b');
    expect(fake.visiblePanels()).toEqual([b.id]);
    expect(app.workbench.placement(a.id)?.visible.peek()).toBe(false);
    expect(app.workbench.placement(a.id)?.presenter).toBeDefined(); // it was visible before: keeps its presenter
    const c = await open(app, 'c', false);
    expect(app.workbench.placement(c.id)?.presenter).toBeUndefined();
  });

  it('C21: model-origin echoes are dropped: they run no command and do not change the model', async () => {
    const { app, fake } = await setup();
    await open(app, 'a');
    const executed: string[] = [];
    app.commands.onDidExecute((e) => executed.push(e.commandId));
    const before = app.workbench.state.peek();
    const echoes = fake.emitted.filter((c) => c.origin === 'model');
    expect(echoes.length).toBeGreaterThan(0); // the fake does raise them
    for (const echo of echoes) app.get(WorkbenchAdapterApi).reportDockChange(EDITOR, { ...echo, revision: before.revision });
    await app.settle();
    expect(executed).toEqual([]);
    expect(app.workbench.state.peek()).toBe(before);
  });

  it('C21: a stale-revision report is rebased: membership is not taken from it and the surface is applied again', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    const b = await open(app, 'b');
    const executed: string[] = [];
    app.commands.onDidExecute((e) => executed.push(e.commandId));
    const applies = fake.applyCount;
    const stale: DockChange = { origin: 'user', revision: 0, reasons: new Set(['structure']), projection: new Map([[a.id, { group: 'gX', where: 'grid', popoutId: undefined }]]), active: a.id };
    app.get(WorkbenchAdapterApi).reportDockChange(EDITOR, stale);
    await app.settle();
    expect(executed).toEqual([]); // no move command from a stale report
    expect(fake.applyCount).toBeGreaterThan(applies); // rebase: apply again
    expect(members(app)).toEqual([a.id, b.id]);
    expect([...fake.panelIds()].sort()).toEqual([a.id, b.id].sort());
  });

  it('C21: a user move is a proposal: it becomes workbench.movePlacement (source view) and the accepted slot is recorded', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    await open(app, 'b');
    const executed: Array<{ id: string; source: string }> = [];
    app.commands.onDidExecute((e) => executed.push({ id: e.commandId, source: e.source }));
    fake.userMoveToNewGroup(a.id, 'right');
    await app.settle();
    expect(executed).toContainEqual({ id: 'workbench.movePlacement', source: 'view' });
    const slot = app.workbench.state.peek().placements[a.id]?.dock;
    expect(slot?.group).toBe(fake.groups().find((g) => g.panels.includes(a.id))?.id);
    expect((app.workbench as unknown as { checkDockInvariantFor(id: string): string | undefined }).checkDockInvariantFor(EDITOR)).toBeUndefined();
  });

  it('C21: a vetoed move is reverted: a guard interceptor on workbench.movePlacement moves the tab back', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    await open(app, 'b');
    const groupBefore = fake.groups().find((g) => g.panels.includes(a.id))!.id;
    app.application.get(InterceptorRegistry).register({ id: 'lock', kinds: ['command'], match: 'workbench.movePlacement', mode: 'guard', phase: 'guard', async intercept() { return undefined; } });
    fake.userMoveToNewGroup(a.id, 'left');
    expect(fake.groups().find((g) => g.panels.includes(a.id))!.id).not.toBe(groupBefore); // the user dropped it elsewhere
    await app.settle();
    expect(fake.groups().find((g) => g.panels.includes(a.id))!.id).toBe(groupBefore); // reverted
    expect([...fake.panelIds()].sort()).toEqual(members(app).sort());
  });

  it('C21: a view with canMove false rejects the move (workbench.moveRejected) and the tab goes back', async () => {
    const { app, fake } = await setup(keyedManifest({ canMove: false }));
    const a = await open(app, 'a');
    await open(app, 'b');
    const groupBefore = fake.groups().find((g) => g.panels.includes(a.id))!.id;
    const errors = captureErrors();
    fake.userMoveToNewGroup(a.id);
    await app.settle();
    expect(errors.drain().some((e) => (e.error as { code?: string }).code === 'workbench.moveRejected')).toBe(true);
    errors.dispose();
    expect(fake.groups().find((g) => g.panels.includes(a.id))!.id).toBe(groupBefore);
  });

  it('C21: the tab close button never closes by itself: it runs workbench.closePlacement with source view, and a veto keeps the tab', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    await open(app, 'b');
    const executed: Array<{ id: string; source: string; outcome: string }> = [];
    app.commands.onDidExecute((e) => executed.push({ id: e.commandId, source: e.source, outcome: e.outcome }));
    app.application.get(InterceptorRegistry).register({ id: 'keep-a', kinds: ['command'], match: 'workbench.closePlacement', mode: 'guard', phase: 'guard', async intercept(ctx, next) { return (ctx.data.args as { id: string }).id === a.id ? false : next(); } });
    fake.userClose(a.id);
    await app.settle();
    expect(executed).toContainEqual({ id: 'workbench.closePlacement', source: 'view', outcome: 'ok' });
    expect(fake.panelIds()).toContain(a.id);
    expect(members(app)).toContain(a.id);
  });

  it('C21: a geometry-only change updates the arrangement blob and schedules a save, without touching membership or the revision', async () => {
    const { app, fake } = await setup();
    await open(app, 'a');
    await app.advance(500);
    const revision = app.workbench.state.peek().revision;
    const writes = app.storage.writes.length;
    fake.userGeometry();
    await app.settle();
    expect(app.workbench.state.peek().revision).toBe(revision);
    expect(app.workbench.state.peek().workspaces[EDITOR]?.arrangement).toEqual(fake.snapshot());
    await app.advance(500);
    await app.storageService.flush();
    expect(app.storage.writes.length).toBeGreaterThan(writes);
  });

  it('C21: a tab activated in the surface becomes the active placement (command, source view)', async () => {
    const { app, fake } = await setup();
    const a = await open(app, 'a');
    await open(app, 'b');
    fake.userActivate(a.id);
    await app.settle();
    expect(app.workbench.state.peek().workspaces[EDITOR]?.active).toBe(a.id);
    expect(app.workbench.placement(a.id)?.visible.peek()).toBe(true);
  });
});

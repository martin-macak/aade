import { afterEach, describe, expect, it } from 'vitest';
import { PlacementStatus, type CommandExecutedEvent, type PlacementId } from '@tessera/contracts';
import { CommandService } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { createDockApp, EDITOR, type DockApp } from './kit.ts';

// C21 / C27 in real Chromium: the workbench model and the dockview surface stay in sync, with the real dockview-core 8.8.3
// and a test-only plain DOM mounter (no React). The fake-surface property test (packages/workbench) is the contract; this
// proves the adapter honours it.

const live: DockApp[] = [];
afterEach(async () => {
  for (const d of live.splice(0)) d.detach();
});
async function make(...args: Parameters<typeof createDockApp>): Promise<DockApp> {
  const d = await createDockApp(...args);
  live.push(d);
  return d;
}

const members = (d: DockApp): PlacementId[] => [...(d.app.workbench.state.peek().workspaces[EDITOR]?.members ?? [])];
const panelIds = (d: DockApp): string[] => [...d.surface().panelIds()].sort();
const sortedMembers = (d: DockApp): string[] => members(d).sort();

describe('C21: dockview surface in Chromium: panel ids equal workspace members', () => {
  it('C21: showView, a second tab and close keep the panel ids equal to the members, and the views render through the mounter', async () => {
    const d = await make();
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    const b = await d.app.workbench.showView('notes.view', { workspace: EDITOR, reuse: 'new' });
    await d.settle();
    expect(panelIds(d)).toEqual(sortedMembers(d));
    expect(panelIds(d)).toEqual([a.id, b.id].sort());
    // the active panel shows its view: plain text from the presenter's viewState
    const texts = [...d.host.querySelectorAll('.tessera-dock-panel')].map((e) => e.textContent);
    expect(texts.filter((t) => t === 'note: hello').length).toBeGreaterThanOrEqual(1);
    expect(await d.app.workbench.close(b.id)).toBe(true);
    await d.settle();
    expect(panelIds(d)).toEqual([a.id]);
    expect(sortedMembers(d)).toEqual([a.id]);
  });

  it('C21: model-driven changes are echoes: they raise no workbench.movePlacement and no revision loop', async () => {
    const d = await make();
    const executed: CommandExecutedEvent[] = [];
    d.app.get(CommandService).onDidExecute((e) => executed.push(e));
    await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    await d.app.workbench.showView('notes.view', { workspace: EDITOR, reuse: 'new' });
    await d.settle();
    const revision = d.app.workbench.state.peek().revision;
    await d.settle();
    expect(executed.filter((e) => e.commandId === 'workbench.movePlacement')).toEqual([]);
    expect(d.app.workbench.state.peek().revision).toBe(revision); // settled: no ping-pong between model and surface
  });

  it('C21: a user move of a tab to a new group becomes workbench.movePlacement (source view) and the model slot follows', async () => {
    const d = await make();
    const executed: CommandExecutedEvent[] = [];
    d.app.get(CommandService).onDidExecute((e) => executed.push(e));
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    const b = await d.app.workbench.showView('notes.view', { workspace: EDITOR, reuse: 'new' });
    await d.settle();
    const api = d.surface().api!;
    const panelB = api.getPanel(b.id)!;
    const before = d.app.workbench.state.peek().placements[b.id]?.dock?.group;
    panelB.api.moveTo({ group: api.getPanel(a.id)!.group, position: 'right' }); // a gesture: the tab leaves the group and gets a new one
    await d.settle();
    const after = d.app.workbench.state.peek().placements[b.id]?.dock?.group;
    expect(after).toBeDefined();
    expect(after).toBe(panelB.group.id);
    expect(after).not.toBe(before);
    expect(d.app.workbench.state.peek().placements[a.id]?.dock?.group).toBe(api.getPanel(a.id)!.group.id);
    expect(executed.some((e) => e.commandId === 'workbench.movePlacement' && e.source === 'view')).toBe(true);
    expect(panelIds(d)).toEqual(sortedMembers(d));
  });

  it('C21: a vetoed move (canMove false) is reverted: the tab goes back to its group', async () => {
    const errors = captureErrors();
    const d = await make({ canMove: false });
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    const b = await d.app.workbench.showView('notes.view', { workspace: EDITOR, reuse: 'new' });
    await d.settle();
    const api = d.surface().api!;
    const groupBefore = api.getPanel(b.id)!.group.id;
    expect(api.getPanel(a.id)!.group.id).toBe(groupBefore);
    api.getPanel(b.id)!.api.moveTo({ group: api.getPanel(a.id)!.group, position: 'right' });
    await d.settle();
    expect(api.getPanel(b.id)!.group.id).toBe(groupBefore); // moved back by the same-revision apply
    expect(api.groups.length).toBe(1);
    expect(panelIds(d)).toEqual(sortedMembers(d));
    errors.drain(); // the rejected move is reported by the command service
    errors.dispose();
  });

  it('C21: the tab close button routes through the workbench close pipeline: canClose can veto it', async () => {
    const d = await make();
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    await d.settle();
    d.plugin.closable.set(false);
    const button = d.host.querySelector('.dv-tessera-tab-close') as HTMLButtonElement;
    button.click();
    await d.settle();
    expect(d.app.workbench.placement(a.id)).toBeDefined(); // vetoed by the presenter
    expect(panelIds(d)).toEqual([a.id]);
    d.plugin.closable.set(true);
    (d.host.querySelector('.dv-tessera-tab-close') as HTMLButtonElement).click();
    await d.settle();
    expect(d.app.workbench.placement(a.id)).toBeUndefined();
    expect(panelIds(d)).toEqual([]);
  });

  it('C21: the tab title follows the presenter title observable, not only the title at apply time', async () => {
    const d = await make();
    await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    await d.settle();
    const label = (): string | null | undefined => d.host.querySelector('.dv-tessera-tab-title')?.textContent;
    expect(label()).toBe('Notes: hello');
    d.plugin.text.set('bye');
    await d.settle();
    expect(label()).toBe('Notes: bye');
  });

  it('C21: a placement whose plugin is deactivated shows a placeholder panel with its state kept, and the view returns on reactivation', async () => {
    const d = await make();
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    await d.settle();
    expect(d.host.textContent).toContain('note: hello');
    await d.app.plugins.deactivate('test.notes');
    await d.settle();
    expect(d.app.workbench.placement(a.id)?.status.peek()).toBe(PlacementStatus.Placeholder);
    expect(d.host.querySelector('[role="note"]')?.textContent).toContain('notes.view');
    expect(panelIds(d)).toEqual([a.id]); // the panel stays; membership belongs to the model
    await d.app.plugins.activate('test.notes');
    await d.settle();
    expect(d.host.querySelector('[role="note"]')).toBeNull();
    expect(d.host.textContent).toContain('note: hello');
  });
});

describe('C27: dockview arrangement blobs are wrapped and survive a restart', () => {
  it('C27: the layout is saved as a wrapped blob and a restart restores the same panels in the same groups', async () => {
    const d = await make();
    const a = await d.app.workbench.showView('notes.view', { workspace: EDITOR });
    const b = await d.app.workbench.showView('notes.view', { workspace: EDITOR, reuse: 'new' });
    await d.settle();
    d.surface().api!.getPanel(b.id)!.api.moveTo({ group: d.surface().api!.getPanel(a.id)!.group, position: 'right' });
    await d.settle();
    await d.app.advance(3000); // write-behind: the layout store saves after its debounce
    const arrangement = d.surface().snapshot(); // the layout store takes the live blob of the surface when it saves
    expect(arrangement).toMatchObject({ engine: 'dockview', engineVersion: '8.8' });
    expect(JSON.parse(JSON.stringify(arrangement))).toEqual(arrangement); // JSON-safe

    const storage = d.app.storage;
    d.detach();
    live.splice(live.indexOf(d), 1);
    await d.app.dispose();
    const again = await make({ storage });
    await again.settle();
    expect(panelIds(again)).toEqual(sortedMembers(again));
    expect(panelIds(again)).toEqual([a.id, b.id].sort());
    const groups = new Set([a.id, b.id].map((id) => again.surface().api!.getPanel(id)!.group.id));
    expect(groups.size).toBe(2); // the split survived
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandService, LAYOUT_STORAGE_KEY, LayoutStore, WorkbenchService, type PlacementId } from '@tessera/contracts';
import { localStorageBackend } from '@tessera/host-web';
import { captureErrors } from '@tessera/testing';
import { seedOlderLayout, DEMO_PROJECT } from '../src/seed.ts';
import { execute, selectedIds, startDemo, taskTitles, views, type TestDemo } from './kit.tsx';

// C28: the demo script (apps/demo/README.md) in real Chromium: boots startWebApp through bootDemo, replays the six demo items
// by clicking the demo buttons and the UI, reloads (dispose + boot over the same localStorage) and checks that the state came back.
let current: TestDemo | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  localStorage.clear();
  document.body.replaceChildren();
});

const until = <T,>(fn: () => T): Promise<T> => vi.waitFor(fn, { timeout: 6000, interval: 20 });
const demoButton = (name: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-demo="${name}"]`)!;
const setValue = (el: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('C28: the demo script', () => {
  it('C28: items 1 to 6 on a seeded older state, then a reload that restores layout and view state', async () => {
    const errors = captureErrors();
    // seed: the layout snapshot with tasks.list local state v1, and two open tasks, as an older version of the app wrote them
    await seedOlderLayout();
    const first = (current = await startDemo());

    // item 5 (migration): the seeded v1 layout restored: side bar tab, dock tabs pd1 and pd2; visible presenters migrated v1 -> v2
    await until(() => expect(views().length).toBeGreaterThanOrEqual(2));
    const wb = first.demo.web.services.get(WorkbenchService);
    expect(Object.keys(wb.state.peek().placements).sort()).toEqual(['p:tasks.sidebar:tasks.list', 'pd1', 'pd2']);
    const pd1 = wb.placement('pd1' as PlacementId)!;
    expect(pd1.presenter).toBeDefined();
    expect(pd1.presenter!.viewState.peek()).toMatchObject({ scrollTop: 12, localFilter: '', pinned: false }); // v2 fields filled by the migration
    expect(wb.placement('pd2' as PlacementId)?.presenter).toBeUndefined(); // a hidden tab costs no presenter and keeps its stored v1 value
    const [side, dock] = views() as [HTMLElement, HTMLElement];
    expect(taskTitles(side)).toEqual(['Read the CAB book again', 'Write the framework', 'Ship the proof of concept']);
    expect(selectedIds(side)).toEqual(['t2']); // the shared selection of the snapshot
    expect(selectedIds(dock)).toEqual(['t2']);

    // item 1: select in the dock tab, local filter only in the dock tab
    dock.querySelector<HTMLElement>('li[data-task-id="t1"]')!.click();
    await until(() => expect(selectedIds(side)).toEqual(['t1']));
    setValue(dock.querySelector<HTMLInputElement>('input[aria-label="Local filter"]')!, 'cab');
    await until(() => expect(taskTitles(dock)).toEqual(['Read the CAB book again']));
    expect(taskTitles(side)).toHaveLength(3);

    // item 2: the plugin command is in the view/title menu, enabled by tasks.hasSelection, and in the palette
    const toolbar = side.closest('.tessera-pane')!.querySelector('[role="toolbar"]')!;
    const complete = [...toolbar.querySelectorAll('button')].find((b) => b.textContent === 'Complete Task')!;
    expect(complete.disabled).toBe(false); // t1 is selected
    side.querySelector<HTMLElement>('li[data-task-id="t1"]')!.click(); // deselect
    await until(() => expect([...toolbar.querySelectorAll('button')].find((b) => b.textContent === 'Complete Task')!.disabled).toBe(true));
    demoButton('palette').click();
    const palette = await until(() => {
      const el = document.querySelector('.tessera-quickinput');
      expect(el).not.toBeNull();
      return el!;
    });
    const names = [...palette.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('Add Task'))).toBe(true);
    expect(names.some((n) => n.includes('Complete Task'))).toBe(false); // disabled without a selection: hidden in the palette
    palette.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => expect(document.querySelector('.tessera-quickinput')).toBeNull());

    // item 2, positive case: select a task, focus inside the placement, then focus the palette button as a mouse click does
    // (the focus leaves the placement for the chrome). The palette still evaluates in the context of the placement.
    side.querySelector<HTMLElement>('li[data-task-id="t1"]')!.click();
    await until(() => expect(selectedIds(side)).toEqual(['t1']));
    side.querySelector<HTMLInputElement>('input[aria-label="Local filter"]')!.focus();
    demoButton('palette').focus();
    demoButton('palette').click();
    const palette2 = await until(() => {
      const el = document.querySelector('.tessera-quickinput');
      expect(el).not.toBeNull();
      return el!;
    });
    expect([...palette2.querySelectorAll('[role="option"]')].some((o) => (o.textContent ?? '').includes('Complete Task'))).toBe(true);
    palette2.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => expect(document.querySelector('.tessera-quickinput')).toBeNull());
    side.querySelector<HTMLElement>('li[data-task-id="t1"]')!.click(); // deselect again for the rest of the script
    await until(() => expect(selectedIds(side)).toEqual([]));

    // item 3: the audit log view fills with commands and events
    demoButton('open-audit').click();
    const audit = await until(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="audit-view"]');
      expect(el).not.toBeNull();
      return el!;
    });
    demoButton('add').click();
    await until(() => expect(taskTitles(side)).toHaveLength(4));
    await until(() => {
      const rows = [...audit.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
      expect(rows.some((r) => r.includes('command') && r.includes('tasks.add'))).toBe(true);
      expect(rows.some((r) => r.includes('event') && r.includes('tasks.changed'))).toBe(true);
    });

    // item 6: the WorkItem event log shows which node heard which publication
    await execute(first.demo, 'tasks.add', { title: 'Scoped to A', project: 'project-a' }); // 'inbox' tasks publish at root/tasks
    await until(() => expect(taskTitles(side)).toHaveLength(5));
    const eventLog = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-demo-events] tbody tr')].map((r) => `${r.dataset['node']}:${r.dataset['published']}`);
    await until(() => expect(eventLog()).toContain('root/tasks/project-a:workItem'));
    const log = eventLog();
    expect(log).toContain('root:global');
    expect(log).toContain('root/tasks:descendants');
    expect(log).toContain('root/tasks/project-a:workItem');
    expect(log).not.toContain('root:workItem'); // a node outside the project never hears the workItem-scoped one
    expect(log).not.toContain('root/tasks/project-b:workItem'); // and neither does a sibling project

    // item 4: failure isolation: the faulty plugin fails, a notification appears, the app keeps working
    demoButton('faulty').click();
    const alert = await until(() => {
      const el = document.querySelector('[role="alert"][data-notification="error"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(alert.textContent).toContain('sample.faulty');
    expect(alert.textContent).toContain('failed on purpose');
    demoButton('add').click();
    await until(() => expect(taskTitles(side)).toHaveLength(6)); // everything else still runs
    expect(first.demo.web.services.get(CommandService)).toBeDefined();

    // item 5 (restore): reload = dispose (flushes layout and storage) and boot again over the same localStorage
    await wb.activate('pd1' as PlacementId); // the audit tab was the last one opened: bring the tasks tab back to the front
    await until(() => expect(views()).toHaveLength(2));
    const localOf = (t: TestDemo, id: string) => (t.demo.web.services.get(WorkbenchService).placement(id as PlacementId)?.local.peek() ?? undefined) as { scrollTop: number; localFilter: string } | undefined;
    const before = { titles: taskTitles(side), scroll: localOf(first, 'p:tasks.sidebar:tasks.list')!.scrollTop, pd1Filter: localOf(first, 'pd1')!.localFilter };
    expect(before.pd1Filter).toBe('cab');
    await first.dispose();
    current = undefined;
    document.body.replaceChildren();
    const second = (current = await startDemo());
    await until(() => expect(views().length).toBeGreaterThanOrEqual(2));
    const [side2, dock2] = views() as [HTMLElement, HTMLElement];
    expect(taskTitles(side2)).toEqual(before.titles); // the tasks (project storage) came back
    expect(taskTitles(dock2)).toEqual(['Read the CAB book again']); // the dock tab's local filter survived the reload
    expect(localOf(second, 'pd1')!.localFilter).toBe('cab');
    expect(localOf(second, 'p:tasks.sidebar:tasks.list')!.scrollTop).toBe(before.scroll);
    expect(second.demo.web.services.get(WorkbenchService).placement('pd2' as PlacementId)?.presenter).toBeUndefined(); // still hidden: still no presenter
    // the layout in localStorage is now the current schema for the placements that were visible (local state v2); the hidden tab is untouched (v1)
    await second.demo.web.services.get(LayoutStore).flush();
    const backend = localStorageBackend({ projectId: DEMO_PROJECT });
    const stored = (await backend.load('project'))[LAYOUT_STORAGE_KEY] as { data: { placements: Record<string, { local?: { v: number } }> } };
    expect(stored.data.placements['pd1']?.local?.v).toBe(2);
    expect(stored.data.placements['pd2']?.local?.v).toBe(1);
    backend.dispose();
    errors.drain(); // sample.faulty's failure is the expected error of this script
    errors.dispose();
  });

  it('C28: a clean start works too: the page boots without stored state, the palette lists the plugin commands before any plugin runs', async () => {
    const t = (current = await startDemo());
    const plugins = t.demo.web.services.get(WorkbenchService);
    expect(plugins.state.peek().workspaces['workbench.editorArea']).toBeDefined();
    expect(document.querySelector('[data-part="primarySideBar"] .tessera-empty')?.textContent).toBe('No views open.'); // nothing opened yet
    demoButton('palette').click();
    const palette = await until(() => {
      const el = document.querySelector('.tessera-quickinput');
      expect(el).not.toBeNull();
      return el!;
    });
    const names = [...palette.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('Add Task'))).toBe(true); // contributed by the manifest; sample.tasks is not active yet
    expect(names.some((n) => n.includes('Clear Completed Tasks'))).toBe(true);
    palette.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

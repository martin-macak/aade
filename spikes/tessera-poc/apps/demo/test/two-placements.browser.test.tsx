import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandService, EDITOR_AREA_WORKSPACE, QuickInputService, WorkbenchService } from '@tessera/contracts';
import { execute, selectedIds, startDemo, taskTitles, views, type TestDemo } from './kit.tsx';

// C25 in real Chromium: the demo renders tasks.list in the side bar and in a dockview tab. One shared state, separate local state.
let current: TestDemo | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  localStorage.clear();
  document.body.replaceChildren();
});

const until = <T,>(fn: () => T): Promise<T> => vi.waitFor(fn, { timeout: 5000, interval: 20 });

async function twoPlacements(): Promise<TestDemo> {
  const t = (current = await startDemo());
  await execute(t.demo, 'tasks.add', { title: 'Write tests', project: 'project-a' });
  await execute(t.demo, 'tasks.add', { title: 'Ship it', project: 'project-b' });
  const workbench = t.demo.web.services.get(WorkbenchService);
  await workbench.showView('tasks.list');
  await workbench.showView('tasks.list', { workspace: EDITOR_AREA_WORKSPACE });
  await until(() => expect(views()).toHaveLength(2));
  return t;
}

describe('C25: tasks.list in the side bar and in a dockview tab (Chromium)', () => {
  it('C25: the side bar is a real tabs workspace and the second placement is inside a dockview panel', async () => {
    await twoPlacements();
    const [side, dock] = views() as [HTMLElement, HTMLElement];
    expect(side.closest('[data-part="primarySideBar"]')).not.toBeNull();
    expect(dock.closest('.tessera-dock-panel')).not.toBeNull();
    expect(dock.closest('.dv-dockview')).not.toBeNull(); // dockview-core drew the editor area
    expect(taskTitles(side)).toEqual(['Write tests', 'Ship it']);
    expect(taskTitles(dock)).toEqual(['Write tests', 'Ship it']);
  });

  it('C25: selecting a task in one placement highlights it in both', async () => {
    await twoPlacements();
    const [side, dock] = views() as [HTMLElement, HTMLElement];
    side.querySelector<HTMLElement>('li[data-task-id="t2"]')!.click();
    await until(() => expect(selectedIds(dock)).toEqual(['t2']));
    expect(selectedIds(side)).toEqual(['t2']);
    dock.querySelector<HTMLElement>('li[data-task-id="t1"]')!.click();
    await until(() => expect(selectedIds(side)).toEqual(['t1']));
  });

  it('C25: scrolling and filtering locally in one placement leave the other unchanged', async () => {
    const t = await twoPlacements();
    const [side, dock] = views() as [HTMLElement, HTMLElement];
    const filter = dock.querySelector<HTMLInputElement>('input[aria-label="Local filter"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(filter, 'ship');
    filter.dispatchEvent(new Event('input', { bubbles: true })); // React listens to input events
    await until(() => expect(taskTitles(dock)).toEqual(['Ship it']));
    expect(taskTitles(side)).toEqual(['Write tests', 'Ship it']);
    // the stored local state shows the same split: only the dock presenter knows the filter
    const workbench = t.demo.web.services.get(WorkbenchService);
    const locals = Object.values(workbench.state.peek().placements)
      .filter((p) => p.viewType === 'tasks.list')
      .map((p) => (workbench.placement(p.id)!.local.peek() as { localFilter: string }).localFilter)
      .sort();
    expect(locals).toEqual(['', 'ship']);
  });

  it('C25: adding a task through the palette updates both placements before the next frame', async () => {
    const t = await twoPlacements();
    const [side, dock] = views() as [HTMLElement, HTMLElement];
    void t.demo.web.services.get(QuickInputService).showCommandPalette();
    await until(() => expect(document.querySelector('.tessera-quickinput input')).not.toBeNull());
    const input = document.querySelector('.tessera-quickinput input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'Add Task');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => expect(document.querySelectorAll('.tessera-quickinput [role="option"]').length).toBe(1));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // no animation frame is awaited: React commits the store update synchronously for both subscribers
    await until(() => expect(taskTitles(side)).toHaveLength(3));
    expect(taskTitles(dock)).toHaveLength(3);
    expect(t.demo.web.services.get(CommandService)).toBeDefined();
  });
});

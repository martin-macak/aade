import { act, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandService, QuickInputService, WorkbenchService, EDITOR_AREA_WORKSPACE } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { execute, selectedIds, startDemo, taskTitles, views, type TestDemo } from './kit.tsx';

// C25 (jsdom fallback): the same checks as two-placements.browser.test.tsx, without dockview. jsdom has no layout engine, so
// the editor area uses the renderer's tab fallback; the side bar is the real tabs workspace. React, the presenters, the
// plugins and the shell are the real ones.
let current: TestDemo | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  localStorage.clear();
  document.body.replaceChildren();
});

async function twoPlacements(): Promise<TestDemo> {
  const errors = captureErrors();
  const t = (current = await startDemo({ dock: false, inAct: true }));
  await act(async () => {
    await execute(t.demo, 'tasks.add', { title: 'Write tests', project: 'project-a' });
    await execute(t.demo, 'tasks.add', { title: 'Ship it', project: 'project-b' });
    const workbench = t.demo.web.services.get(WorkbenchService);
    await workbench.showView('tasks.list');
    await workbench.showView('tasks.list', { workspace: EDITOR_AREA_WORKSPACE });
    await t.demo.web.services.get(WorkbenchService).state.peek();
  });
  await t.settle();
  errors.dispose();
  return t;
}

describe('C25: one tasks.list in the side bar and in a dock tab, rendered', () => {
  it('C25: both placements render the same tasks; selecting in one highlights the task in both', async () => {
    await twoPlacements();
    const [a, b] = views() as [HTMLElement, HTMLElement];
    expect(views()).toHaveLength(2);
    expect(taskTitles(a)).toEqual(['Write tests', 'Ship it']);
    expect(taskTitles(b)).toEqual(['Write tests', 'Ship it']);
    await act(async () => {
      fireEvent.click(within(a).getByText('Ship it'));
    });
    expect(selectedIds(a)).toEqual(['t2']);
    expect(selectedIds(b)).toEqual(['t2']); // the selection is shared state
  });

  it('C25: the local filter and the pinned flag of one placement leave the other unchanged', async () => {
    await twoPlacements();
    const [a, b] = views() as [HTMLElement, HTMLElement];
    await act(async () => {
      fireEvent.change(within(a).getByLabelText('Local filter'), { target: { value: 'ship' } });
    });
    expect(taskTitles(a)).toEqual(['Ship it']);
    expect(taskTitles(b)).toEqual(['Write tests', 'Ship it']); // per-placement state
    await act(async () => {
      fireEvent.click(within(b).getByLabelText('Pin this view'));
    });
    expect((within(b).getByLabelText('Pin this view') as HTMLInputElement).checked).toBe(true);
    expect((within(a).getByLabelText('Pin this view') as HTMLInputElement).checked).toBe(false);
  });

  it('C25: the shared filter changes both placements', async () => {
    await twoPlacements();
    const [a, b] = views() as [HTMLElement, HTMLElement];
    await act(async () => {
      fireEvent.change(within(a).getByLabelText('Shared filter'), { target: { value: 'write' } });
    });
    expect(taskTitles(a)).toEqual(['Write tests']);
    expect(taskTitles(b)).toEqual(['Write tests']);
  });

  it('C25: adding a task through the command palette updates both placements in the same commit', async () => {
    const t = await twoPlacements();
    const [a, b] = views() as [HTMLElement, HTMLElement];
    const quick = t.demo.web.services.get(QuickInputService);
    await act(async () => {
      void quick.showCommandPalette();
    });
    const input = document.querySelector('.tessera-quickinput input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Add Task' } });
    });
    const seen: string[][] = [];
    const observer = new MutationObserver(() => seen.push([taskTitles(a).length, taskTitles(b).length].map(String)));
    observer.observe(a, { childList: true, subtree: true });
    observer.observe(b, { childList: true, subtree: true });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await t.settle();
    });
    observer.disconnect();
    expect(taskTitles(a)).toHaveLength(3);
    expect(taskTitles(b)).toHaveLength(3);
    // act() flushes React once: no observed state has one placement ahead of the other
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([x, y]) => x === y)).toBe(true);
  });

  it('C28: a task selected in a placement, then the palette opened with the palette button (focus moves to the chrome), still lists Complete Task and runs it', async () => {
    const t = await twoPlacements();
    const [a] = views() as [HTMLElement, HTMLElement];
    const executed: Array<{ commandId: string; outcome: string }> = [];
    t.demo.web.services.get(CommandService).onDidExecute((e) => executed.push({ commandId: e.commandId, outcome: e.outcome }));
    await act(async () => {
      fireEvent.click(within(a).getByText('Ship it'));
    });
    await act(async () => {
      within(a).getByLabelText('Local filter').focus(); // a mouse click in the view focuses something inside it
    });
    const button = t.controls.querySelector<HTMLButtonElement>('[data-demo="palette"]')!;
    await act(async () => {
      button.focus(); // a mouse click on the button moves the focus out of the placement, into the chrome
      button.click();
    });
    const input = document.querySelector('.tessera-quickinput input') as HTMLInputElement;
    const names = [...document.querySelectorAll('.tessera-quickinput [role="option"]')].map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('Complete Task'))).toBe(true); // enabled by tasks.hasSelection of the placement the user came from
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Complete Task' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await t.settle();
    });
    expect(executed).toContainEqual({ commandId: 'tasks.complete', outcome: 'ok' });
  });
});

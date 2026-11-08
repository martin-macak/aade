// Runs in real Chromium (Vitest Browser Mode + Playwright). Question: do React 19 views that use Radix UI and Base UI work
// inside dockview-core panels, including a floating group? Same six checks for each library.
// Two switches, to read the stacking result under other conditions (both unset in the default run):
//   VITE_POPUP_Z=off        removes the z-index setting of the popup layer (see src/styles.css).
//   VITE_DOCK_ISOLATE=on    gives the dock container `isolation: isolate`, so dockview's z-index values stay inside the dock.
import { createDockview, themeLight, type DockviewApi, type IDockviewPanel } from 'dockview-core';
import type { ComponentType } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createReactComponent, type AdapterStats, type PanelProps } from '../src/dock-react.tsx';
import { injectDockviewCss } from '../src/dockview-css.ts';
import { BaseView, FillerView, RadixView, probe } from '../src/views.tsx';

interface Rig {
  container: HTMLElement;
  dock: DockviewApi;
  stats: AdapterStats;
  panel: IDockviewPanel;
  filler: IDockviewPanel;
  panelEl: HTMLElement;
  bodyChildren: Set<Element>;
  disposed: boolean;
}

let rig: Rig | undefined;
let errors: string[] = [];
let warnings: string[] = [];
const restore: Array<() => void> = [];

beforeAll(() => {
  injectDockviewCss();
  console.info(`[env] ${navigator.userAgent}`);
});

beforeEach(() => {
  probe.mounts = probe.unmounts = probe.instances = 0;
  errors = [];
  warnings = [];
  if (import.meta.env['VITE_POPUP_Z'] === 'off') document.documentElement.style.removeProperty('--popup-z');
  else document.documentElement.style.setProperty('--popup-z', '1000');

  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(`console.error: ${args.map(String).join(' ')}`);
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(`console.warn: ${args.map(String).join(' ')}`);
    origWarn(...args);
  };
  const onError = (e: ErrorEvent) => void errors.push(`window error: ${e.message}`);
  const onRejection = (e: PromiseRejectionEvent) => void errors.push(`unhandled rejection: ${String(e.reason)}`);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  restore.push(
    () => (console.error = origError),
    () => (console.warn = origWarn),
    () => window.removeEventListener('error', onError),
    () => window.removeEventListener('unhandledrejection', onRejection),
  );
});

afterEach(async () => {
  if (rig && !rig.disposed) rig.dock.dispose();
  rig?.container.remove();
  rig = undefined;
  // Let any late React or dockview error surface before the listeners go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (restore.length) restore.pop()!();
  if (warnings.length) console.info(`[warnings] ${warnings.join(' | ')}`);
  expect(errors, 'console errors and page errors').toEqual([]);
});

/** One dockview with the view panel in one group and a filler panel in a second group to its right. */
function mount(View: ComponentType<PanelProps>): Rig {
  const container = document.createElement('div');
  container.id = 'dock';
  // position:absolute with z-index:auto does NOT create a stacking context, so dockview's own z-index values (floating layer 999,
  // drop-target layer 9999) take part in the page's root stacking context. position:fixed would hide that, because it always isolates.
  container.style.cssText = 'position:absolute;left:0;top:0;width:1000px;height:640px';
  if (import.meta.env['VITE_DOCK_ISOLATE'] === 'on') container.style.isolation = 'isolate';
  document.body.append(container);
  const bodyChildren = new Set(Array.from(document.body.children));
  const stats: AdapterStats = { rootsCreated: 0, rootsUnmounted: 0 };
  const dock = createDockview(container, { theme: themeLight, createComponent: createReactComponent({ view: View, filler: FillerView }, stats) });
  const panel = dock.addPanel({ id: 'view-panel', component: 'view', title: 'View' });
  const filler = dock.addPanel({ id: 'filler-panel', component: 'filler', title: 'Filler', position: { direction: 'right' } });
  rig = { container, dock, stats, panel, filler, panelEl: panel.view.content.element, bodyChildren, disposed: false };
  return rig;
}

const byId = (root: ParentNode, id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const find = (root: ParentNode, id: string): Promise<HTMLElement> =>
  vi.waitFor(
    () => {
      const el = byId(root, id);
      if (!el) throw new Error(`[data-testid=${id}] not found`);
      return el;
    },
    { timeout: 5000, interval: 25 },
  );
const gone = (root: ParentNode, id: string): Promise<void> =>
  vi.waitFor(() => expect(byId(root, id), `[data-testid=${id}] should be gone`).toBeNull(), { timeout: 5000, interval: 25 });

/** Wait until an element has a non-empty box that did not move between two polls (popup positioning is async). */
async function settled(el: Element): Promise<DOMRect> {
  let previous = '';
  return vi.waitFor(
    () => {
      const r = el.getBoundingClientRect();
      const key = [r.x, r.y, r.width, r.height].join(',');
      const same = key === previous;
      previous = key;
      if (!same || r.width === 0 || r.height === 0) throw new Error(`not settled yet: ${key}`);
      return r;
    },
    { timeout: 5000, interval: 50 },
  );
}

async function openPopover(r: Rig): Promise<{ trigger: HTMLElement; popup: HTMLElement }> {
  const trigger = await find(r.panelEl, 'trigger');
  await userEvent.click(trigger);
  const popup = await find(document.body, 'popup');
  await settled(popup);
  return { trigger, popup };
}

function describeEl(el: Element | null): string {
  if (!el) return 'null';
  return `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`;
}

/** The popover check of test 2 and test 5. */
function expectPopupVisibleAndOutsideDock(r: Rig, trigger: HTMLElement, popup: HTMLElement): void {
  // It is a portal: outside the panel, outside the whole dockview, outside any dv- element.
  expect(r.panelEl.contains(popup), 'popup is inside the panel element').toBe(false);
  expect(r.container.contains(popup), 'popup is inside the dockview container').toBe(false);
  expect(popup.closest('[class*="dv-"]'), 'popup has a dockview ancestor').toBeNull();
  expect(document.body.contains(popup)).toBe(true);

  // Report the z-index of the popup layer, to read the result against.
  for (let el: HTMLElement | null = popup; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'static') {
      console.info(`[popup layer] ${describeEl(el)} position ${cs.position} z-index ${cs.zIndex}`);
      break;
    }
  }

  // It has a real box inside the viewport (a clipped box would be cut off).
  const rect = popup.getBoundingClientRect();
  expect(rect.width, 'popup width').toBeGreaterThan(100);
  expect(rect.height, 'popup height').toBeGreaterThan(20);
  expect(rect.left, 'popup left').toBeGreaterThanOrEqual(0);
  expect(rect.top, 'popup top').toBeGreaterThanOrEqual(0);
  expect(rect.right, 'popup right').toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom, 'popup bottom').toBeLessThanOrEqual(window.innerHeight);

  // Placement: below the trigger (sideOffset 6) and aligned to its start edge.
  const t = trigger.getBoundingClientRect();
  expect(Math.abs(rect.left - t.left), 'popup left vs trigger left').toBeLessThanOrEqual(3);
  expect(rect.top - t.bottom, 'gap between trigger and popup').toBeGreaterThanOrEqual(0);
  expect(rect.top - t.bottom, 'gap between trigger and popup').toBeLessThanOrEqual(12);

  // Nothing covers it: the hit element at the centre and at four inner points is the popup or a child of it.
  const points: Array<[string, number, number]> = [
    ['centre', 0.5, 0.5],
    ['top-left', 0.1, 0.15],
    ['top-right', 0.9, 0.15],
    ['bottom-left', 0.1, 0.85],
    ['bottom-right', 0.9, 0.85],
  ];
  for (const [name, fx, fy] of points) {
    const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
    expect(hit !== null && popup.contains(hit), `elementFromPoint(${name}) hit ${describeEl(hit)}, not the popup`).toBe(true);
  }
}

const libraries: Array<[string, ComponentType<PanelProps>]> = [
  ['Radix UI', RadixView],
  ['Base UI', BaseView],
];

describe.each(libraries)('%s inside dockview-core panels', (_name, View) => {
  it('1: the view renders inside a dockview panel with a non-zero size', async () => {
    const r = mount(View);
    const view = await find(r.panelEl, 'view');
    const box = await settled(view);
    expect(box.width, 'view width').toBeGreaterThan(300);
    expect(box.height, 'view height').toBeGreaterThan(100);
    const panelBox = r.panelEl.getBoundingClientRect();
    expect(panelBox.width, 'panel element width').toBeGreaterThan(300);
    expect(panelBox.height, 'panel element height').toBeGreaterThan(100);
    expect(r.container.contains(view), 'view is inside the dock').toBe(true);
    expect(r.panel.api.group.api.location.type).toBe('grid');
    for (const id of ['trigger', 'checkbox']) {
      const part = await find(r.panelEl, id);
      const b = part.getBoundingClientRect();
      expect(b.width * b.height, `${id} has a box`).toBeGreaterThan(0);
    }
    expect(r.stats.rootsCreated, 'React roots created (view and filler)').toBe(2);
    expect(probe.mounts).toBe(1);
  });

  it('2: the popover opens, is portalled outside the panel, and nothing from dockview covers it', async () => {
    const r = mount(View);
    const { trigger, popup } = await openPopover(r);
    expectPopupVisibleAndOutsideDock(r, trigger, popup);
  });

  it('3: focus moves into the popover, Escape closes it, focus returns to the trigger', async () => {
    const r = mount(View);
    const { trigger, popup } = await openPopover(r);
    await vi.waitFor(() => expect(popup.contains(document.activeElement), `focus is on ${describeEl(document.activeElement)}`).toBe(true), { timeout: 5000 });
    await userEvent.keyboard('{Escape}');
    await gone(document.body, 'popup');
    await vi.waitFor(() => expect(document.activeElement, `focus is on ${describeEl(document.activeElement)}`).toBe(trigger), { timeout: 5000 });
    // The panel is still intact after Escape: the view is still mounted and the popover can open again.
    expect(probe.unmounts).toBe(0);
    const again = await openPopover(r);
    expect(again.popup.isConnected).toBe(true);
  });

  it('4: the checkbox changes state, and the state survives moving the panel to another group', async () => {
    const r = mount(View);
    const view = await find(r.panelEl, 'view');
    const checkbox = await find(r.panelEl, 'checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(checkbox);
    await vi.waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'), { timeout: 5000 });
    const instance = view.dataset['instance'];
    const groupBefore = r.panel.api.group.id;
    const fillerGroup = r.filler.api.group;
    expect(fillerGroup.id, 'filler lives in another group').not.toBe(groupBefore);

    r.panel.api.moveTo({ group: fillerGroup });
    await vi.waitFor(() => expect(r.panel.api.group.id).toBe(fillerGroup.id), { timeout: 5000 });
    expect(r.panel.api.group.id).not.toBe(groupBefore);

    // Same DOM node, same React instance, same state: nothing was remounted.
    const viewAfter = await find(r.panelEl, 'view');
    await settled(viewAfter);
    expect(viewAfter, 'same view element').toBe(view);
    expect(await find(r.panelEl, 'checkbox'), 'same checkbox element').toBe(checkbox);
    expect(viewAfter.dataset['instance'], 'same React instance').toBe(instance);
    expect(checkbox.getAttribute('aria-checked'), 'checkbox state after the move').toBe('true');
    expect(probe.mounts, 'view mounts').toBe(1);
    expect(probe.unmounts, 'view unmounts').toBe(0);
    expect(r.stats.rootsUnmounted, 'React roots unmounted').toBe(0);
    expect(r.container.contains(viewAfter)).toBe(true);
    expect(viewAfter.getBoundingClientRect().width, 'view width after the move').toBeGreaterThan(300);

    // The checkbox still works after the move.
    await userEvent.click(checkbox);
    await vi.waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('false'), { timeout: 5000 });
  });

  it('5: the same popover check passes when the panel is inside a floating group', async () => {
    const r = mount(View);
    r.dock.addFloatingGroup(r.panel, { x: 80, y: 60, width: 520, height: 360 });
    await vi.waitFor(() => expect(r.panel.api.group.api.location.type).toBe('floating'), { timeout: 5000 });
    const view = await find(r.panelEl, 'view');
    const box = await settled(view);
    expect(box.width, 'floating view width').toBeGreaterThan(300);
    // Report the stacking context of the floating layer, to read the result against.
    for (let el: HTMLElement | null = view; el && el !== r.container; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.zIndex !== 'auto') console.info(`[floating] ancestor ${describeEl(el)} z-index ${cs.zIndex} position ${cs.position}`);
    }
    const { trigger, popup } = await openPopover(r);
    expectPopupVisibleAndOutsideDock(r, trigger, popup);
    // Focus and Escape work in the floating group too.
    await vi.waitFor(() => expect(popup.contains(document.activeElement), `focus is on ${describeEl(document.activeElement)}`).toBe(true), { timeout: 5000 });
    await userEvent.keyboard('{Escape}');
    await gone(document.body, 'popup');
    await vi.waitFor(() => expect(document.activeElement, `focus is on ${describeEl(document.activeElement)}`).toBe(trigger), { timeout: 5000 });
  });

  it('extra: switching tabs (dockview detaches and re-attaches the panel element) keeps the React state', async () => {
    const r = mount(View);
    const view = await find(r.panelEl, 'view');
    const checkbox = await find(r.panelEl, 'checkbox');
    await userEvent.click(checkbox);
    await vi.waitFor(() => expect(checkbox.getAttribute('aria-checked')).toBe('true'), { timeout: 5000 });
    // Put both panels into one group as tabs, then switch away from the view and back.
    r.filler.api.moveTo({ group: r.panel.api.group });
    await vi.waitFor(() => expect(r.filler.api.group.id).toBe(r.panel.api.group.id), { timeout: 5000 });
    r.filler.api.setActive();
    await vi.waitFor(() => expect(view.isConnected, 'view element is detached while its tab is hidden').toBe(false), { timeout: 5000 });
    r.panel.api.setActive();
    await vi.waitFor(() => expect(view.isConnected).toBe(true), { timeout: 5000 });
    await settled(view);
    expect(checkbox.getAttribute('aria-checked'), 'checkbox state after the tab switch').toBe('true');
    expect(probe.mounts).toBe(1);
    expect(probe.unmounts).toBe(0);
    // The popover still works after the switch.
    const { trigger, popup } = await openPopover(r);
    expectPopupVisibleAndOutsideDock(r, trigger, popup);
  });

  it('6: removing the panel and disposing the dock unmount React without errors', async () => {
    const r = mount(View);
    await find(r.panelEl, 'view');
    await openPopover(r); // remove the panel while its popup is open: the hard case
    expect(r.stats.rootsCreated).toBe(2);

    r.dock.removePanel(r.panel);
    await vi.waitFor(() => expect(probe.unmounts, 'view effect cleanup ran').toBe(1), { timeout: 5000 });
    expect(r.stats.rootsUnmounted, 'React root unmounted by dispose()').toBe(1);
    expect(r.panelEl.childElementCount, 'panel element is empty').toBe(0);
    await gone(document.body, 'popup');
    const leftovers = Array.from(document.body.children).filter((el) => !r.bodyChildren.has(el));
    expect(leftovers.map(describeEl), 'portal nodes left in <body>').toEqual([]);
    expect(r.dock.panels.map((p) => p.id)).toEqual(['filler-panel']);

    r.dock.dispose();
    r.disposed = true;
    expect(r.stats.rootsUnmounted, 'React roots unmounted after dispose of the dock').toBe(2);
    expect(r.stats.rootsUnmounted).toBe(r.stats.rootsCreated);
    expect(byId(r.container, 'filler'), 'filler content removed from the DOM').toBeNull();
    expect(r.container.querySelector('[class*="dv-"]'), 'dockview DOM left in the container').toBeNull();
  });
});

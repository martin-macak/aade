// Not a capability: item 9 of the brief. Is floating or pop-out native? This characterization test fails if Lumino adds it.
import { DockLayout, DockPanel, TabBar } from '@lumino/widgets';
import { describe, expect, it } from 'vitest';

const members = (proto: object): string[] => {
  const names: string[] = [];
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) names.push(...Object.getOwnPropertyNames(p));
  return names;
};

describe('CX floating and pop-out panels', () => {
  it('CX: DockPanel, DockLayout and TabBar have no member about floating, popping out or undocking; the only related hook is tabDetachRequested', () => {
    const all = [...members(DockPanel.prototype), ...members(DockLayout.prototype), ...members(TabBar.prototype)];
    expect(all.filter((name) => /float|pop|undock|window/i.test(name))).toEqual([]);
    const lifecycle = /^(onAfterDetach|onBeforeDetach|detachWidget)$/; // Widget attach/detach messages, unrelated
    expect([...new Set(all.filter((name) => /detach/i.test(name) && !lifecycle.test(name)))].sort()).toEqual(['_onTabDetachRequested', 'tabDetachRequested']);
  });

  it('CX: the DockPanel `document` option exists (for another Document or a ShadowRoot) but nothing creates the window', () => {
    // DockPanel.IOptions.document is passed to Drag and to the tab bar; opening a window and moving a widget there is up to the application.
    const dock = new DockPanel({ document });
    expect(dock.node.ownerDocument).toBe(document);
  });
});

import { toDisposable, type IDisposable } from '@tessera/base';
import type { PlacementId } from '@tessera/contracts';

/** The attribute that marks the root element of a placement, for focus tracking and context lookup. */
export const PLACEMENT_ATTRIBUTE = 'data-tessera-placement';

/** Marks a host element as the root of a placement. The mark ends with the returned disposable. */
export function markPlacementHost(element: HTMLElement, id: PlacementId): IDisposable {
  element.setAttribute(PLACEMENT_ATTRIBUTE, id);
  return toDisposable(() => {
    if (element.getAttribute(PLACEMENT_ATTRIBUTE) === id) element.removeAttribute(PLACEMENT_ATTRIBUTE);
  });
}

/** The placement id of the nearest marked ancestor (or the element itself), or undefined. */
export function placementIdOf(node: EventTarget | null | undefined): PlacementId | undefined {
  let element: Element | null = node instanceof Element ? node : null;
  while (element) {
    const value = element.getAttribute(PLACEMENT_ATTRIBUTE);
    if (value) return value as PlacementId;
    element = element.parentElement;
  }
  return undefined;
}

/** The attribute that marks workbench chrome: toolbars, palette, status bar, demo controls. Focus there keeps the focused placement. */
export const CHROME_ATTRIBUTE = 'data-tessera-chrome';

/** true when the node is inside an element marked as chrome. A placement inside the chrome still wins: check placementIdOf first. */
export function isChrome(node: EventTarget | null | undefined): boolean {
  return node instanceof Element && node.closest(`[${CHROME_ATTRIBUTE}]`) !== null;
}

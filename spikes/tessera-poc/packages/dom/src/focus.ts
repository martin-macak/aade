import { toDisposable, type IDisposable } from '@tessera/base';
import { WorkItemService, WorkbenchAdapterApi } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { isChrome, placementIdOf } from './placement-host.ts';

/** true for elements that take text input: the context key `inputFocus` (contracts.md 12.3). */
export function isEditable(node: EventTarget | null | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(node.type);
  return false;
}

/**
 * Tracks focusin and focusout. Focus inside an element marked with data-tessera-placement is reported with
 * WorkbenchAdapterApi.reportFocus. Focus on an element outside every placement clears the focused placement, unless the
 * element is inside workbench chrome (data-tessera-chrome): then the last one stays. Losing focus to nothing (window
 * blur) keeps the last one. Sets the context key `inputFocus` on the window scope.
 */
export function installFocusTracking(target: Document, services: ScopeReader): IDisposable {
  const adapter = (): WorkbenchAdapterApi | undefined => services.get(WorkbenchAdapterApi, { optional: true });
  const setInputFocus = (value: boolean): void => {
    const items = services.get(WorkItemService, { optional: true });
    items?.root.context.set('inputFocus', value);
  };
  const onFocusIn = (event: FocusEvent): void => {
    const placement = placementIdOf(event.target);
    // Chrome (palette button, toolbar, status bar) is not a place of its own: the last focused placement stays, so a command
    // started from the chrome evaluates in the context of the view the user was working in.
    if (placement !== undefined || !isChrome(event.target)) adapter()?.reportFocus(placement);
    setInputFocus(isEditable(event.target));
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget === null) setInputFocus(false);
  };
  target.addEventListener('focusin', onFocusIn);
  target.addEventListener('focusout', onFocusOut);
  return toDisposable(() => {
    target.removeEventListener('focusin', onFocusIn);
    target.removeEventListener('focusout', onFocusOut);
  });
}

import { toDisposable, type IDisposable } from '@tessera/base';
import { ContextKeyService, KeybindingService, type KeyPress } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);

/** KeyboardEvent to the normalized KeyPress the KeybindingService understands (contracts.md 13.2). */
export function keyPressOf(event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): KeyPress {
  return { code: event.code, key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey };
}

/**
 * KeyboardEvent to KeyPress, then KeybindingService.dispatch with the focused context-key scope. Calls preventDefault
 * when the press is handled or starts a chord (contracts.md 18.3). Pure modifier presses and IME composition are skipped.
 */
export function installKeyboard(target: Document, services: ScopeReader): IDisposable {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || MODIFIER_KEYS.has(event.key)) return;
    const keybindings = services.get(KeybindingService, { optional: true });
    if (!keybindings) return;
    const context = services.get(ContextKeyService).focused.peek();
    const result = keybindings.dispatch(keyPressOf(event), context);
    if (result.kind !== 'unhandled') event.preventDefault();
  };
  target.addEventListener('keydown', onKeyDown);
  return toDisposable(() => target.removeEventListener('keydown', onKeyDown));
}

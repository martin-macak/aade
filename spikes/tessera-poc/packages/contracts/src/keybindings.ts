import type { Event, IDisposable } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';
import type { ContextKeyScope, ContextReader } from './context-keys.ts';

/** Normalized key press. The DOM adapter builds it from KeyboardEvent. */
export interface KeyPress {
  readonly code: string;            // KeyboardEvent.code, for example 'KeyK', 'Digit1', 'Enter'
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type KeybindingSource = 'core' | 'plugin' | 'user';

export interface KeybindingRule {
  /** 'mod+k mod+t': parts joined by space form a chord. Modifiers: ctrl, shift, alt, meta, cmd (= meta), mod (meta on mac, ctrl elsewhere). */
  readonly key: string;
  readonly mac?: string;
  readonly win?: string;
  readonly linux?: string;
  /** '-<commandId>' in a user rule removes matching lower-source bindings. */
  readonly command: string;
  readonly args?: unknown;
  readonly when?: string;
  readonly source: KeybindingSource;
  readonly owner?: string;
}

export type DispatchResult =
  | { readonly kind: 'handled'; readonly commandId: string }
  | { readonly kind: 'chord'; readonly prefix: string }
  | { readonly kind: 'unhandled' };

export interface ResolvedKeybinding {
  readonly rule: KeybindingRule;
  readonly label: string;                 // platform display form, 'Ctrl+K Ctrl+T'
}

export interface KeybindingConflict {
  readonly key: string;
  readonly rules: readonly KeybindingRule[];
}

export interface KeybindingService {
  register(rule: KeybindingRule): IDisposable;
  /** Resolves and executes (source 'keybinding'). The adapter calls preventDefault() unless 'unhandled'. */
  dispatch(press: KeyPress, context: ContextKeyScope): DispatchResult;
  lookup(commandId: string, context?: ContextReader): readonly ResolvedKeybinding[];
  /** The pending chord prefix, for the status bar. */
  readonly chord: Observable<string | undefined>;
  readonly conflicts: Observable<readonly KeybindingConflict[]>;
  readonly onDidChange: Event<void>;
}
export const KeybindingService: Token<KeybindingService> = token<KeybindingService>('tessera.keybindings');

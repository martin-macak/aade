import type { IDisposable } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';
import type { ContextKeyScope } from './context-keys.ts';

export interface StatusBarItemRule {
  readonly id: string;
  readonly alignment: 'left' | 'right';
  readonly priority?: number;                           // higher is further out
  readonly text: string | Observable<string>;
  readonly tooltip?: string | Observable<string>;
  readonly command?: string;
  readonly args?: unknown;
  readonly when?: string;
  readonly owner?: string;
}
export interface StatusBarItemView {
  readonly id: string;
  readonly alignment: 'left' | 'right';
  readonly text: string;
  readonly tooltip: string | undefined;
  readonly command: string | undefined;
  /** 'disabled' when the command is disabled or not registered yet: the renderer draws the item disabled. An item without a command is 'enabled'. */
  readonly status: 'enabled' | 'disabled';
  /** Runs the item's command with source 'statusBar' and the item's args. Resolves to undefined for an item without a command. */
  run(options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}
/** The visible items, already sorted for display: left to right in each list. */
export interface StatusBarItems {
  readonly left: readonly StatusBarItemView[];
  readonly right: readonly StatusBarItemView[];
}
export interface StatusBarService {
  add(rule: StatusBarItemRule): IDisposable;
  /** Visible items for a window context-key scope. The service owns presentation and run; a renderer only draws. */
  items(context: ContextKeyScope): Observable<StatusBarItems>;
}
export const StatusBarService: Token<StatusBarService> = token<StatusBarService>('tessera.statusBar');

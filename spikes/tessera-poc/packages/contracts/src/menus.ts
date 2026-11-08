import type { IDisposable } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';
import type { CommandPresentation } from './commands.ts';
import type { ContextKeyScope } from './context-keys.ts';

export const MenuId = {
  CommandPalette: 'commandPalette',
  MenuBar: 'menuBar',                      // top level; submenus are 'menuBar/<name>'
  ViewTitle: 'view/title',                 // toolbar of a placement title
  ViewContext: 'view/context',             // context menu inside a view
  WorkspaceTitle: 'workspace/title',       // toolbar of a workspace (container) title
  PlacementTab: 'placement/tab',           // context menu of a dock tab
  StatusBarContext: 'statusBar/context',
} as const;

export interface MenuItemRule {
  readonly menu: string;
  readonly command: string;
  readonly args?: unknown;
  /** 'navigation' sorts first, then by name. Inside a group: order, then title. */
  readonly group?: string;
  readonly order?: number;
  /** Visibility. Enablement comes from the command. */
  readonly when?: string;
  /** Alternative command shown with the alt key. */
  readonly alt?: string;
  /** Instead of a command: opens this submenu id. */
  readonly submenu?: string;
  readonly title?: string;                 // overrides the command title in this menu
  readonly owner?: string;
}

export interface MenuItemView {
  readonly id: string;
  readonly command: string | undefined;
  readonly submenu: string | undefined;
  readonly args: unknown;
  readonly presentation: CommandPresentation;
}
export interface MenuGroup { readonly id: string; readonly items: readonly MenuItemView[] }

export interface Menu extends IDisposable {
  readonly id: string;
  /** Recomputed when items, command metadata, handlers or relevant context keys change. */
  readonly groups: Observable<readonly MenuGroup[]>;
  run(item: MenuItemView, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface MenuRegistry {
  addItem(rule: MenuItemRule): IDisposable;
  items(menu: string): Observable<readonly MenuItemRule[]>;
}
export const MenuRegistry: Token<MenuRegistry> = token<MenuRegistry>('tessera.menuRegistry');

export interface MenuService {
  createMenu(menu: string, context: ContextKeyScope): Menu;
}
export const MenuService: Token<MenuService> = token<MenuService>('tessera.menuService');

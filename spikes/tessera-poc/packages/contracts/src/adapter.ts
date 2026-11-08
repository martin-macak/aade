import type { IDisposable } from '@tessera/base';
import { token, type ScopeReader, type Token } from '@tessera/di';
import type { ContextKeyScope } from './context-keys.ts';
import type { PlacementRef, RendererId, WindowId } from './ids.ts';
import type { Placement, Presenter } from './workbench.ts';

// contracts.md section 18.1: rendering-adapter boundary (types only in stage B).

export interface ViewContext {
  readonly placement: PlacementRef;
  readonly contextKeys: ContextKeyScope;
  /** DI scope of the placement. */
  readonly services: ScopeReader;
  /** Executes with source 'view' and this placement id. */
  executeCommand<R = unknown>(id: string, args?: unknown): Promise<R>;
  /** Reports with source 'view' and the view owner's plugin id. */
  reportError(error: unknown): void;
}

/**
 * The gate for the view door (contracts.md 14.6). `createViewContext` asks it, with the owner of the view type, what a view
 * gets as `ViewContext.services` and `ViewContext.contextKeys`. The plugins package registers it: a plugin-owned view gets the
 * plugin's gated reader and a context-key facade. Owner `core`, or no policy, keeps the raw scopes (framework chrome).
 */
export interface ViewServicesPolicy {
  readerFor(owner: string, scope: ScopeReader): ScopeReader;
  contextFor(owner: string, scope: ContextKeyScope): ContextKeyScope;
}
export const ViewServicesPolicy: Token<ViewServicesPolicy> = token<ViewServicesPolicy>('tessera.viewServicesPolicy');

export interface MountTarget {
  readonly placement: Placement;
  readonly presenter: Presenter;
  readonly context: ViewContext;
}

/** One per renderer. Mounts the view of one placement into a host element. */
export interface ViewMounter<E = unknown> {
  readonly rendererId: RendererId;
  ensureUi(viewType: string): Promise<boolean>;
  canMount(viewType: string): boolean;
  mount(host: E, target: MountTarget): IDisposable;
}
export const ViewMounter: Token<ViewMounter> = token<ViewMounter>('tessera.viewMounter');

/** Renders a window: parts, workspaces, menus, status bar, palette, notifications. */
export interface WorkbenchRenderer<E = unknown> {
  readonly rendererId: RendererId;
  render(host: E, windowId: WindowId): IDisposable;
}

/** The default export of a plugin's ui[rendererId] entry. */
export interface UiModule {
  readonly rendererId: RendererId;
  readonly views: readonly unknown[];
}

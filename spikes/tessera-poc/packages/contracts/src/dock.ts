import type { Event, IDisposable } from '@tessera/base';
import type { DockArrangement, DockPosition, DockSlot, PlacementId } from './ids.ts';
import type { ViewMounter } from './adapter.ts';
import type { Presenter } from './workbench.ts';
import { token, type Token } from '@tessera/di';

// contracts.md section 15.9: dock surface and two-way sync.

export interface DockDesired {
  readonly revision: number;
  readonly members: ReadonlyArray<{
    readonly id: PlacementId;
    readonly title: string;
    /** Only for new members. */
    readonly position: DockPosition | undefined;
    readonly where: 'grid' | 'floating' | 'popout';
  }>;
  readonly active: PlacementId | undefined;
}

export interface DockChange {
  /** 'user': a gesture in the surface. 'model': an echo of apply(), adapters drop these. */
  readonly origin: 'user' | 'model';
  /** The model revision the surface had applied when it built this report. */
  readonly revision: number;
  readonly reasons: ReadonlySet<'geometry' | 'structure' | 'active'>;
  /** For 'structure': where every member is now. */
  readonly projection: ReadonlyMap<PlacementId, DockSlot> | undefined;
  readonly active: PlacementId | undefined;
}

export interface DockRestoreReport {
  readonly restored: readonly PlacementId[];
  readonly dropped: readonly PlacementId[];
  /** true when the blob was rejected and the surface rebuilt a default grid from members. */
  readonly rebuilt: boolean;
}

/** One dock workspace. E is the host element type of the renderer (HTMLElement for DOM adapters). */
export interface DockSurface<E = unknown> extends IDisposable {
  readonly engine: { readonly id: string; readonly version: string };
  mount(host: E, deps: { readonly mounter: ViewMounter<E>; readonly adapter: WorkbenchAdapterApi; readonly workspaceId: string }): void;
  /** Model to surface. Re-projects membership; live views are reused, not remounted. */
  apply(desired: DockDesired): Promise<void>;
  /** Surface to model, coalesced. */
  readonly onDidChange: Event<DockChange>;
  snapshot(): DockArrangement;
  restore(arrangement: DockArrangement, known: ReadonlySet<PlacementId>): Promise<DockRestoreReport>;
}

export interface DockSurfaceFactory<E = unknown> {
  create(workspaceId: string): DockSurface<E>;
}
export const DockSurfaceFactory: Token<DockSurfaceFactory> = token<DockSurfaceFactory>('tessera.dockSurfaceFactory');

/** The port that rendering adapters and dock surfaces use to report facts to the workbench (contracts.md 15.8). */
export interface WorkbenchAdapterApi {
  reportVisible(id: PlacementId, visible: boolean): void;
  reportFocus(id: PlacementId | undefined): void;
  reportDockChange(workspaceId: string, change: DockChange): void;
  /** Tab close button, close keybinding inside a view: runs workbench.closePlacement with source 'view'. */
  requestClose(id: PlacementId): void;
  /** The presenter of a visible placement, created if needed. undefined for placeholders. */
  ensurePresenter(id: PlacementId): Promise<Presenter | undefined>;
}
export const WorkbenchAdapterApi: Token<WorkbenchAdapterApi> = token<WorkbenchAdapterApi>('tessera.workbenchAdapter');


/**
 * Stage C addition (see deviations.md): the port a renderer uses to give a dock surface its real host element.
 * The workbench mounts every surface at once with `mount(undefined, ...)` so that a headless run works (stage B).
 * A DOM surface treats that call as "deferred": it tracks the model but draws nothing. `attach` binds it to a host
 * element and the renderer's ViewMounter, and the returned disposable detaches it again. The surface factory of a docking
 * adapter implements both DockSurfaceFactory and DockSurfaceHost.
 */
export interface DockSurfaceHost<E = unknown> {
  attach(workspaceId: string, host: E, mounter: ViewMounter<E>): IDisposable;
}
export const DockSurfaceHost: Token<DockSurfaceHost> = token<DockSurfaceHost>('tessera.dockSurfaceHost');

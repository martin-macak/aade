import { toDisposable, type IDisposable } from '@tessera/base';
import type { DockSurfaceFactory, DockSurfaceHost, ViewMounter } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { DockviewSurface } from './surface.ts';

export interface DockviewSurfaceFactoryOptions {
  /** The window DI scope. */
  readonly services: ScopeReader;
}

/** Both the factory the workbench calls and the host port the renderer calls (see DockSurfaceHost in contracts). */
export interface DockviewSurfaceFactory extends DockSurfaceFactory, DockSurfaceHost<HTMLElement> {
  /** The surface of a workspace, once the workbench created it. */
  surface(workspaceId: string): DockviewSurface | undefined;
}

/**
 * Creates dockview-backed dock surfaces. The workbench asks for a surface per dock workspace and mounts it without a host;
 * the renderer later calls `attach(workspaceId, element, mounter)`, which draws the dock into the element.
 */
export function dockviewSurfaceFactory(options: DockviewSurfaceFactoryOptions): DockviewSurfaceFactory {
  const surfaces = new Map<string, DockviewSurface>();
  const attachments = new Map<string, { host: HTMLElement; mounter: ViewMounter<HTMLElement> }>();
  return {
    create(workspaceId) {
      const surface = new DockviewSurface({ services: options.services });
      surfaces.set(workspaceId, surface);
      // a renderer that attached before the workbench created the surface
      const waiting = attachments.get(workspaceId);
      if (waiting) queueMicrotask(() => surface.attach(waiting.host, waiting.mounter));
      return surface;
    },
    attach(workspaceId, host, mounter): IDisposable {
      const surface = surfaces.get(workspaceId);
      if (!surface) {
        attachments.set(workspaceId, { host, mounter });
        return toDisposable(() => void attachments.delete(workspaceId));
      }
      return surface.attach(host, mounter);
    },
    surface: (workspaceId) => surfaces.get(workspaceId),
  };
}

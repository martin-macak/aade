import { reportError } from '@tessera/base';
import {
  CommandService,
  ViewRegistry,
  ViewServicesPolicy,
  WorkbenchAdapterApi,
  WorkbenchService,
  type MountTarget,
  type Placement,
  type PlacementId,
  type ViewContext,
} from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';

/**
 * The ViewContext of one placement (contracts.md 18.1). Commands run with source 'view' in the placement's context-key
 * scope. Errors are reported with source 'view' and the plugin that owns the view type.
 */
export function createViewContext(services: ScopeReader, placement: Placement): ViewContext {
  const owner = (): string | undefined => services.get(ViewRegistry, { optional: true })?.descriptor(placement.viewType)?.owner;
  // The view door of the plugin gate: a plugin-owned view gets the plugin's gated reader and context facade; chrome (owner core) the raw scopes.
  const viewOwner = owner();
  const policy = viewOwner !== undefined && viewOwner !== 'core' ? services.get(ViewServicesPolicy, { optional: true }) : undefined;
  const rawServices = placement.scope ?? services;
  return {
    placement: { id: placement.id, viewType: placement.viewType, instanceId: placement.instanceId, workspaceId: placement.workspaceId, windowId: placement.windowId },
    contextKeys: policy && viewOwner !== undefined ? policy.contextFor(viewOwner, placement.context) : placement.context,
    services: policy && viewOwner !== undefined ? policy.readerFor(viewOwner, rawServices) : rawServices,
    executeCommand: <R = unknown>(id: string, args?: unknown): Promise<R> =>
      services.get(CommandService).execute<R>(id, args, { source: 'view', placementId: placement.id, context: placement.context }),
    reportError(error) {
      const pluginId = owner();
      reportError(error, { source: 'view', target: placement.viewType, ...(pluginId && pluginId !== 'core' ? { pluginId } : {}) });
    },
  };
}

/**
 * Builds the MountTarget of a placement: the placement, its presenter (created if needed) and its ViewContext.
 * undefined when the placement is gone or is a placeholder (no presenter, and the owning plugin is not woken up). Renderer-independent, so every DOM adapter
 * and the dock surface share it.
 */
export async function resolveMountTarget(services: ScopeReader, id: PlacementId): Promise<MountTarget | undefined> {
  const placement = services.get(WorkbenchService).placement(id);
  if (!placement) return undefined;
  // a placeholder stays one: asking for its presenter would load the owning plugin again (a deactivation must hold)
  if (placement.status.peek() === 'placeholder') return undefined;
  const presenter = await services.get(WorkbenchAdapterApi).ensurePresenter(id);
  if (!presenter) return undefined;
  return { placement, presenter, context: createViewContext(services, placement) };
}

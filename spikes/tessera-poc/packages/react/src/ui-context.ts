import { useMemo } from 'react';
import type { PlacementId, ViewContext } from '@tessera/contracts';
import { useViewContext as useFullViewContext } from './contexts.ts';

/**
 * What a plugin view component may read of its placement: who it is and how to report an error. No services and no command execution:
 * a view asks for work through the intents of its presenter (MVP), so the plugin gate and the presenter stay the one door.
 */
export interface ViewUiContext {
  readonly placementId: PlacementId;
  readonly viewType: string;
  reportError(error: unknown): void;
}

/** Narrows the full ViewContext (chrome and host internals) to what a plugin view may see. */
export function toViewUiContext(full: ViewContext): ViewUiContext {
  return { placementId: full.placement.id, viewType: full.placement.viewType, reportError: (error: unknown) => full.reportError(error) };
}

/** The read-only context of the enclosing placement. Throws outside a view. */
export function useViewContext(): ViewUiContext {
  const full = useFullViewContext();
  return useMemo(() => toViewUiContext(full), [full]);
}

import type { DockArrangement, PlacementId } from '@tessera/contracts';
import type { SerializedDockview } from './dockview.ts';

export const DOCKVIEW_ENGINE = 'dockview';
/** major.minor of dockview-core that wrote the blob (contracts.md 15.9). */
export const DOCKVIEW_ENGINE_VERSION = '8.8';

/** The one component key of every panel: unknown view types still restore, as placeholders (contracts.md 15.9 rule 7). */
export const PLACEMENT_COMPONENT = 'tessera.placement';
export const TAB_COMPONENT = 'tessera.tab';

export function wrapArrangement(data: SerializedDockview): DockArrangement {
  return { engine: DOCKVIEW_ENGINE, engineVersion: DOCKVIEW_ENGINE_VERSION, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A structural check of the dockview JSON. It does not trust a blob from storage: dockview would throw on garbage. */
export function isSerializedDockview(value: unknown): value is SerializedDockview {
  if (!isRecord(value) || !isRecord(value['grid']) || !isRecord(value['panels'])) return false;
  const grid = value['grid'];
  return isRecord(grid['root']) && typeof grid['width'] === 'number' && typeof grid['height'] === 'number';
}

export type ArrangementCheck = { readonly ok: true; readonly data: SerializedDockview } | { readonly ok: false; readonly reason: string };

/**
 * Arrangement migration. A blob of another engine, another major version or a broken shape is rejected, and the surface
 * rebuilds a default grid from the members. A blob of an older minor version of the same major is accepted as it is: so far
 * dockview 8.x reads its own older 8.x layouts. A later minor that breaks a layout adds a step here (with a fixture).
 */
export function checkArrangement(arrangement: DockArrangement): ArrangementCheck {
  if (arrangement.engine !== DOCKVIEW_ENGINE) return { ok: false, reason: `engine "${arrangement.engine}" is not "${DOCKVIEW_ENGINE}"` };
  const major = (v: string): string => v.split('.')[0] ?? '';
  if (major(arrangement.engineVersion) !== major(DOCKVIEW_ENGINE_VERSION)) return { ok: false, reason: `engine version ${arrangement.engineVersion} is not ${DOCKVIEW_ENGINE_VERSION}.x` };
  if (!isSerializedDockview(arrangement.data)) return { ok: false, reason: 'the dockview JSON has an unknown shape' };
  return { ok: true, data: arrangement.data };
}

/** Panel ids of a blob. */
export function panelIdsOf(data: SerializedDockview): PlacementId[] {
  return Object.keys(data.panels) as PlacementId[];
}

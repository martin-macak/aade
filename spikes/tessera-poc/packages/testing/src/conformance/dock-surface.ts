import { afterEach, describe, expect, it } from 'vitest';
import type { DockChange, DockDesired, DockSurface, PlacementId, ViewMounter, WorkbenchAdapterApi } from '@tessera/contracts';

export interface DockSurfaceHarness {
  readonly surface: DockSurface;
  /** The host element the renderer would give (anything for a surface without DOM). */
  readonly host: unknown;
  readonly mounter: ViewMounter;
  /** The ids of the panels the surface shows now. */
  panelIds(): readonly PlacementId[] | Promise<readonly PlacementId[]>;
  dispose?(): void;
}

const id = (n: number | string): PlacementId => `p-${n}` as PlacementId;

function desired(revision: number, ids: readonly (number | string)[], active?: number | string): DockDesired {
  return { revision, members: ids.map((i) => ({ id: id(i), title: `Tab ${i}`, position: undefined, where: 'grid' as const })), active: active === undefined ? undefined : id(active) };
}

/**
 * Conformance suite for the DockSurface port (contracts.md 15.9). Run it against the fake surface and against the
 * dockview surface. A new docking engine proves itself by passing it.
 */
export function dockSurfaceConformance(name: string, create: () => DockSurfaceHarness | Promise<DockSurfaceHarness>): void {
  describe(`C21: DockSurface conformance: ${name}`, () => {
    const live: DockSurfaceHarness[] = [];
    afterEach(() => {
      for (const h of live.splice(0)) {
        h.surface.dispose();
        h.dispose?.();
      }
    });

    async function make(): Promise<{ h: DockSurfaceHarness; visible: Map<PlacementId, boolean>; changes: DockChange[] }> {
      const h = await create();
      live.push(h);
      const visible = new Map<PlacementId, boolean>();
      const changes: DockChange[] = [];
      const adapter: WorkbenchAdapterApi = {
        reportVisible: (pid, v) => void visible.set(pid, v),
        reportFocus: () => undefined,
        reportDockChange: () => undefined,
        requestClose: () => undefined,
        ensurePresenter: async () => undefined,
      };
      h.surface.onDidChange((c) => changes.push(c));
      h.surface.mount(h.host, { mounter: h.mounter, adapter, workspaceId: 'workbench.editorArea' });
      return { h, visible, changes };
    }
    const sorted = async (h: DockSurfaceHarness): Promise<string[]> => [...(await h.panelIds())].sort();

    it('C21: apply creates one panel per member, with the placement id as panel id', async () => {
      const { h } = await make();
      await h.surface.apply(desired(1, [1, 2, 3], 2));
      expect(await sorted(h)).toEqual([id(1), id(2), id(3)]);
    });

    it('C21: apply removes panels that are no longer members and adds new ones (membership follows the model)', async () => {
      const { h } = await make();
      await h.surface.apply(desired(1, [1, 2, 3], 1));
      await h.surface.apply(desired(2, [2, 4], 4));
      expect(await sorted(h)).toEqual([id(2), id(4)]);
    });

    it('C21: apply is idempotent: the same desired state twice changes nothing', async () => {
      const { h } = await make();
      await h.surface.apply(desired(1, [1, 2], 1));
      const first = await sorted(h);
      await h.surface.apply(desired(1, [1, 2], 1));
      expect(await sorted(h)).toEqual(first);
    });

    it('C21: every change event raised by apply() has origin "model" (adapters drop those)', async () => {
      const { h, changes } = await make();
      await h.surface.apply(desired(1, [1, 2], 1));
      await h.surface.apply(desired(2, [1, 2, 3], 3));
      expect(changes.every((c) => c.origin === 'model')).toBe(true);
    });

    it('C21: the surface reports visibility of its panels through the adapter, at least for the active panel', async () => {
      const { h, visible } = await make();
      await h.surface.apply(desired(1, [1, 2], 2));
      expect(visible.get(id(2))).toBe(true);
    });

    it('C21: snapshot returns a wrapped arrangement with engine and engineVersion', async () => {
      const { h } = await make();
      await h.surface.apply(desired(1, [1, 2], 1));
      const arrangement = h.surface.snapshot();
      expect(arrangement.engine).toBe(h.surface.engine.id);
      expect(typeof arrangement.engineVersion).toBe('string');
      expect(JSON.parse(JSON.stringify(arrangement))).toEqual(JSON.parse(JSON.stringify(arrangement))); // JSON-safe
    });

    it('C21: restore of a snapshot into a new surface brings back the same panels', async () => {
      const first = await make();
      await first.h.surface.apply(desired(1, [1, 2, 3], 2));
      const arrangement = JSON.parse(JSON.stringify(first.h.surface.snapshot())) as ReturnType<DockSurface['snapshot']>;
      const second = await make();
      const report = await second.h.surface.restore(arrangement, new Set([id(1), id(2), id(3)]));
      expect(report.rebuilt).toBe(false);
      expect(await sorted(second.h)).toEqual([id(1), id(2), id(3)]);
    });

    it('C21: restore drops panels that the core does not know and keeps the known ones', async () => {
      const first = await make();
      await first.h.surface.apply(desired(1, [1, 2, 3]));
      const arrangement = first.h.surface.snapshot();
      const second = await make();
      const report = await second.h.surface.restore(arrangement, new Set([id(1), id(3)]));
      expect(await sorted(second.h)).toEqual([id(1), id(3)]);
      expect(report.dropped).toEqual([id(2)]);
    });

    it('C21: a rejected (garbage) arrangement is rebuilt from the known members as a default grid, with rebuilt true', async () => {
      const { h } = await make();
      const report = await h.surface.restore({ engine: h.surface.engine.id, engineVersion: '0.0', data: { nonsense: true } }, new Set([id(1), id(2)]));
      expect(report.rebuilt).toBe(true);
      expect(await sorted(h)).toEqual([id(1), id(2)]);
    });
  });
}

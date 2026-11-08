import { reportError } from '@tessera/base';
import type { DockDesired, DockPosition, DockSurface, PlacementId } from '@tessera/contracts';

/**
 * Binds one DockSurface to one dock workspace. `sync` coalesces: while an apply runs, further requests mark the
 * binding dirty and one more apply with the latest model follows (contracts.md 15.9: the model is the judge).
 */
export class DockBinding {
  readonly surface: DockSurface;
  readonly workspaceId: string;
  /** Positions the surface must honor on the next apply (new members, or an explicit API move). */
  readonly positions: Map<PlacementId, DockPosition> = new Map<PlacementId, DockPosition>();
  /** Count of apply() calls, for tests and diagnostics. */
  applies: number = 0;

  #running: Promise<void> | undefined;
  #dirty = false;

  constructor(surface: DockSurface, workspaceId: string) {
    this.surface = surface;
    this.workspaceId = workspaceId;
  }

  sync(build: () => DockDesired): Promise<void> {
    this.#dirty = true;
    this.#running ??= (async () => {
      try {
        while (this.#dirty) {
          this.#dirty = false;
          this.applies++;
          await this.surface.apply(build());
        }
      } catch (error) {
        reportError(error, { source: 'unknown', target: `dock:${this.workspaceId}` });
      } finally {
        this.#running = undefined;
      }
    })();
    return this.#running;
  }

  /** Resolves when no apply is running or queued. */
  idle(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }
}

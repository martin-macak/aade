import type { IDisposable } from '@tessera/base';
import type { Observable } from '@tessera/reactive';

/**
 * Schedules a layout save when the state of a view changes: the `local` state of a placement (scroll position, selection) and the
 * `shared` state of a view instance. Structural changes (open, move, close) schedule their own saves; an edit of view state did not,
 * so a crash after a scroll lost it. The service only attaches a watch when it builds a placement and disposes it with the placement's scope.
 */
export class PlacementStateAutosave {
  readonly #scheduleSave: () => void;

  constructor(scheduleSave: () => void) {
    this.#scheduleSave = scheduleSave;
  }

  /** Calls scheduleSave on every change of `source` (not for its current value). */
  watch(source: Observable<unknown>): IDisposable {
    return source.subscribe(() => this.#scheduleSave());
  }
}

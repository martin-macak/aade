import { toDisposable } from '@tessera/base';
import type { PlacementId, SelectionPublisher, SelectionService, SelectionType } from '@tessera/contracts';
import { computed, state, type Observable, type State } from '@tessera/reactive';

/** Typed selection (NetBeans Lookup idea, contracts.md 15.10). Window DI scope. */
export class DefaultSelectionService implements SelectionService {
  readonly #items = new Map<string, State<readonly unknown[]>>();
  readonly #focused: Observable<PlacementId | undefined>;
  /** type id -> the last focused placement that published something of that type */
  readonly #lastWith = new Map<string, PlacementId>();
  readonly #version: State<number> = state(0, { name: 'selection.version' });

  constructor(focused: Observable<PlacementId | undefined>) {
    this.#focused = focused;
  }

  #cell(placement: PlacementId, typeId: string): State<readonly unknown[]> {
    const key = `${placement}\u0000${typeId}`;
    let cell = this.#items.get(key);
    if (!cell) {
      cell = state<readonly unknown[]>([], { name: `selection:${typeId}` });
      this.#items.set(key, cell);
    }
    return cell;
  }

  /** The publisher given to the presenter of one placement. */
  publisherFor(placement: PlacementId): SelectionPublisher & { dispose(): void } {
    return {
      set: <T>(type: SelectionType<T>, items: readonly T[]) => {
        this.#cell(placement, type.id).set(Object.freeze([...items]));
        if (items.length > 0 && this.#focused.peek() === placement) this.#lastWith.set(type.id, placement);
        this.#version.update((n) => n + 1);
      },
      clear: (type) => {
        for (const [key, cell] of this.#items) {
          const [owner, typeId] = key.split('\u0000');
          if (owner === placement && (type === undefined || type.id === typeId)) cell.set([]);
        }
        this.#version.update((n) => n + 1);
      },
      dispose: () => {
        for (const [key, cell] of [...this.#items]) {
          const [owner, typeId] = key.split('\u0000');
          if (owner !== placement) continue;
          cell.set([]);
          this.#items.delete(key);
          if (this.#lastWith.get(typeId as string) === placement) this.#lastWith.delete(typeId as string);
        }
        this.#version.update((n) => n + 1);
      },
    };
  }

  of<T>(type: SelectionType<T>): Observable<readonly T[]> {
    return computed(() => {
      this.#version.get();
      const focused = this.#focused.get();
      const own = focused === undefined ? undefined : this.#items.get(`${focused}\u0000${type.id}`)?.get();
      if (own && own.length > 0) return own as readonly T[];
      const last = this.#lastWith.get(type.id);
      const fallback = last === undefined ? undefined : this.#items.get(`${last}\u0000${type.id}`)?.get();
      return (fallback ?? []) as readonly T[];
    }, { name: `selection.of:${type.id}` });
  }

  inPlacement<T>(id: PlacementId, type: SelectionType<T>): Observable<readonly T[]> {
    return computed(() => {
      this.#version.get();
      return (this.#items.get(`${id}\u0000${type.id}`)?.get() ?? []) as readonly T[];
    }, { name: `selection.in:${type.id}` });
  }

  /** Called when the focus moves: remember which placement published the type last. */
  noteFocus(placement: PlacementId | undefined): void {
    if (placement === undefined) return;
    for (const key of this.#items.keys()) {
      const [owner, typeId] = key.split('\u0000');
      if (owner === placement && (this.#items.get(key)?.peek().length ?? 0) > 0) this.#lastWith.set(typeId as string, placement);
    }
    this.#version.update((n) => n + 1);
  }

  dispose(): void {
    this.#items.clear();
    this.#lastWith.clear();
  }
}

export { toDisposable };

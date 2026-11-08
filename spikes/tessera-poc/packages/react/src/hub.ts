import type { MountTarget } from '@tessera/contracts';

/** One view that the ViewMounter has mounted into a host element. */
export interface MountedView {
  readonly key: number;
  readonly host: HTMLElement;
  readonly target: MountTarget;
}

/**
 * The list of mounted views as a tiny external store. ViewMounter.mount() writes it; the portal component reads it
 * with one useSyncExternalStore. It is a plain store on purpose: it adds nothing to reactiveDebug.liveSubscriptions(),
 * so that count shows exactly one subscription per mounted placement (contracts.md 18.2 rule 1).
 */
export class ViewHub {
  /** true once a WorkbenchRenderer root renders the portals. Without it the mounter makes its own fallback root. */
  external: boolean = false;
  #entries: readonly MountedView[] = [];
  readonly #listeners = new Set<() => void>();
  #seq = 0;

  readonly subscribe: (listener: () => void) => () => void = (listener) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly getSnapshot: () => readonly MountedView[] = () => this.#entries;

  get size(): number {
    return this.#entries.length;
  }

  add(host: HTMLElement, target: MountTarget): number {
    const key = ++this.#seq;
    this.#entries = [...this.#entries, { key, host, target }];
    this.#emit();
    return key;
  }

  remove(key: number): void {
    const next = this.#entries.filter((e) => e.key !== key);
    if (next.length === this.#entries.length) return;
    this.#entries = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

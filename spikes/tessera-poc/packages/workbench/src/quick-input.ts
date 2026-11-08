import { DeferredPromise, reportError, type IDisposable } from '@tessera/base';
import {
  CommandService,
  ContextKeyService,
  MenuId,
  MenuService,
  QUICK_PICK_VISIBLE_CAP,
  type QuickInputService,
  type QuickPickItem,
  type QuickPickOptions,
  type QuickPickSession,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { computed, state, type Observable, type State } from '@tessera/reactive';

/** 0: the label starts with the text. 1: a word of the label starts with it. 2: the label contains it. 3: the description contains it. undefined: no match. */
function rankOf(item: QuickPickItem, label: string, needle: string, matchOnDescription: boolean): number | undefined {
  if (label.startsWith(needle)) return 0;
  if (label.split(/[\s.\-_/:]+/).some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  if (matchOnDescription && (item.description ?? '').toLowerCase().includes(needle)) return 3;
  return undefined;
}

class Session implements QuickPickSession {
  readonly placeholder: string | undefined;
  readonly filter: State<string> = state('', { name: 'quickPick.filter' });
  readonly visibleItems: Observable<readonly QuickPickItem[]>;
  readonly activeIndex: Observable<number>;
  readonly result = new DeferredPromise<QuickPickItem | undefined>();
  readonly items: readonly QuickPickItem[];
  /** The lower-case label of every item, computed once: a keystroke ranks the whole array without lower-casing each label again. */
  readonly #labels: readonly string[];
  /** The row the user moved to, and the filter text it belongs to: a new filter text puts the highlight back on row 0. */
  readonly #active: State<{ readonly index: number; readonly filter: string }> = state({ index: 0, filter: '' }, { name: 'quickPick.active' });

  constructor(items: readonly QuickPickItem[], options: QuickPickOptions | undefined) {
    this.items = items;
    this.#labels = items.map((item) => item.label.toLowerCase());
    this.placeholder = options?.placeholder;
    const matchOnDescription = options?.matchOnDescription === true;
    this.visibleItems = computed(() => {
      const needle = this.filter.get().trim().toLowerCase();
      if (needle === '') return this.items.slice(0, QUICK_PICK_VISIBLE_CAP);
      const ranked: Array<{ readonly item: QuickPickItem; readonly rank: number; readonly order: number }> = [];
      this.items.forEach((item, order) => {
        const rank = rankOf(item, this.#labels[order] as string, needle, matchOnDescription);
        if (rank !== undefined) ranked.push({ item, rank, order });
      });
      ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
      return ranked.slice(0, QUICK_PICK_VISIBLE_CAP).map((r) => r.item);
    }, { name: 'quickPick.visible' });
    this.activeIndex = computed(() => {
      const last = Math.max(0, this.visibleItems.get().length - 1);
      const active = this.#active.get();
      return active.filter === this.filter.get() ? Math.min(Math.max(active.index, 0), last) : 0;
    }, { name: 'quickPick.activeIndex' });
  }

  setActive(index: number): void {
    this.#active.set({ index, filter: this.filter.peek() });
  }

  moveActive(delta: number): void {
    this.setActive(this.activeIndex.peek() + delta);
  }

  acceptActive(): void {
    const item = this.visibleItems.peek()[this.activeIndex.peek()];
    if (item) this.accept(item);
  }

  accept(item: QuickPickItem | undefined): void {
    this.result.resolve(item);
  }
}

/** One picker at a time; the command palette is the `commandPalette` menu in the focused context. Window DI scope. */
export class DefaultQuickInputService implements QuickInputService, IDisposable {
  readonly current: Observable<QuickPickSession | undefined>;
  readonly #current: State<QuickPickSession | undefined> = state<QuickPickSession | undefined>(undefined, { name: 'quickInput.current' });
  readonly #scope: Scope;

  constructor() {
    this.#scope = injectScope();
    this.current = this.#current.asReadonly();
  }

  async pick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined> {
    this.#current.peek()?.accept(undefined); // a new picker cancels the old one
    const session = new Session(items, options);
    this.#current.set(session);
    const abort = (): void => session.accept(undefined);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    try {
      return (await session.result.promise) as T | undefined;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      if (this.#current.peek() === session) this.#current.set(undefined);
    }
  }

  async showCommandPalette(): Promise<void> {
    const context = this.#scope.get(ContextKeyService).focused.peek();
    const menu = this.#scope.get(MenuService).createMenu(MenuId.CommandPalette, context);
    try {
      const entries = menu.groups.peek().flatMap((g) => g.items).filter((i) => i.command !== undefined);
      const picked = await this.pick(
        entries.map((i) => ({ id: i.id, label: i.presentation.title, ...(i.presentation.category ? { description: i.presentation.category } : {}), ...(i.presentation.keybinding ? { detail: i.presentation.keybinding } : {}) })),
        { placeholder: 'Type a command', matchOnDescription: true },
      );
      const item = entries.find((e) => e.id === picked?.id);
      if (item?.command) {
        try {
          await this.#scope.get(CommandService).execute(item.command, item.args, { source: 'palette', context });
        } catch (error) {
          reportError(error, { source: 'command', target: item.command });
        }
      }
    } finally {
      menu.dispose();
    }
  }

  dispose(): void {
    this.#current.peek()?.accept(undefined);
  }
}

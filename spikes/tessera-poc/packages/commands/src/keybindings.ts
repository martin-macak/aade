import { Emitter, getScheduler, toDisposable, type Event, type IDisposable } from '@tessera/base';
import {
  CommandService,
  ContextKeyService,
  HostEnvironment,
  type ContextKeyScope,
  type ContextReader,
  type DispatchResult,
  type KeyPress,
  type KeybindingConflict,
  type KeybindingRule,
  type KeybindingService,
  type KeybindingSource,
  type ResolvedKeybinding,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { computed, state, type Observable, type State } from '@tessera/reactive';

export const CHORD_TIMEOUT_MS = 1000;

type Platform = 'mac' | 'win' | 'linux' | 'web';

interface Part {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly key: string;
}

interface Entry {
  readonly rule: KeybindingRule;
  readonly sequence: readonly Part[];
  readonly seq: number;
  readonly whenKeys: ReadonlySet<string>;
}

const SOURCE_RANK: Readonly<Record<KeybindingSource, number>> = { user: 2, plugin: 1, core: 0 };

/** 'mod+k mod+t' to parts. mod is meta on mac and ctrl elsewhere. cmd is meta. */
export function parseKeySequence(text: string, platform: Platform): Part[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const pieces = chunk.toLowerCase().split('+');
      const key = normalizeKeyName(pieces.pop() ?? '');
      let ctrl = false;
      let shift = false;
      let alt = false;
      let meta = false;
      for (const modifier of pieces) {
        if (modifier === 'ctrl' || modifier === 'control') ctrl = true;
        else if (modifier === 'shift') shift = true;
        else if (modifier === 'alt' || modifier === 'option') alt = true;
        else if (modifier === 'meta' || modifier === 'cmd' || modifier === 'win' || modifier === 'super') meta = true;
        else if (modifier === 'mod') {
          if (platform === 'mac') meta = true;
          else ctrl = true;
        }
      }
      return { ctrl, shift, alt, meta, key };
    });
}

/** KeyboardEvent.code without the Key and Digit prefixes, lower case: KeyK to k, Digit1 to 1, ArrowUp to arrowup. */
export function normalizeKeyName(code: string): string {
  const lower = code.toLowerCase();
  if (/^key[a-z]$/.test(lower)) return lower.slice(3);
  if (/^digit\d$/.test(lower)) return lower.slice(5);
  return lower;
}

function pressToPart(press: KeyPress): Part {
  return { ctrl: press.ctrl, shift: press.shift, alt: press.alt, meta: press.meta, key: normalizeKeyName(press.code) };
}

function samePart(a: Part, b: Part): boolean {
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta && a.key === b.key;
}

function startsWith(sequence: readonly Part[], prefix: readonly Part[]): boolean {
  return prefix.length <= sequence.length && prefix.every((p, i) => samePart(p, sequence[i] as Part));
}

function label(parts: readonly Part[], platform: Platform): string {
  return parts
    .map((p) => {
      const names: string[] = [];
      if (p.ctrl) names.push('Ctrl');
      if (p.shift) names.push('Shift');
      if (p.alt) names.push('Alt');
      if (p.meta) names.push(platform === 'mac' ? 'Cmd' : platform === 'win' ? 'Win' : 'Meta');
      names.push(p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1));
      return names.join('+');
    })
    .join(' ');
}

function compareEntries(a: Entry, b: Entry): number {
  return (
    SOURCE_RANK[b.rule.source] - SOURCE_RANK[a.rule.source] ||
    (b.rule.when !== undefined ? 1 : 0) - (a.rule.when !== undefined ? 1 : 0) ||
    b.seq - a.seq
  );
}

export class DefaultKeybindingService implements KeybindingService {
  readonly #scope: Scope;
  readonly #platform: Platform;
  readonly #entries: State<readonly Entry[]> = state<readonly Entry[]>([], { name: 'keybindings.entries' });
  readonly #chord: State<string | undefined> = state<string | undefined>(undefined, { name: 'keybindings.chord' });
  readonly #changed = new Emitter<void>({ name: 'keybindings.change', deferInTransaction: false });
  /** Active entries by command id: rebuilt when the entries change, read in O(bucket) by lookup() (the palette asks once per command). */
  readonly #byCommand: Observable<ReadonlyMap<string, readonly Entry[]>>;
  #indexBuilds = 0;
  #seq = 0;
  #pending: Part[] = [];
  #pendingContext: ContextKeyScope | undefined;
  #pendingExact: Entry | undefined;
  #timer: IDisposable | undefined;

  readonly chord: Observable<string | undefined>;
  readonly conflicts: Observable<readonly KeybindingConflict[]>;

  constructor() {
    this.#scope = injectScope();
    this.#platform = this.#scope.get(HostEnvironment).platform;
    this.chord = this.#chord.asReadonly();
    this.#byCommand = computed(
      () => {
        this.#indexBuilds++;
        const index = new Map<string, Entry[]>();
        for (const entry of this.#active(this.#entries.get())) {
          const bucket = index.get(entry.rule.command);
          if (bucket) bucket.push(entry);
          else index.set(entry.rule.command, [entry]);
        }
        return index;
      },
      { name: 'keybindings.byCommand' },
    );
    this.conflicts = computed(() => this.#computeConflicts(), {
      name: 'keybindings.conflicts',
      equals: (a, b) => a.length === b.length && a.every((c, i) => c.key === b[i]?.key && c.rules.length === b[i]?.rules.length),
    });
  }

  /** Bumps when rules change. Presentation computeds depend on it to refresh key labels. */
  get version(): Observable<readonly Entry[]> {
    return this.#entries.asReadonly();
  }

  get onDidChange(): Event<void> {
    return this.#changed.event;
  }

  register(rule: KeybindingRule): IDisposable {
    const keyText = (this.#platform === 'mac' ? rule.mac : this.#platform === 'win' ? rule.win : this.#platform === 'linux' ? rule.linux : undefined) ?? rule.key;
    const expression = rule.when !== undefined ? this.#scope.get(ContextKeyService).parse(rule.when) : undefined;
    const entry: Entry = { rule, sequence: parseKeySequence(keyText, this.#platform), seq: this.#seq++, whenKeys: expression?.keys ?? new Set() };
    this.#entries.update((list) => [...list, entry]);
    this.#changed.fire();
    return toDisposable(() => {
      this.#entries.update((list) => list.filter((e) => e !== entry));
      this.#changed.fire();
    });
  }

  /** Rules in force: negative user rules ('-command') remove matching lower-source rules. */
  #active(entries: readonly Entry[]): Entry[] {
    const negatives = entries.filter((e) => e.rule.command.startsWith('-'));
    return entries.filter((e) => {
      if (e.rule.command.startsWith('-')) return false;
      return !negatives.some(
        (n) =>
          SOURCE_RANK[n.rule.source] > SOURCE_RANK[e.rule.source] &&
          n.rule.command === `-${e.rule.command}` &&
          n.sequence.length === e.sequence.length &&
          n.sequence.every((p, i) => samePart(p, e.sequence[i] as Part)),
      );
    });
  }

  #allowedInInput(entry: Entry, part: Part, context: ContextReader): boolean {
    if (context.getValue('inputFocus') !== true) return true;
    return entry.whenKeys.has('inputFocus') || part.ctrl || part.alt || part.meta;
  }

  #matches(entry: Entry, context: ContextKeyScope): boolean {
    return entry.rule.when === undefined || context.evaluate(entry.rule.when);
  }

  dispatch(press: KeyPress, context: ContextKeyScope): DispatchResult {
    const part = pressToPart(press);
    const sequence = [...this.#pending, part];
    const candidates = this.#active(this.#entries.peek()).filter(
      (e) => startsWith(e.sequence, sequence) && this.#matches(e, context) && this.#allowedInInput(e, part, context),
    );
    const exact = candidates.filter((e) => e.sequence.length === sequence.length).toSorted(compareEntries)[0];
    const hasLonger = candidates.some((e) => e.sequence.length > sequence.length);
    this.#cancelTimer();

    if (hasLonger) {
      // Wait for the next part. An exact match that is also a prefix runs when the timeout ends.
      this.#pending = sequence;
      this.#pendingContext = context;
      this.#pendingExact = exact;
      const text = label(sequence, this.#platform);
      this.#chord.set(text);
      this.#timer = getScheduler().timeout(() => this.#chordTimeout(), CHORD_TIMEOUT_MS);
      return { kind: 'chord', prefix: text };
    }
    this.#resetChord();
    if (!exact) return { kind: 'unhandled' };
    this.#run(exact, context);
    return { kind: 'handled', commandId: exact.rule.command };
  }

  #chordTimeout(): void {
    const exact = this.#pendingExact;
    const context = this.#pendingContext;
    this.#timer = undefined;
    this.#resetChord();
    if (exact && context) this.#run(exact, context);
  }

  #cancelTimer(): void {
    this.#timer?.dispose();
    this.#timer = undefined;
  }

  #resetChord(): void {
    this.#cancelTimer();
    this.#pending = [];
    this.#pendingContext = undefined;
    this.#pendingExact = undefined;
    this.#chord.set(undefined);
  }

  #run(entry: Entry, context: ContextKeyScope): void {
    const commands = this.#scope.get(CommandService);
    // The command service reports and rethrows failures; a keybinding has nobody to tell, so the rejection ends here.
    commands.execute(entry.rule.command, entry.rule.args, { source: 'keybinding', context }).catch(() => {});
  }

  lookup(commandId: string, context?: ContextReader): readonly ResolvedKeybinding[] {
    return (this.#byCommand.get().get(commandId) ?? [])
      .filter((e) => (context === undefined || e.rule.when === undefined || this.#scope.get(ContextKeyService).parse(e.rule.when).evaluate(context)))
      .toSorted(compareEntries)
      .map((e) => ({ rule: e.rule, label: label(e.sequence, this.#platform) }));
  }

  #computeConflicts(): readonly KeybindingConflict[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.#active(this.#entries.get())) {
      const key = `${label(entry.sequence, this.#platform)}|${entry.rule.source}|${entry.rule.when ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    const out: KeybindingConflict[] = [];
    for (const list of groups.values()) {
      if (new Set(list.map((e) => e.rule.command)).size > 1) {
        out.push({ key: label((list[0] as Entry).sequence, this.#platform), rules: list.map((e) => e.rule) });
      }
    }
    return out;
  }

  /** Dev report: how often the by-command index was rebuilt (it must not grow with the number of lookups). */
  get indexBuilds(): number {
    return this.#indexBuilds;
  }

  dispose(): void {
    this.#cancelTimer();
    this.#changed.dispose();
  }
}

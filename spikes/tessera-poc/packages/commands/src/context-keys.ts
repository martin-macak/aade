import { DisposableStore, Emitter, Event, toDisposable, transactionGate, type IDisposable } from '@tessera/base';
import {
  WhenSyntaxError,
  type ContextChange,
  type ContextKey,
  type ContextKeyScope,
  type ContextKeyService,
  type ContextKeyValue,
  type ContextValue,
  type WhenExpr,
} from '@tessera/contracts';
import { computed, state, type Observable, type State } from '@tessera/reactive';
import { parseWhen } from './when.ts';

const UNSET: unique symbol = Symbol('unset');
type Slot = ContextValue | typeof UNSET;

function sameSlot(a: Slot, b: Slot): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = a as readonly string[];
    const y = b as readonly string[];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return Object.is(a, b);
}

class ChangeImpl implements ContextChange {
  readonly keys: ReadonlySet<string>;
  constructor(keys: ReadonlySet<string>) {
    this.keys = keys;
  }
  affects(keys: ReadonlySet<string>): boolean {
    for (const key of keys) if (this.keys.has(key)) return true;
    return false;
  }
}

/**
 * One node of the context-key tree. Values live in reactive State cells, one per key and scope, created on first
 * read or write. A read walks the chain and reads the cell of every scope on the way, so a computed that reads a key
 * depends on that key in this scope and in all ancestors, also when it is not defined anywhere yet.
 */
export class ContextKeyScopeImpl implements ContextKeyScope {
  readonly id: string;
  readonly parent: ContextKeyScope | undefined;
  readonly #parentImpl: ContextKeyScopeImpl | undefined;
  readonly #parse: (source: string) => WhenExpr;
  readonly #cells = new Map<string, State<Slot>>();
  readonly #children = new Set<ContextKeyScopeImpl>();
  readonly #changed = new Emitter<ContextChange>({ name: 'contextKeys.change', deferInTransaction: false });
  readonly #pending = new Set<string>();
  readonly #listeners = new DisposableStore('contextKeys.listeners');
  #buffering = 0;
  #disposed = false;
  readonly onDidChange: Event<ContextChange>;

  constructor(id: string, parent: ContextKeyScopeImpl | undefined, parse: (source: string) => WhenExpr) {
    this.id = id;
    this.parent = parent;
    this.#parentImpl = parent;
    this.#parse = parse;
    if (parent) parent.#children.add(this);
    // A listener on a scope also hears changes made in its ancestors: they change what this scope reads.
    const base: Event<ContextChange> = parent ? Event.any(this.#changed.event, parent.onDidChange) : this.#changed.event;
    // Listeners end with the scope, also the ones attached to an ancestor through Event.any.
    this.onDidChange = (listener, options) => {
      if (this.#disposed) return toDisposable(() => {});
      const inner = base(listener, options);
      const handle: IDisposable = toDisposable(() => {
        this.#listeners.release(handle);
        inner.dispose();
      });
      return this.#listeners.add(handle);
    };
  }

  #cell(name: string): State<Slot> {
    let cell = this.#cells.get(name);
    if (!cell) {
      cell = state<Slot>(UNSET, { name: `context:${this.id}:${name}`, equals: sameSlot });
      this.#cells.set(name, cell);
    }
    return cell;
  }

  getValue(name: string): ContextValue {
    for (const scope of this.#lineage()) {
      const slot = scope.#cell(name).get();
      if (slot !== UNSET) return slot;
    }
    return undefined;
  }

  /** This scope, then its parent, up to the root. */
  #lineage(): ContextKeyScopeImpl[] {
    const out: ContextKeyScopeImpl[] = [this];
    for (let scope = this.#parentImpl; scope; scope = scope.#parentImpl) out.push(scope);
    return out;
  }

  createKey<K extends string>(name: K, initial?: ContextKeyValue<K>): ContextKey<ContextKeyValue<K>> {
    if (initial !== undefined) this.set(name, initial);
    return {
      name,
      get: () => this.getValue(name) as ContextKeyValue<K> | undefined,
      set: (value) => this.set(name, value),
      reset: () => this.#reset(name),
    };
  }

  set(name: string, value: ContextValue): void {
    if (this.#disposed) return;
    if (value === undefined) {
      this.#reset(name);
      return;
    }
    const cell = this.#cell(name);
    if (sameSlot(cell.peek(), value)) return;
    cell.set(value);
    this.#markChanged(name);
  }

  #reset(name: string): void {
    const cell = this.#cells.get(name);
    if (!cell || cell.peek() === UNSET) return;
    cell.set(UNSET);
    this.#markChanged(name);
  }

  #markChanged(name: string): void {
    this.#pending.add(name);
    if (this.#buffering > 0) return;
    if (transactionGate.depth > 0) {
      // One event per transaction: the first deferred flush sends every key collected until then.
      transactionGate.defer(() => this.#flush());
      return;
    }
    this.#flush();
  }

  #flush(): void {
    if (this.#pending.size === 0 || this.#disposed) return;
    const keys = new Set(this.#pending);
    this.#pending.clear();
    this.#changed.fire(new ChangeImpl(keys));
  }

  bufferChanges<R>(fn: () => R): R {
    this.#buffering++;
    try {
      return fn();
    } finally {
      this.#buffering--;
      if (this.#buffering === 0) this.#markFlush();
    }
  }

  #markFlush(): void {
    if (transactionGate.depth > 0) transactionGate.defer(() => this.#flush());
    else this.#flush();
  }

  createChild(id: string): ContextKeyScope {
    if (this.#disposed) throw new Error(`Context-key scope "${this.id}" is disposed`);
    return new ContextKeyScopeImpl(id, this, this.#parse);
  }

  evaluate(when: WhenExpr | string | undefined): boolean {
    if (when === undefined) return true;
    const expression = typeof when === 'string' ? this.#parse(when) : when;
    return expression.evaluate(this);
  }

  observe(when: WhenExpr | string | undefined): Observable<boolean> {
    const expression = when === undefined ? undefined : typeof when === 'string' ? this.#parse(when) : when;
    return computed(() => (expression === undefined ? true : expression.evaluate(this)), {
      name: `when:${expression?.source ?? 'always'}`,
    });
  }

  snapshot(): Readonly<Record<string, ContextValue>> {
    const merged: Record<string, ContextValue> = {};
    for (const scope of this.#lineage().reverse()) {
      for (const [name, cell] of scope.#cells) {
        const slot = cell.peek();
        if (slot !== UNSET) merged[name] = slot;
        else delete merged[name];
      }
    }
    return merged;
  }

  /** The live child scopes, in creation order. */
  childScopes(): readonly ContextKeyScope[] {
    return [...this.#children];
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const child of [...this.#children]) child.dispose();
    this.#disposed = true;
    if (this.#parentImpl) this.#parentImpl.#children.delete(this);
    this.#cells.clear();
    this.#pending.clear();
    this.#listeners.dispose();
    this.#changed.dispose();
  }
}

export class DefaultContextKeyService implements ContextKeyService {
  readonly root: ContextKeyScope;
  readonly #cache = new Map<string, WhenExpr>();
  readonly #focused: State<ContextKeyScope>;

  constructor(rootId = 'application') {
    this.root = new ContextKeyScopeImpl(rootId, undefined, (source) => this.parse(source));
    this.#focused = state<ContextKeyScope>(this.root, { name: 'contextKeys.focused' });
  }

  get focused(): Observable<ContextKeyScope> {
    return this.#focused.asReadonly();
  }

  /**
   * `undefined` resets to the window scope: the child of the root whose id is 'window' (the root WorkItem's
   * context-key scope), or the root when no window scope exists yet.
   */
  setFocused(scope: ContextKeyScope | undefined): void {
    this.#focused.set(scope ?? this.#windowScope());
  }

  #windowScope(): ContextKeyScope {
    const children = (this.root as ContextKeyScopeImpl).childScopes();
    return children.find((c) => c.id === 'window') ?? this.root;
  }

  parse(source: string): WhenExpr {
    let expression = this.#cache.get(source);
    if (!expression) {
      expression = parseWhen(source);
      this.#cache.set(source, expression);
    }
    return expression;
  }

  tryParse(source: string): WhenExpr | WhenSyntaxError {
    try {
      return this.parse(source);
    } catch (error) {
      if (error instanceof WhenSyntaxError) return error;
      throw error;
    }
  }

  dispose(): void {
    this.root.dispose();
    this.#cache.clear();
  }

  /** For tests that watch cache behaviour. */
  get cacheSize(): number {
    return this.#cache.size;
  }
}

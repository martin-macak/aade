import { TesseraError, type IDisposable, type Event } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';

export type ContextValue = string | number | boolean | null | undefined | readonly string[];

/** Typed keys by declaration merging: interface ContextKeyTypes { 'tasks.selectionCount': number } */
export interface ContextKeyTypes {}
export type ContextKeyValue<K extends string> = K extends keyof ContextKeyTypes
  ? Extract<ContextKeyTypes[K], ContextValue>
  : ContextValue;

export interface ContextKey<T extends ContextValue> {
  readonly name: string;
  get(): T | undefined;
  set(value: T): void;
  /** Removes this scope's value. Lookups fall through to the parent again. */
  reset(): void;
}

export interface ContextReader {
  /** Walks up the chain. Unknown keys return undefined. */
  getValue(name: string): ContextValue;
}

export interface ContextChange {
  readonly keys: ReadonlySet<string>;
  affects(keys: ReadonlySet<string>): boolean;
}

export interface WhenExpr {
  readonly source: string;
  /** The keys the expression reads. */
  readonly keys: ReadonlySet<string>;
  evaluate(context: ContextReader): boolean;
}

export interface ContextKeyScope extends ContextReader, IDisposable {
  readonly id: string;
  readonly parent: ContextKeyScope | undefined;
  createKey<K extends string>(name: K, initial?: ContextKeyValue<K>): ContextKey<ContextKeyValue<K>>;
  /** setContext. Setting undefined removes this scope's value. */
  set(name: string, value: ContextValue): void;
  createChild(id: string): ContextKeyScope;
  /** undefined means "always true". A string is parsed (cached). */
  evaluate(when: WhenExpr | string | undefined): boolean;
  /** Re-evaluates only when a key the expression reads changes in this scope or an ancestor. */
  observe(when: WhenExpr | string | undefined): Observable<boolean>;
  /** One event per transaction or bufferChanges() call, listing all changed keys. */
  readonly onDidChange: Event<ContextChange>;
  bufferChanges<R>(fn: () => R): R;
  /** Merged view of the chain. For debugging and tests. */
  snapshot(): Readonly<Record<string, ContextValue>>;
}

/**
 * What a plugin gets for a context-key scope (contracts 11.4 and 14.6): the scope without `dispose` and `createChild`.
 * `set` and `createKey` throw 'plugin.deactivated' after the plugin ended, and the keys a plugin set on a scope it does not own
 * are reset with the plugin. On such a scope the key must start with the plugin id unless capability `context.global` is granted.
 */
export interface PluginContextKeyScope extends ContextReader {
  readonly id: string;
  readonly parent: PluginContextKeyScope | undefined;
  createKey: ContextKeyScope['createKey'];
  set: ContextKeyScope['set'];
  evaluate: ContextKeyScope['evaluate'];
  observe: ContextKeyScope['observe'];
  readonly onDidChange: ContextKeyScope['onDidChange'];
  bufferChanges: ContextKeyScope['bufferChanges'];
  snapshot: ContextKeyScope['snapshot'];
}

export interface ContextKeyService {
  /** The application context-key scope. */
  readonly root: ContextKeyScope;
  /** The scope keybindings and the palette evaluate against: the focused placement, else the window. */
  readonly focused: Observable<ContextKeyScope>;
  /** The workbench calls this on focus changes. undefined resets to the window scope. */
  setFocused(scope: ContextKeyScope | undefined): void;
  /** Cached by source text. Throws WhenSyntaxError. */
  parse(source: string): WhenExpr;
  tryParse(source: string): WhenExpr | WhenSyntaxError;
}
/** What a plugin gets for the ContextKeyService token: `root` and `focused` are scope facades, setFocused() is refused. */
export interface PluginContextKeyService {
  readonly root: PluginContextKeyScope;
  readonly focused: Observable<PluginContextKeyScope>;
  /** Always throws 'plugin.capabilityDenied': the workbench owns the focused scope. */
  setFocused(scope: ContextKeyScope | undefined): never;
  parse: ContextKeyService['parse'];
  tryParse: ContextKeyService['tryParse'];
}
export const ContextKeyService: Token<ContextKeyService> = token<ContextKeyService>('tessera.contextKeys');

export class WhenSyntaxError extends TesseraError {
  readonly source: string;
  readonly column: number;

  constructor(message: string, source: string, column: number) {
    super('when.syntax', `${message} (column ${column} of "${source}")`, { details: { source, column } });
    this.name = 'WhenSyntaxError';
    this.source = source;
    this.column = column;
  }
}

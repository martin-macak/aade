import type { Event, IDisposable, Schema } from '@tessera/base';
import type { InvocationContext } from '@tessera/interceptors';
import type { Observable } from '@tessera/reactive';
import { token, type ScopeReader, type Token } from '@tessera/di';
import type { ContextKeyScope, ContextReader } from './context-keys.ts';
import type { PlacementId, PlacementRef } from './ids.ts';
import type { UndoEntry } from './undo.ts';

export type CommandSource = 'palette' | 'keybinding' | 'menu' | 'statusBar' | 'view' | 'api' | 'rpc';

/** Declared by a manifest or by code. Cheap: no plugin code needed. */
export interface CommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly description?: string;
  /** When-clause. False: the command is disabled (greyed) everywhere, and execute() rejects. */
  readonly enablement?: string;
  /** Plugin id or 'core'. */
  readonly owner: string;
  /** false hides it from the palette even when enabled. Default true. */
  readonly palette?: boolean;
  /**
   * The owner accepts contextual handlers from other plugins. A foreign handler is accepted only for an extensible command and only with a
   * `when` clause (or with the capability `commands.override`). Ranking: `when` first, then owner before foreign, then priority (a foreign
   * priority counts as at most 0), then the newest handler.
   */
  readonly extensible?: boolean;
}

export type CommandStatus = 'enabled' | 'disabled' | 'unavailable';

/** Per-place look of a command (IntelliJ Presentation). */
export interface CommandPresentation {
  readonly title: string;
  readonly category: string | undefined;
  readonly icon: string | undefined;
  readonly status: CommandStatus;
  readonly toggled: boolean | undefined;
  /** Display label of the best keybinding, for example 'Ctrl+K Ctrl+T'. */
  readonly keybinding: string | undefined;
}

export interface CommandHandler<A = unknown, R = unknown> {
  /** Validates args before run. Failure rejects with 'command.invalidArgs'. */
  readonly args?: Schema<A>;
  /** The handler applies only where this is true. The most specific matching handler wins. */
  readonly when?: string;
  readonly priority?: number;                            // default 0
  /** Cheap extra enablement check. No I/O. @inProcessOnly A function: it cannot cross a process boundary (the v2 remote API uses context-key expressions). */
  readonly isEnabled?: (args: A | undefined, context: ContextReader) => boolean;
  /** Cheap per-place overrides (title, icon, toggled). No I/O. @inProcessOnly A function: the v2 remote API uses `setPresentation(id, patch)`. */
  readonly presentation?: (context: ContextReader) => Partial<Pick<CommandPresentation, 'title' | 'icon' | 'toggled'>>;
  /** @inProcessOnly `ctx.services` and `ctx.invocation` are live objects. The args and the result are RPC-safe (plain data). */
  run(args: A, ctx: CommandContext): R | Promise<R>;
}

export interface CommandContext {
  readonly commandId: string;
  readonly source: CommandSource;
  /** Aborts on caller abort, on timeout interceptors, and on shutdown. Handlers must check it. @inProcessOnly Out of process, a cancel frame replaces it. */
  readonly signal: AbortSignal;
  /** The context-key scope the command was evaluated in. */
  readonly context: ContextReader;
  readonly placement: PlacementRef | undefined;
  /** DI scope of the placement (or its WorkItem, or the window). @inProcessOnly */
  readonly services: ScopeReader;
  /** @inProcessOnly A live object with a mutable notes map. */
  readonly invocation: InvocationContext<'command'>;
  /** Runs a nested command with this invocation as parent (depth guard, one trace). */
  execute<R = unknown>(id: string, args?: unknown, options?: ExecuteOptions): Promise<R>;
  pushUndo(entry: UndoEntry): void;
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly source?: CommandSource;                       // default 'api'
  /** Evaluate in this context-key scope. Default: the placement's scope, else ContextKeyService.focused. */
  readonly context?: ContextKeyScope;
  readonly placementId?: PlacementId;
  /** Skip the enablement check. Audited (warn log with source). */
  readonly force?: boolean;
  readonly parent?: InvocationContext;
  /** The plugin on whose behalf the call runs. Stamped by the plugin runtime, not by plugin code. Guards and the audit log read it as `invocation.data.invoker`. */
  readonly invoker?: string;
  /** Default true. false: the command's `pushUndo` does nothing (an undo or redo step runs it and must not record itself). */
  readonly undoable?: boolean;
}

/** Typed handle: defineCommand<{ title: string }, string>('tasks.add', schema). */
export interface CommandDef<A, R> {
  readonly id: string;
  readonly args: Schema<A> | undefined;
  readonly resultType?: R;                               // phantom
}
export function defineCommand<A = void, R = void>(id: string, args?: Schema<A>): CommandDef<A, R> {
  return Object.freeze({ id, args }) as CommandDef<A, R>;
}

export interface CommandChange {
  readonly kind: 'declared' | 'undeclared' | 'handlers';
  readonly commandId: string;
}

export interface CommandRegistry {
  declare(metadata: CommandMetadata): IDisposable;
  /**
   * `owner` is who registered the handler (a plugin id, 'core', or undefined for code of the host). `options.override` marks a handler
   * that holds the capability `commands.override`: it ranks like the owner's own handlers.
   */
  registerHandler<A, R>(id: string, handler: CommandHandler<A, R>, owner?: string, options?: { readonly override?: boolean }): IDisposable;
  metadata(id: string): CommandMetadata | undefined;
  readonly commands: Observable<ReadonlyMap<string, CommandMetadata>>;
  hasHandler(id: string): boolean;
  readonly onDidChange: Event<CommandChange>;
}
export const CommandRegistry: Token<CommandRegistry> = token<CommandRegistry>('tessera.commandRegistry');

export interface CommandExecutedEvent {
  readonly commandId: string;
  readonly source: CommandSource;
  readonly outcome: 'ok' | 'error' | 'cancelled' | 'rejected';
  readonly durationMs: number;
  readonly errorCode: string | undefined;
  readonly owner: string | undefined;
}

export interface CommandService {
  execute<R = unknown>(id: string, args?: unknown, options?: ExecuteOptions): Promise<R>;
  run<A, R>(command: CommandDef<A, R>, args: A, options?: ExecuteOptions): Promise<R>;
  status(id: string, context: ContextReader): CommandStatus;
  observeStatus(id: string, context: ContextKeyScope): Observable<CommandStatus>;
  presentation(id: string, context: ContextKeyScope): Observable<CommandPresentation>;
  readonly onDidExecute: Event<CommandExecutedEvent>;
}
export const CommandService: Token<CommandService> = token<CommandService>('tessera.commandService');

import { CancellationError, TesseraError, getScheduler, isCancellationError, reportError, Emitter, type Event } from '@tessera/base';
import {
  ActivationService,
  CommandRegistry,
  ContextKeyService,
  CoreTopics,
  EventNode,
  InterceptorRegistry,
  KeybindingService,
  Logger as LoggerToken,
  PluginManager,
  PluginState,
  UndoService,
  WorkItemService,
  WorkbenchService,
  type CommandContext,
  type CommandDef,
  type CommandExecutedEvent,
  type CommandHandler,
  type CommandMetadata,
  type CommandPresentation,
  type CommandService,
  type CommandSource,
  type CommandStatus,
  type ContextKeyScope,
  type ContextKeyService as ContextKeyServiceType,
  type ContextReader,
  type ExecuteOptions,
  type PlacementId,
} from '@tessera/contracts';
import { injectScope, type Scope, type ScopeReader } from '@tessera/di';
import type { InvocationContext } from '@tessera/interceptors';
import { computed, type Observable } from '@tessera/reactive';
import { DefaultKeybindingService } from './keybindings.ts';
import type { DefaultCommandRegistry, RegisteredHandler } from './registry.ts';

function reject(code: string, message: string, details?: Record<string, unknown>): TesseraError {
  return new TesseraError(code, message, details ? { details } : undefined);
}

/**
 * Handlers whose `when` holds, most specific first: with a `when`, then owner before foreign, then priority, then newest.
 * Owner means the plugin that declared the command, the core (no owner given) or a handler with the capability commands.override.
 * The foreign priority is clamped to 0 when the handler is registered (the plugin runtime), so it cannot outrank by number.
 */
function rankHandlers(handlers: readonly RegisteredHandler[], context: ContextReader, evaluate: (h: RegisteredHandler, c: ContextReader) => boolean, commandOwner: string | undefined): RegisteredHandler[] {
  const tier = (h: RegisteredHandler): number => (h.owner === undefined || h.owner === 'core' || h.owner === commandOwner || h.override ? 1 : 0);
  return handlers
    .filter((h) => evaluate(h, context))
    .toSorted((a, b) => {
      const aWhen = a.handler.when !== undefined ? 1 : 0;
      const bWhen = b.handler.when !== undefined ? 1 : 0;
      return bWhen - aWhen || tier(b) - tier(a) || (b.handler.priority ?? 0) - (a.handler.priority ?? 0) || b.seq - a.seq;
    });
}

export class DefaultCommandService implements CommandService {
  readonly #scope: Scope;
  readonly #registry: DefaultCommandRegistry;
  readonly #shutdown = new AbortController();
  readonly #executed = new Emitter<CommandExecutedEvent>({ name: 'commands.executed', deferInTransaction: false });

  constructor() {
    this.#scope = injectScope();
    this.#registry = this.#scope.get(CommandRegistry) as DefaultCommandRegistry;
  }

  get onDidExecute(): Event<CommandExecutedEvent> {
    return this.#executed.event;
  }

  #contextKeys(): ContextKeyServiceType {
    return this.#scope.get(ContextKeyService);
  }

  #evaluate = (when: string | undefined, context: ContextReader): boolean => {
    if (when === undefined) return true;
    const expression = this.#contextKeys().parse(when);
    return expression.evaluate(context);
  };

  /** Commands and hooks whose failure was reported already: one report per command, owner and hook. */
  readonly #reportedHooks = new Set<string>();

  /**
   * Runs plugin-supplied code that must be cheap and safe (a `when` clause, isEnabled, presentation). A throw is reported once
   * per command, owner and hook, and the safe fallback is used (disabled, the base presentation), so one bad plugin cannot
   * break the palette or a menu.
   */
  #guarded<T>(commandId: string, owner: string | undefined, hook: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      const key = `${commandId}\u0000${owner ?? ''}\u0000${hook}`;
      if (!this.#reportedHooks.has(key)) {
        this.#reportedHooks.add(key);
        reportError(error, { source: 'command', target: commandId, ...(owner !== undefined ? { pluginId: owner } : {}), details: { hook } });
      }
      return fallback;
    }
  }

  /** The `when` of a handler, guarded: a clause that throws (a parse error) does not match. */
  #handlerApplies = (commandId: string) => (h: RegisteredHandler, context: ContextReader): boolean =>
    this.#guarded(commandId, h.owner, 'when', () => this.#evaluate(h.handler.when, context), false);

  run<A, R>(command: CommandDef<A, R>, args: A, options?: ExecuteOptions): Promise<R> {
    return this.execute<R>(command.id, args, options);
  }

  // ----- status and presentation ---------------------------------------------------------------

  status(id: string, context: ContextReader): CommandStatus {
    const metadata = this.#registry.metadata(id);
    const handlers = this.#registry.handlersOf(id);
    if (!metadata && handlers.length === 0) return 'unavailable';
    const ranked = rankHandlers(handlers, context, this.#handlerApplies(id), metadata?.owner);
    if (handlers.length === 0) {
      // A declared command of a plugin that has not run yet is available: executing it activates the plugin.
      // A plugin that failed (or is invalid) cannot activate: its declared commands are unavailable.
      const canActivate = metadata !== undefined && metadata.owner !== 'core' && this.#scope.get(ActivationService, { optional: true }) !== undefined && !this.#ownerFailed(metadata.owner);
      if (!canActivate) return 'unavailable';
    } else if (ranked.length === 0) {
      return 'unavailable';
    }
    if (metadata?.enablement !== undefined && !this.#guarded(id, metadata.owner, 'enablement', () => this.#evaluate(metadata.enablement, context), false)) return 'disabled';
    const best = ranked[0];
    const isEnabled = best?.handler.isEnabled;
    if (isEnabled && !this.#guarded(id, best?.owner, 'isEnabled', () => isEnabled(undefined, context), false)) return 'disabled';
    return 'enabled';
  }

  /** True when the plugin that owns a declared command is Failed (it will not activate on its own). Reads the status map, so a computed tracks it. */
  #ownerFailed(owner: string): boolean {
    const manager = this.#scope.get(PluginManager, { optional: true });
    if (!manager) return false;
    return manager.plugins.get().get(owner)?.state === PluginState.Failed;
  }

  observeStatus(id: string, context: ContextKeyScope): Observable<CommandStatus> {
    return computed(() => {
      this.#registry.version.get();
      return this.status(id, context);
    }, { name: `command.status:${id}` });
  }

  presentation(id: string, context: ContextKeyScope): Observable<CommandPresentation> {
    return computed(
      () => {
        this.#registry.version.get();
        const metadata = this.#registry.metadata(id);
        const best = rankHandlers(this.#registry.handlersOf(id), context, this.#handlerApplies(id), metadata?.owner)[0];
        const presentationOf = best?.handler.presentation;
        const overrides = presentationOf ? this.#guarded<Partial<Pick<CommandPresentation, 'title' | 'icon' | 'toggled'>>>(id, best?.owner, 'presentation', () => presentationOf(context) ?? {}, {}) : {};
        const keybindings = this.#scope.get(KeybindingService, { optional: true });
        if (keybindings instanceof DefaultKeybindingService) keybindings.version.get();
        const label = keybindings?.lookup(id, context)[0]?.label;
        return {
          title: overrides.title ?? metadata?.title ?? id,
          category: metadata?.category,
          icon: overrides.icon ?? metadata?.icon,
          status: this.status(id, context),
          toggled: overrides.toggled,
          keybinding: label,
        };
      },
      {
        name: `command.presentation:${id}`,
        equals: (a, b) => a.title === b.title && a.category === b.category && a.icon === b.icon && a.status === b.status && a.toggled === b.toggled && a.keybinding === b.keybinding,
      },
    );
  }

  // ----- execution -----------------------------------------------------------------------------

  execute<R = unknown>(id: string, args?: unknown, options?: ExecuteOptions): Promise<R> {
    // An async function never throws synchronously: every failure is a rejected promise.
    return this.#execute(id, args, options) as Promise<R>;
  }

  async #execute(id: string, args: unknown, options: ExecuteOptions | undefined): Promise<unknown> {
    const started = getScheduler().now();
    const source: CommandSource = options?.source ?? 'api';
    let owner: string | undefined = this.#registry.metadata(id)?.owner;
    let outcome: CommandExecutedEvent['outcome'] = 'ok';
    let errorCode: string | undefined;
    try {
      return await this.#run(id, args, options, source, (handlerOwner) => {
        owner = handlerOwner ?? owner;
      });
    } catch (error) {
      if (error instanceof CancellationError || isCancellationError(error)) outcome = 'cancelled';
      else if (error instanceof TesseraError && error.code.startsWith('command.')) outcome = 'rejected';
      else outcome = 'error';
      errorCode = error instanceof TesseraError ? error.code : undefined;
      throw error;
    } finally {
      this.#announce({ commandId: id, source, outcome, durationMs: getScheduler().now() - started, errorCode, owner });
    }
  }

  async #run(id: string, args: unknown, options: ExecuteOptions | undefined, source: CommandSource, setOwner: (owner: string | undefined) => void): Promise<unknown> {
    const registry = this.#registry;
    // 1. look up
    if (!registry.metadata(id) && !registry.hasHandler(id)) throw reject('command.notFound', `Unknown command "${id}"`, { commandId: id });
    // 2. activate. Always asked: besides the owner of a command that has no handler yet, a dormant plugin may guard or observe it
    // (an interceptor with a literal command match derives onCommand:<id>). The reverse index makes the question O(1) when nobody waits.
    const activation = this.#scope.get(ActivationService, { optional: true });
    if (activation) await activation.activateByEvent(`onCommand:${id}`);
    if (!registry.hasHandler(id)) throw reject('command.unavailable', `Command "${id}" has no handler`, { commandId: id });
    // 3. context
    const keys = this.#contextKeys();
    const context = options?.context ?? keys.focused.peek();
    // 4. pick a handler
    const handler = rankHandlers(registry.handlersOf(id), context, this.#handlerApplies(id), registry.metadata(id)?.owner)[0];
    if (!handler) throw reject('command.unavailable', `No handler of "${id}" applies in this context`, { commandId: id });
    setOwner(handler.owner);
    // 5. validate
    let validated = args;
    if (handler.handler.args) {
      const parsed = handler.handler.args.safeParse(args);
      if (!parsed.success) {
        throw reject('command.invalidArgs', `Invalid arguments for "${id}": ${parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')}`, {
          commandId: id,
          issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
        });
      }
      validated = parsed.data;
    }
    // 6. enablement, for every source
    const metadata = registry.metadata(id);
    if (options?.force) {
      // Audit (contracts 13.1): a warn log. `forced: true` is also in the interceptor data. Plugins need the capability 'commands.force' (checked in the plugin runtime).
      this.#scope.get(LoggerToken, { optional: true })?.child('commands').warn(`Command "${id}" executed with force from source "${source}"`, { commandId: id, source, owner: handler.owner });
    } else {
      if (metadata?.enablement !== undefined && !this.#guarded(id, metadata.owner, 'enablement', () => this.#evaluate(metadata.enablement, context), false)) {
        throw reject('command.disabled', `Command "${id}" is disabled`, { commandId: id, enablement: metadata.enablement });
      }
      const isEnabled = handler.handler.isEnabled;
      if (isEnabled && !this.#guarded(id, handler.owner, 'isEnabled', () => isEnabled(validated, context), false)) {
        throw reject('command.disabled', `Command "${id}" is disabled by its handler`, { commandId: id });
      }
    }
    // 7. intercept
    // The command also ends with the placement it runs from: closing the placement aborts the signal (a handler that ignores it is the owner's bug).
    // Core commands are exempt: workbench.closePlacement runs from the placement it closes and must not abort itself.
    const placement = options?.placementId === undefined || handler.owner === 'core' ? undefined : this.#scope.get(WorkbenchService, { optional: true })?.placement(options.placementId);
    const placementEnded = new AbortController();
    const placementSub = placement?.scope?.onWillDispose(() => placementEnded.abort());
    const signals = [this.#shutdown.signal, ...(options?.signal ? [options.signal] : []), ...(placementSub ? [placementEnded.signal] : [])];
    const signal = AbortSignal.any(signals);
    const undoable = options?.undoable !== false;
    const interceptors = this.#scope.get(InterceptorRegistry, { optional: true });
    const terminal = async (ctx: InvocationContext<'command'>): Promise<unknown> => {
      if (ctx.signal.aborted) throw new CancellationError();
      return this.#invoke(id, handler, ctx, context, source, undoable);
    };
    const data = { commandId: id, args: validated, source, placementId: options?.placementId, forced: options?.force === true, ...(options?.invoker !== undefined ? { invoker: options.invoker } : {}) };
    if (!interceptors) {
      const bare = {
        kind: 'command',
        target: id,
        data,
        signal,
        source,
        depth: 0,
        parent: undefined,
        traceId: id,
        meta: new Map<symbol, unknown>(),
        with: () => bare,
      } as unknown as InvocationContext<'command'>;
      try {
        return await terminal(bare);
      } finally {
        placementSub?.dispose();
      }
    }
    const ctx = interceptors.createContext('command', id, data, {
      signal,
      source,
      ...(options?.parent !== undefined ? { parent: options.parent } : {}),
    });
    try {
      return await interceptors.run(ctx, terminal);
    } finally {
      placementSub?.dispose();
    }
  }

  async #invoke(
    id: string,
    registered: RegisteredHandler,
    ctx: InvocationContext<'command'>,
    context: ContextKeyScope,
    source: CommandSource,
    undoable: boolean,
  ): Promise<unknown> {
    const undo = this.#scope.get(UndoService, { optional: true });
    const owner = registered.owner ?? this.#registry.metadata(id)?.owner;
    // the placement the command runs in (a view, a menu of a view): found through the workbench token at run time, because L2 packages never import each other
    const placementId = (ctx.data as { placementId?: PlacementId }).placementId;
    const workbench = this.#scope.get(WorkbenchService, { optional: true });
    const placed = placementId === undefined ? undefined : workbench?.placement(placementId);
    // services: the placement scope; a placement without a presenter has none, so its WorkItem's scope; else the window (contracts 13.1)
    let services: ScopeReader = this.#scope;
    if (placed?.scope) services = placed.scope;
    else if (placed) {
      const instance = workbench?.instance(placed.instanceId);
      const workItem = instance === undefined ? undefined : this.#scope.get(WorkItemService, { optional: true })?.find(instance.workItemPath);
      if (workItem) services = workItem.scope;
    }
    const commandContext: CommandContext = {
      commandId: id,
      source,
      signal: ctx.signal,
      context,
      placement: placed ? { id: placed.id, viewType: placed.viewType, instanceId: placed.instanceId, workspaceId: placed.workspaceId, windowId: placed.windowId } : undefined,
      services,
      invocation: ctx,
      execute: (nestedId, nestedArgs, nestedOptions) =>
        this.execute(nestedId, nestedArgs, { source: 'api', context, ...nestedOptions, parent: ctx, ...(ctx.data.invoker !== undefined ? { invoker: ctx.data.invoker } : {}) }),
      pushUndo: (entry) => {
        if (!undoable) return; // an undo or redo step runs this command: it must not record itself
        undo?.push(entry, owner === undefined ? undefined : { owner });
      },
    };
    try {
      return await (registered.handler as CommandHandler<unknown, unknown>).run(ctx.data.args, commandContext);
    } catch (error) {
      if (ctx.signal.aborted || isCancellationError(error)) throw error instanceof CancellationError ? error : new CancellationError(undefined, { cause: error });
      reportError(error, { source: 'command', target: id, ...(owner !== undefined ? { pluginId: owner } : {}) });
      throw error;
    }
  }

  #announce(event: CommandExecutedEvent): void {
    try {
      this.#executed.fire(event);
      const node = this.#scope.get(EventNode, { optional: true });
      node?.publish(CoreTopics.commandExecuted, event);
    } catch (error) {
      reportError(error, { source: 'command', target: event.commandId });
    }
  }

  dispose(): void {
    this.#shutdown.abort();
    this.#executed.dispose();
  }
}

export type { CommandMetadata };

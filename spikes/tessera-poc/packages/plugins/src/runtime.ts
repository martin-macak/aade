import {
  CancellationError,
  DisposableStore,
  TesseraError,
  getScheduler,
  isCancellationError,
  reportError,
  toDisposable,
  type IDisposable,
  type Logger,
  type StateSchema,
} from '@tessera/base';
import {
  CommandRegistry,
  CommandService,
  ConfigurationService,
  DialogService,
  ContextKeyService,
  ContributionRegistry,
  CORE_TOKEN_PREFIX,
  RESERVED_POINT_IDS,
  EventBus,
  InterceptorRegistry,
  LifecycleService,
  Logger as LoggerToken,
  NotificationService,
  PluginManager,
  PublicTokens,
  QuickInputService,
  StorageService,
  TESSERA_API_VERSION,
  UndoService,
  ViewRegistry,
  WorkItemService,
  WorkbenchService,
  type CommandContext,
  type CommandDef,
  type CommandHandler,
  type ContextKeyScope,
  type ContributionRegistry as ContributionRegistryType,
  type ExecuteOptions,
  type PluginContext,
  type InterceptorContribution,
  type PluginDescription,
  type PluginManifest,
  type PluginModule,
  type PluginServices,
  type PluginWorkItem,
  type PluginStorage,
  type StorageScope,
  type TesseraApi,
  type UndoService as UndoServiceType,
  type ViewProvider,
  type WorkItem,
  type WorkItemService as WorkItemServiceType,
} from '@tessera/contracts';
import { runFiltered, type Factory, type InjectionFilter, type MultiToken, type ProvideOptions, type Scope, type ScopeReader, type Token } from '@tessera/di';
import { changes, state, type Observable } from '@tessera/reactive';
import type { Interceptor, SyncObserver } from '@tessera/interceptors';
import { createFacades, type Facades } from './facades.ts';
import { decideCapabilities, hostServicesOf } from './policy.ts';
import { interceptorsPoint } from './points.ts';

const PUBLIC_TOKEN_IDS: ReadonlySet<string> = new Set(PublicTokens.map((t) => t.id));

/** A plugin guard that does not decide in this time fails the invocation (interceptor.guardTimeout), unless it is declared interactive. */
const PLUGIN_GUARD_CEILING_MS = 30_000;
/** A plugin guard that takes longer than this is reported once (interceptor.slowGuard). */
const SLOW_GUARD_MS = 5000;

/** Invocation kinds that expose the platform's internals: observing them needs the capability `interceptors.observe` (commands and events do not). */
const OBSERVE_CAPABILITY_KINDS: readonly string[] = ['service', 'persistence', 'ipc', 'activation'];

function denied(pluginId: string, what: string): TesseraError {
  return new TesseraError('plugin.capabilityDenied', `Plugin "${pluginId}" is not allowed to ${what}`, { details: { pluginId } });
}

/** Everything one activation of one plugin owns. The host disposes it as a unit. */
export interface PluginRuntime {
  readonly description: PluginDescription;
  readonly scope: Scope;
  readonly store: DisposableStore;
  readonly abort: AbortController;
  readonly ctx: PluginContext;
  /** Registrations made through the context that are not disposed yet (the dev-mode "live disposables" report). */
  readonly live: Map<number, string>;
  /** Every WorkItem whose owner is this plugin, whichever API created it (WorkItemService.onDidCreate). The host terminates them. */
  readonly workItems: WorkItem[];
  /**
   * Set when the host starts the cleanup (after deactivate() ran, or after a failed or timed-out activation). From then on
   * every call that would register something throws 'plugin.deactivated' (a late call of an abandoned activate()).
   */
  closed: boolean;
  /** Set by the host when activate() resolved. deactivate() of the module runs only then (OSGi rule). */
  activated: boolean;
  /** Captured at activation: deactivation can run while the window scope is already disposing. */
  readonly undo: UndoServiceType | undefined;
  module: PluginModule | undefined;
  /** Called by the host for a WorkItem whose owner is this plugin (any API path). */
  adoptWorkItem(workItem: WorkItem): void;
  /** The view door: what a view of this plugin gets as ViewContext.services (the gated reader over the placement scope). */
  viewServices(base: ScopeReader): ScopeReader;
  /** The view door: what a view of this plugin gets as ViewContext.contextKeys (the context-key facade). */
  viewContext(scope: ContextKeyScope): ContextKeyScope;
}

function pluginStorage(window: Scope, scope: StorageScope, pluginId: string): PluginStorage {
  const prefix = `plugin:${pluginId}:`;
  const storage = (): StorageService => window.get(StorageService);
  return {
    get: <T>(key: string, schema: StateSchema<T>): T => storage().getVersioned(scope, prefix + key, schema).value,
    set: <T>(key: string, value: T, schema: StateSchema<T>): void => storage().setVersioned(scope, prefix + key, value, schema),
    delete: (key) => storage().delete(scope, prefix + key),
    keys: () => storage().keys(scope, prefix).map((k) => k.slice(prefix.length)),
    memento: <T>(key: string, schema: StateSchema<T>) => storage().memento(scope, prefix + key, schema),
  };
}

/** Creates the context of one activation (contracts.md 14.6 and 14.7). Every registration goes into ctx.subscriptions. */
export function createPluginRuntime(window: Scope, description: PluginDescription, reason: string): PluginRuntime {
  const manifest: PluginManifest = description.manifest;
  const pluginId = manifest.id;
  // What the plugin may do: the capabilities it asks for, intersected with what the host policy grants (the default policy gives a user plugin none).
  const capabilities = new Set(decideCapabilities(window, description).granted);
  const hostServices = hostServicesOf(window);
  const store = new DisposableStore(`plugin:${pluginId}`);
  const abort = new AbortController();
  const scope = window.createChild('plugin', pluginId);
  const live = new Map<number, string>();
  const workItems: WorkItem[] = [];
  let counter = 0;

  let closed = false;
  const assertLive = (what: string): void => {
    if (closed) throw new TesseraError('plugin.deactivated', `Plugin "${pluginId}" is not active: cannot ${what}`, { details: { pluginId } });
  };

  const track = (kind: string, name: string, d: IDisposable): IDisposable => {
    if (closed) {
      d.dispose(); // the registration was made a moment ago: undo it, then tell the caller
      assertLive(`register ${kind} "${name}"`);
    }
    const key = ++counter;
    live.set(key, `${kind}:${name}`);
    // The wrapper leaves the store when it is disposed: a plugin that registers and disposes in a loop keeps no garbage (O(1) release).
    const wrapper = toDisposable(() => {
      live.delete(key);
      store.release(wrapper);
      d.dispose();
    });
    return store.add(wrapper);
  };

  const undo = window.get(UndoService, { optional: true });

  // Track by owner, not by API path: every WorkItem stamped with this plugin id ends with the plugin. The host listens once to
  // WorkItemService.onDidCreate and hands the WorkItem to the runtime of its owner (adoptWorkItem), so 200 plugins add one listener.
  // The WorkItem joins the plugin store at once: one LIFO order covers services, subscriptions and WorkItems.
  const adoptWorkItem = (workItem: WorkItem): void => {
    workItems.push(workItem);
    const end = (): void => void workItem.terminate().catch((error: unknown) => reportError(error, { source: 'dispose', pluginId, target: pluginId }));
    if (closed) end(); // created after the cleanup began
    else store.add(toDisposable(end));
  };

  const logger: Logger = (window.get(LoggerToken, { optional: true }) ?? undefined)?.child(pluginId) ?? createNullLogger(pluginId);

  // ----- access gate (contracts.md 14.6): one rule for ctx.services, inject() in factories and CommandContext.services ----
  // `requires` is safe: the resolver refuses a plugin whose required token has no plugin provider (public tokens aside).
  // `optional` is not: the resolver skips a token nobody provides, so a core token listed there would reach the plugin. The gate
  // therefore reads the owner of the registration: an optional token is readable only while every registration that answers
  // to it is owned by an installed plugin (core registrations carry no owner or an owner such as 'shell').
  const grantedIds = new Set<string>([...(manifest.requires ?? []), ...(manifest.provides ?? [])]);
  const optionalIds = new Set<string>(manifest.optional ?? []);
  const isPlugin = (owner: string | undefined): boolean => owner !== undefined && window.get(PluginManager, { optional: true })?.status(owner) !== undefined;
  const registeredByCore = (tokenId: string): boolean => window.ownersOf(tokenId).some((owner) => !isPlugin(owner));
  // A service of the host product is open to plugins that hold its capability (or to all when it names none).
  const hostAllows = (tokenId: string): boolean => {
    const service = hostServices.get(tokenId);
    return service !== undefined && (service.capability === undefined || capabilities.has(service.capability));
  };
  const mayRead = (tokenId: string): boolean => (grantedIds.has(tokenId) && (!hostServices.has(tokenId) || hostAllows(tokenId))) || hostAllows(tokenId) || PUBLIC_TOKEN_IDS.has(tokenId) || (optionalIds.has(tokenId) && !registeredByCore(tokenId));
  const check = (tokenId: string): void => {
    if (mayRead(tokenId)) return;
    throw denied(
      pluginId,
      optionalIds.has(tokenId)
        ? `get the service "${tokenId}": it is registered by the core, and manifest optional grants only tokens that a plugin provides`
        : `get the service "${tokenId}": declare it in manifest requires or optional`,
    );
  };
  const mayForce = capabilities.has('commands.force');
  const forceDenied = (options: ExecuteOptions | undefined): TesseraError | undefined =>
    options?.force === true && !mayForce ? denied(pluginId, 'execute a command with force: capability "commands.force" is missing') : undefined;
  /**
   * What every call a plugin starts carries: its id (`invoker`, so guards and the audit log can attribute the call) and its abort signal
   * (the call ends with the plugin). A plugin cannot name another invoker.
   */
  /** A dead context fails an async call with a rejected promise, not a throw. */
  const deadReject = (what: string): Promise<never> | undefined => {
    try {
      assertLive(what);
      return undefined;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const stamped = (options: ExecuteOptions | undefined): ExecuteOptions => ({
    ...options,
    invoker: pluginId,
    signal: options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
  });
  /** The CommandService a plugin sees: same service, but `force` needs the capability. */
  const commandFacades = new WeakMap<CommandService, CommandService>();
  const commandFacade = (real: CommandService): CommandService => {
    const known = commandFacades.get(real);
    if (known) return known;
    const facade = new Proxy(real, {
      get(target, prop) {
        if (prop === 'execute') {
          return (id: string, args?: unknown, options?: ExecuteOptions) => {
            const dead = deadReject(`execute the command "${id}"`);
            if (dead) return dead;
            const error = forceDenied(options);
            return error ? Promise.reject(error) : target.execute(id, args, stamped(options));
          };
        }
        if (prop === 'run') {
          return (command: Parameters<CommandService['run']>[0], args: unknown, options?: ExecuteOptions) => {
            const dead = deadReject(`run the command "${command.id}"`);
            if (dead) return dead;
            const error = forceDenied(options);
            return error ? Promise.reject(error) : target.run(command, args, stamped(options));
          };
        }
        const member: unknown = Reflect.get(target, prop, target);
        return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(target) : member;
      },
    });
    commandFacades.set(real, facade);
    return facade;
  };
  // Facades for the services that would give a plugin more than its manifest grants (WorkItem scopes, owners).
  const facades: Facades = createFacades({
    pluginId,
    provides: new Set(manifest.provides ?? []),
    mayGlobalContext: capabilities.has('context.global'),
    get filter(): InjectionFilter {
      return filter;
    },
    assertLive,
    signal: abort.signal,
    has: (capability) => capabilities.has(capability),
    ownsViewType: (viewType) => window.get(ViewRegistry).descriptor(viewType)?.owner === pluginId,
    declaresSetting: (key) => (manifest.contributes?.['configuration'] ?? []).some((entry) => (entry as { key?: unknown }).key === key),
    denied: (what) => denied(pluginId, what),
    ownerOfContextKey: (name) => {
      let best: string | undefined;
      for (const id of window.get(PluginManager, { optional: true })?.plugins.peek().keys() ?? []) {
        if (name.startsWith(`${id}.`) && (best === undefined || id.length > best.length)) best = id;
      }
      return best;
    },
    track,
  });
  // Every public token comes out as a per-plugin facade, and the IDisposable of its registering members (events, add, notify,
  // createWorkspace) goes into the plugin store (facades.tracked). A token that a plugin provides is the provider's own contract.
  const wrap = <T>(tokenId: string, value: T): T => {
    switch (tokenId) {
      case CommandService.id:
        return facades.tracked(tokenId, commandFacade(value as CommandService)) as T;
      case WorkItemService.id:
        return facades.tracked(tokenId, facades.workItemService(value as WorkItemServiceType)) as T;
      case WorkbenchService.id:
        return facades.tracked(tokenId, facades.workbench(value as WorkbenchService)) as T;
      case UndoService.id:
        return facades.tracked(tokenId, facades.undo(value as UndoServiceType)) as T;
      case ConfigurationService.id:
        return facades.tracked(tokenId, facades.configuration(value as ConfigurationService)) as T;
      case NotificationService.id:
        return facades.tracked(tokenId, facades.notifications(value as NotificationService)) as T;
      case DialogService.id:
        return facades.dialog(value as DialogService) as T;
      case ContextKeyService.id:
        return facades.tracked(tokenId, facades.contextKeyService(value as ContextKeyService)) as T;
      default: {
        const host = hostServices.get(tokenId);
        if (host) return (host.facade ? host.facade(pluginId)(value) : value) as T;
        return PUBLIC_TOKEN_IDS.has(tokenId) ? facades.tracked(tokenId, value) : value;
      }
    }
  };
  /** Applied to inject(), injectAll() and injectLazy() while plugin factories run (view models, presenters, provided services). */
  const filter: InjectionFilter = { check, wrap };
  const gatedReader = (base: ScopeReader): ScopeReader => {
    const get = (token: Token<unknown>, options?: { readonly optional: true }): unknown => {
      assertLive(`get the service "${token.id}"`);
      check(token.id);
      const value = options ? base.get(token, options) : base.get(token);
      return value === undefined ? value : wrap(token.id, value);
    };
    return {
      get: get as ScopeReader['get'],
      getAll: <T>(token: MultiToken<T>): readonly T[] => {
        assertLive(`get the services "${token.id}"`);
        check(token.id);
        return base.getAll(token);
      },
      has: (token) => !closed && mayRead(token.id) && base.has(token), // false after the plugin ended, too. false, not a throw: has() is how a caller avoids one, and it must not leak what is registered
    };
  };
  /**
   * The handler sees a context with gated `services` and a `execute` that cannot force without the capability. Its `signal` also aborts
   * when the plugin ends (deactivation, shutdown), so work a plugin command started stops with the plugin.
   */
  const guardContext = (c: CommandContext): CommandContext => ({
    ...c,
    signal: AbortSignal.any([c.signal, abort.signal]),
    services: gatedReader(c.services),
    execute: (id, args, options) => {
      const dead = deadReject(`execute the command "${id}"`);
      if (dead) return dead;
      const error = forceDenied(options);
      return error ? Promise.reject(error) : c.execute(id, args, stamped(options));
    },
  });

  /**
   * Runs a command handler of this plugin. When the plugin's signal aborts while the handler is still running, the command ends as
   * cancelled (the handler may ignore its signal; its work is abandoned, not awaited). A rejection after the abort counts as cancelled too.
   */
  const runOwned = <A, R>(handler: CommandHandler<A, R>, args: A, gc: CommandContext): R | Promise<R> => {
    const cancelledError = (cause?: unknown): CancellationError => new CancellationError(`Plugin "${pluginId}" ended while its command was running`, cause === undefined ? undefined : { cause });
    let result: R | Promise<R>;
    try {
      result = handler.run(args, gc) as R | Promise<R>;
    } catch (error) {
      throw abort.signal.aborted && !isCancellationError(error) ? cancelledError(error) : error;
    }
    if (result === null || typeof result !== 'object' || typeof (result as { then?: unknown }).then !== 'function') return result;
    return new Promise<R>((resolve, reject) => {
      const onAbort = (): void => reject(cancelledError());
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener('abort', onAbort, { once: true });
      (result as Promise<R>).then(
        (value) => {
          abort.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          abort.signal.removeEventListener('abort', onAbort);
          reject(abort.signal.aborted && !isCancellationError(error) ? cancelledError(error) : error);
        },
      );
    });
  };

  // ----- TesseraApi ----------------------------------------------------------------------------
  const api: TesseraApi = {
    version: TESSERA_API_VERSION,
    commands: {
      registerHandler: <A, R>(target: string | CommandDef<A, R>, given: CommandHandler<A, R> | Omit<CommandHandler<A, R>, 'args'>) => {
        const id = typeof target === 'string' ? target : target.id;
        // A CommandDef brings its argument schema; the handler then needs none of its own.
        const handler: CommandHandler<A, R> = typeof target === 'string' || target.args === undefined ? (given as CommandHandler<A, R>) : ({ ...given, args: target.args } as CommandHandler<A, R>);
        assertLive(`register the command handler "${id}"`);
        // Owner consent (contracts 13.1): a handler for a command of another owner is accepted only when the owner declared the command
        // `extensible` and the handler has a `when` clause (it scopes the handler and shows in review and in the audit log), or when the plugin
        // holds the capability commands.override. A foreign handler ranks after the owner's own, and its priority counts as at most 0.
        const metadata = window.get(CommandRegistry).metadata(id);
        const declaredBy = metadata?.owner;
        const foreign = declaredBy !== undefined && declaredBy !== pluginId;
        const override = foreign && capabilities.has('commands.override');
        if (foreign && !override && !(metadata?.extensible === true && handler.when !== undefined)) {
          throw denied(
            pluginId,
            metadata?.extensible === true
              ? `register a handler for the command "${id}" of "${declaredBy}": give the handler a "when" clause`
              : `register a handler for the command "${id}" of "${declaredBy}": the owner did not declare it extensible, and the plugin does not hold the capability "commands.override"`,
          );
        }
        const guarded: CommandHandler<A, R> = Object.create(handler, {
          run: { value: (args: A, c: CommandContext) => runOwned(handler, args, guardContext(c)), enumerable: true },
          ...(foreign && !override ? { priority: { value: Math.min(handler.priority ?? 0, 0), enumerable: true } } : {}),
        });
        return track('command', id, window.get(CommandRegistry).registerHandler(id, guarded, pluginId, override ? { override: true } : undefined));
      },
      execute: <R>(id: string, args?: unknown, options?: { readonly signal?: AbortSignal }) => {
        const dead = deadReject(`execute the command "${id}"`);
        if (dead) return dead;
        return window.get(CommandService).execute<R>(id, args, stamped({ source: 'api', ...(options?.signal ? { signal: options.signal } : {}) }));
      },
      run: (command, args, options) => {
        const dead = deadReject(`run the command "${command.id}"`);
        if (dead) return dead;
        return window.get(CommandService).run(command, args, stamped({ source: 'api', ...(options?.signal ? { signal: options.signal } : {}) }));
      },
    },
    events: {
      // One home for the topic rule, the owner stamp and the late-call check: the event-node facade.
      publish: (topic, payload) => facades.eventNode(window.get(EventBus).root).publish(topic, payload, { scope: 'global' }),
      subscribe: (topic, handler, options) =>
        track('subscription', topic.id, window.get(EventBus).root.subscribe(topic, handler, { ...options, owner: pluginId })),
    },
    context: {
      // One rule, one home: the facade of the root scope checks the prefix and the capability, refuses a late call and resets the key on deactivation.
      set: (key, value) => facades.contextKeyService(window.get(ContextKeyService)).root.set(key, value),
    },
    workbench: {
      showView: (viewType, options) => facades.workbench(window.get(WorkbenchService)).showView(viewType, options),
      closePlacement: (id) => facades.workbench(window.get(WorkbenchService)).close(id),
      onDidChangeFocus: (listener, options) =>
        track('event', 'workbench.focus', changes(window.get(WorkbenchService).focused)(listener, options)),
    },
    window: {
      notify: (notification) => track('notification', notification.message, facades.notifications(window.get(NotificationService)).notify(notification)),
      pick: (items, options) => {
        assertLive('show a picker');
        return window.get(QuickInputService).pick(items, options);
      },
      confirm: (options) => {
        const dead = deadReject('show a confirm dialog');
        return dead ?? facades.dialog(window.get(DialogService)).confirm(options);
      },
      input: (options) => {
        const dead = deadReject('show an input dialog');
        return dead ?? facades.dialog(window.get(DialogService)).input(options);
      },
      withProgress: (options, task) => {
        const dead = deadReject(`show progress "${options.title}"`);
        return dead ?? facades.notifications(window.get(NotificationService)).withProgress(options, task);
      },
    },
    undo: {
      // The undo facade stamps the owner and refuses a late call: the same code as for the UndoService token.
      push: (entry) => facades.undo(window.get(UndoService)).push(entry),
    },
    configuration: {
      get: (key) => window.get(ConfigurationService).get(key),
      onDidChange: (listener, options) => track('event', 'configuration.change', window.get(ConfigurationService).onDidChange(listener, options)),
    },
    experimental: Object.freeze({}),
  };

  // ----- services ------------------------------------------------------------------------------
  const reader = gatedReader(scope);
  const services: PluginServices = {
    get: <T>(token: Token<T>): T => reader.get(token),
    getOptional: <T>(token: Token<T>): T | undefined => reader.get(token, { optional: true }),
    provide: <T>(token: Token<T>, factory: Factory<T>, options?: Pick<ProvideOptions, 'lifetime' | 'intercept'>): IDisposable => {
      assertLive(`provide the service "${token.id}"`);
      if (!(manifest.provides ?? []).includes(token.id)) throw denied(pluginId, `provide the service "${token.id}": declare it in manifest provides`);
      // No shadowing: an id that the core (or any non-plugin owner) registers in this scope or an ancestor stays the core's.
      if (token.id.startsWith(CORE_TOKEN_PREFIX) || registeredByCore(token.id)) {
        throw denied(pluginId, `provide the service "${token.id}": the id is registered by the core, and a plugin cannot shadow a core service`);
      }
      // the factory is plugin code: inject() inside it follows the same rule as ctx.services.get
      return track('service', token.id, window.provide(token, () => runFiltered(filter, factory), { ...options, owner: pluginId }));
    },
    provideMany: <T>(token: MultiToken<T>, factory: Factory<T>, options?: Pick<ProvideOptions, 'lifetime'> & { readonly order?: number }): IDisposable => {
      assertLive(`contribute to the multi token "${token.id}"`);
      if (!(manifest.contributesTo ?? []).includes(token.id)) throw denied(pluginId, `contribute to "${token.id}": declare it in manifest contributesTo`);
      if (token.id.startsWith(CORE_TOKEN_PREFIX)) throw denied(pluginId, `contribute to "${token.id}": the id belongs to the core`);
      return track('contribution', token.id, window.provideMany(token, () => runFiltered(filter, factory), { ...options, owner: pluginId }));
    },
    getAll: <T>(token: MultiToken<T>): readonly T[] => reader.getAll(token),
    observeAll: <T>(token: MultiToken<T>): Observable<readonly T[]> => {
      const current = state<readonly T[]>(reader.getAll(token), { name: `plugin.observeAll:${token.id}` });
      // the subscription is a registration of the plugin: it ends with it
      track('subscription', `observeAll:${token.id}`, scope.onDidChangeAll(token)(() => {
        if (!closed) current.set(reader.getAll(token));
      }));
      return current.asReadonly();
    },
  };

  // ----- interceptors --------------------------------------------------------------------------
  const declaration = (id: string): InterceptorContribution => {
    const found = window
      .get(ContributionRegistry)
      .get(interceptorsPoint)
      .peek()
      .find((c) => c.pluginId === pluginId && c.value.id === id);
    if (!found) throw new TesseraError('plugin.undeclaredInterceptor', `Interceptor "${id}" is not declared in contributes.interceptors of "${pluginId}"`, { details: { pluginId, id } });
    return found.value;
  };

  /** Observing the internals of the platform (service calls, storage writes, RPC, activation) needs the capability `interceptors.observe`. */
  const requireObserve = (id: string, kinds: readonly string[]): void => {
    const sensitive = kinds.filter((kind) => (OBSERVE_CAPABILITY_KINDS as readonly string[]).includes(kind));
    if (sensitive.length > 0 && !capabilities.has('interceptors.observe')) {
      throw denied(pluginId, `register the interceptor "${id}" for ${sensitive.join(', ')}: capability "interceptors.observe" is missing`);
    }
  };

  /** A guard that takes more than 5 s before it decides is reported once (the user sees a slow command and can find the cause). */
  const slowGuardReport = (id: string, intercept: Interceptor['intercept']): Interceptor['intercept'] => {
    let reported = false;
    return (ictx, next) => {
      const timer = getScheduler().timeout(() => {
        if (reported) return;
        reported = true;
        reportError(new TesseraError('interceptor.slowGuard', `The guard "${id}" of plugin "${pluginId}" has not decided after ${SLOW_GUARD_MS} ms for "${ictx.target}"`, { details: { pluginId, id, target: ictx.target } }), {
          source: 'interceptor',
          pluginId,
          target: ictx.target,
        });
      }, SLOW_GUARD_MS);
      const result = intercept(ictx, (nextCtx) => (timer.dispose(), next(nextCtx)));
      return Promise.resolve(result).finally(() => timer.dispose());
    };
  };

  const ctx: PluginContext = {
    id: pluginId,
    version: manifest.version,
    manifest,
    activationReason: reason,
    api,
    subscriptions: store,
    signal: abort.signal,
    logger,
    storage: { application: pluginStorage(window, 'application', pluginId), project: pluginStorage(window, 'project', pluginId) },
    lifecycle: {
      onBeforeShutdown: (handler) => {
        assertLive('register a quit veto');
        const lifecycle = window.get(LifecycleService);
        // Every veto of the plugin carries the id `plugin:<id>`; the handler is plugin code, so its throw is a veto too (the lifecycle service decides).
        return track('veto', pluginId, lifecycle.onBeforeShutdown((e) => handler({ reason: e.reason, veto: (value) => e.veto(value, `plugin:${pluginId}`) })));
      },
    },
    services,
    workItems: {
      get root(): PluginWorkItem {
        assertLive('get the root WorkItem');
        return facades.workItem(window.get(WorkItemService).root);
      },
      create: (id, options) => {
        assertLive(`create the WorkItem "${id}"`);
        return facades.workItem(window.get(WorkItemService).root).createChild(id, options);
      },
    },
    views: {
      registerProvider: (typed) => {
        const provider = typed as unknown as ViewProvider; // the typed signature is for the plugin author; the registry stores it untyped
        assertLive(`register the view provider "${provider.viewType}"`);
        const declared = (manifest.contributes?.['views'] ?? []).some((v) => (v as { id?: unknown }).id === provider.viewType);
        if (!declared) {
          throw new TesseraError('workbench.undeclaredView', `View type "${provider.viewType}" is not declared in contributes.views of "${pluginId}"`, { details: { pluginId, viewType: provider.viewType } });
        }
        // The factories run in the view or placement injection context of the workbench. The filter makes inject() obey the manifest.
        // The contexts a plugin's factories get carry a WorkItem without `scope` (PluginWorkItem), not the real one.
        const guarded: ViewProvider = Object.create(provider, {
          ...(provider.createViewModel
            ? {
                createViewModel: {
                  value: (vmCtx: Parameters<NonNullable<ViewProvider['createViewModel']>>[0]) =>
                    runFiltered(filter, () => provider.createViewModel?.(vmCtx.workItem ? { ...vmCtx, workItem: facades.workItem(vmCtx.workItem) } : vmCtx)),
                  enumerable: true,
                },
              }
            : {}),
          createPresenter: {
            value: (pCtx: Parameters<ViewProvider['createPresenter']>[0]) =>
              runFiltered(filter, () => provider.createPresenter(pCtx.workItem ? { ...pCtx, workItem: facades.workItem(pCtx.workItem) } : pCtx)),
            enumerable: true,
          },
        });
        return track('viewProvider', provider.viewType, window.get(ViewRegistry).registerProvider(guarded));
      },
    },
    interceptors: {
      register: (id, intercept) => {
        assertLive(`register the interceptor "${id}"`);
        const declared = declaration(id);
        const mode = declared.mode ?? 'observer';
        if (mode === 'guard' && !capabilities.has('interceptors.guard')) {
          throw denied(pluginId, `register the guard interceptor "${id}": capability "interceptors.guard" is missing`);
        }
        requireObserve(id, declared.kinds);
        // A plugin guard has a default ceiling (30 s) unless it is interactive; core guards are not wrapped here.
        const guardLimit = mode === 'guard' && declared.interactive !== true;
        const interceptor: Interceptor = {
          id: `${pluginId}:${id}`,
          ...(guardLimit ? { timeoutMs: PLUGIN_GUARD_CEILING_MS } : {}),
          kinds: declared.kinds,
          ...(declared.match !== undefined ? { match: declared.match } : {}),
          ...(declared.phase !== undefined ? { phase: declared.phase } : {}),
          ...(declared.order !== undefined ? { order: declared.order } : {}),
          mode,
          owner: pluginId,
          readOnlyData: true, // a plugin interceptor sees the data through a deep read-only view
          intercept: guardLimit ? slowGuardReport(id, intercept) : intercept,
        };
        return track('interceptor', id, window.get(InterceptorRegistry).register(interceptor));
      },
      registerObserver: (id, observe) => {
        assertLive(`register the observer "${id}"`);
        const declared = declaration(id);
        requireObserve(id, declared.kinds);
        const observer: SyncObserver = {
          id: `${pluginId}:${id}`,
          kinds: declared.kinds,
          ...(declared.match !== undefined ? { match: declared.match } : {}),
          ...(declared.order !== undefined ? { order: declared.order } : {}),
          owner: pluginId,
          readOnlyData: true,
          observe,
        };
        return track('observer', id, window.get(InterceptorRegistry).registerObserver(observer));
      },
    },
    contributions: {
      definePoint: (point, handler) => {
        if (RESERVED_POINT_IDS.has(point.id)) throw denied(pluginId, `define the contribution point "${point.id}": the id is reserved by the core`);
        assertLive(`define the contribution point "${point.id}"`);
        const registry = window.get(ContributionRegistry) as ContributionRegistryType & {
          addProblem?: (id: string, problem: string) => void;
          declaredPointOwner?: (id: string) => string | undefined;
        };
        // A plugin defines only a point it declares in manifest contributionPoints (consumers wait for the declared id, so an undeclared
        // definer would receive their data), and only the best-ranked declarer of an id may define it, whatever the activation order.
        if (!(manifest.contributionPoints ?? []).some((p) => p.id === point.id)) {
          throw new TesseraError('plugin.undeclaredPoint', `Contribution point "${point.id}" is not declared in contributionPoints of "${pluginId}"`, { details: { pluginId, pointId: point.id } });
        }
        // A clash is a problem in the plugin's status, not an exception out of activate().
        const declaredOwner = registry.declaredPointOwner?.(point.id);
        if (registry.points().some((p) => p.id === point.id) || (declaredOwner !== undefined && declaredOwner !== pluginId)) {
          registry.addProblem?.(pluginId, `plugin.duplicateContribution: contribution point "${point.id}" is already ${declaredOwner !== undefined && declaredOwner !== pluginId ? `declared by "${declaredOwner}"` : 'defined'}; this definition is ignored`);
          return toDisposable(() => undefined);
        }
        return track('point', point.id, registry.definePoint(point, handler));
      },
      get: (point) => window.get(ContributionRegistry).get(point),
    },
  };

  return {
    description,
    scope,
    store,
    abort,
    ctx,
    live,
    workItems,
    get closed(): boolean {
      return closed;
    },
    set closed(value: boolean) {
      closed = value;
    },
    activated: false,
    undo,
    module: undefined,
    adoptWorkItem,
    viewServices: (base) => gatedReader(base),
    viewContext: (contextScope) => facades.viewContextScope(contextScope),
  };
}

function createNullLogger(name: string): Logger {
  const noop = (): void => {};
  const logger: Logger = { name, trace: noop, debug: noop, info: noop, warn: noop, error: noop, child: (n) => createNullLogger(`${name}.${n}`) };
  return logger;
}

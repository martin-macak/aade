import type { DisposableStore, Event, IAsyncDisposable, IDisposable, Logger, Schema, SerializedError, StateSchema } from '@tessera/base';
import type { Factory, MultiToken, ProvideOptions, Token } from '@tessera/di';
import { token } from '@tessera/di';
import type { Interceptor, InterceptorMode, InterceptorPhase, InvocationKind, SyncObserver } from '@tessera/interceptors';
import type { Observable } from '@tessera/reactive';
import type { CommandDef, CommandHandler, ExecuteOptions } from './commands.ts';
import type { ContextValue } from './context-keys.ts';
import type { EventHandler, SubscribeOptions, Topic } from './events.ts';
import type { PlacementId, PlacementRef, PluginState, RendererId } from './ids.ts';
import type { KeybindingRule } from './keybindings.ts';
import type { ShutdownReason } from './lifecycle.ts';
import type { MenuItemRule } from './menus.ts';
import type { Memento } from './storage.ts';
import type { UndoEntry } from './undo.ts';
import type { PluginWorkItem, PluginWorkItemOptions } from './workitems.ts';
import type { ConfirmOptions, InputOptions, NotificationInit, ProgressOptions, ProgressReporter, QuickPickItem, QuickPickOptions, ShowViewOptions, ViewDescriptor, ViewProvider } from './workbench.ts';

// contracts.md section 14: plugins and contribution points.

/** The semver-covered version of the plugin API. `engines.tessera` is checked against it (see deviations.md). */
export const TESSERA_API_VERSION = '1.0.0';

export type PluginHostKind = 'in-process' | 'utility' | 'worker';
export type PluginTrust = 'first-party' | 'trusted' | 'isolated';

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly engines: { readonly tessera: string };
  readonly main?: string;
  readonly ui?: Readonly<Record<RendererId, string>>;
  readonly host?: PluginHostKind;
  readonly trust?: PluginTrust;
  readonly activationEvents?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly requires?: readonly string[];
  readonly optional?: readonly string[];
  readonly provides?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly apiProposals?: readonly string[];
  /**
   * Contribution points this plugin defines in code (`ctx.contributions.definePoint`). Declared here so that other plugins can contribute
   * to them while this plugin is not loaded: the Ready check does not call a declared point unknown, and the entries wait until the
   * point is defined (a consumer does not activate the definer).
   */
  readonly contributionPoints?: ReadonlyArray<{ readonly id: string; readonly description?: string }>;
  readonly contributes?: Readonly<Record<string, readonly unknown[]>>;
  /**
   * Multi tokens this plugin contributes to with `ctx.services.provideMany` (IntelliJ extension points, Theia ContributionProvider). Declared here
   * so the resolver can order the contributors before the plugins that read them with `getAll` (an optional edge: a missing contributor is no error).
   */
  readonly contributesTo?: readonly string[];
  /**
   * Reserved for localization (no effect in v1). The shape is open: a later minor version reads it. A title written as `%key%` is a
   * localization key (see isLocalizationKey): v1 shows it as written.
   */
  readonly l10n?: unknown;
}

/** The point ids that core reserves for later (themes and icons). A plugin cannot define or declare them in v1. */
export const RESERVED_POINT_IDS: ReadonlySet<string> = new Set(['themes', 'icons']);

/** `%some.key%` in a manifest string is a localization key. v1 does not translate; the syntax is reserved so a later version can. */
export function isLocalizationKey(text: string): boolean {
  return /^%[A-Za-z0-9_.-]+%$/.test(text);
}

// ----- contribution points ---------------------------------------------------------------------

export interface ContributionPoint<T> {
  /** The key under manifest 'contributes'. */
  readonly id: string;
  readonly schema: Schema<T>;
  readonly description: string | undefined;
  /** Activation events implied by one entry: commands give 'onCommand:<id>'. */
  readonly activationEvents: ((entry: T) => readonly string[]) | undefined;
  /** The identifier an entry claims; the first installed plugin owns it (see defineContributionPoint). */
  readonly identity: ((entry: T) => string | undefined) | undefined;
}

export function defineContributionPoint<T>(
  id: string,
  schema: Schema<T>,
  options?: {
    readonly description?: string;
    readonly activationEvents?: (entry: T) => readonly string[];
    /**
     * The identifier an entry claims (a command id, a view type, a setting key). The first plugin that is installed owns an id: a
     * later plugin with the same id gets the problem `plugin.duplicateContribution` and that entry is dropped (contracts.md 14.2).
     */
    readonly identity?: (entry: T) => string | undefined;
  },
): ContributionPoint<T> {
  return Object.freeze({ id, schema, description: options?.description, activationEvents: options?.activationEvents, identity: options?.identity });
}

export interface Contribution<T> {
  readonly pluginId: string;
  readonly pointId: string;
  readonly index: number;
  readonly value: T;
}

export interface ContributionHandler<T> {
  /** Applies one entry. The returned disposable undoes it. */
  apply(contribution: Contribution<T>): IDisposable;
  /**
   * Optional batch form. The registry calls it once per plugin and point with all entries that passed validation and ownership, inside one
   * transaction, instead of calling `apply` per entry. It returns one result per entry in the same order: the disposable that undoes the
   * entry, or an Error that drops only that entry (a `plugin.duplicateContribution` TesseraError becomes a problem, like a throw from apply).
   * A handler that publishes state per application (a map copy, a version bump) implements it to publish once.
   */
  applyAll?(contributions: readonly Contribution<T>[]): ReadonlyArray<IDisposable | Error>;
}

export interface ContributionRegistry {
  definePoint<T>(point: ContributionPoint<T>, handler?: ContributionHandler<T>): IDisposable;
  get<T>(point: ContributionPoint<T>): Observable<readonly Contribution<T>[]>;
  points(): readonly ContributionPoint<unknown>[];
  /** Declared events of the manifest plus events derived from its entries and from provides. */
  activationEvents(pluginId: string): readonly string[];
  readonly onDidChange: Event<{ readonly pointId: string }>;
}
export const ContributionRegistry: Token<ContributionRegistry> = token<ContributionRegistry>('tessera.contributions');

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly description?: string;
  readonly enablement?: string;
  readonly palette?: boolean;
  /** The owner accepts contextual handlers from other plugins (each with a `when` clause). Without it a foreign handler needs `commands.override`. */
  readonly extensible?: boolean;
}
export type MenuItemContribution = Omit<MenuItemRule, 'owner'>;
export type KeybindingContribution = Omit<KeybindingRule, 'source' | 'owner'>;
export interface StatusBarContribution {
  readonly id: string;
  readonly alignment: 'left' | 'right';
  readonly priority?: number;
  readonly text: string;
  readonly tooltip?: string;
  readonly command?: string;
  readonly when?: string;
}
export interface WorkspaceContribution {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly kind: 'tabs' | 'accordion';
  readonly part: 'primarySideBar' | 'secondarySideBar' | 'panel';
  readonly order?: number;
  readonly when?: string;
}
export type ViewContribution = Omit<ViewDescriptor, 'owner'>;
export interface InterceptorContribution {
  readonly id: string;
  readonly kinds: readonly InvocationKind[];
  readonly match?: string;
  readonly phase?: InterceptorPhase;
  readonly order?: number;
  readonly mode?: InterceptorMode;
  /**
   * Guards only. A plugin guard that has not decided after 30 s fails the invocation (interceptor.guardTimeout), and one that takes more
   * than 5 s is reported once (interceptor.slowGuard). `interactive: true` lifts both: the guard waits for the user (a confirm dialog).
   */
  readonly interactive?: boolean;
  readonly description?: string;
}
export interface ConfigurationContribution {
  /** 'sample.faulty.failOnActivate' */
  readonly key: string;
  readonly type: 'string' | 'number' | 'boolean' | 'enum';
  readonly default: string | number | boolean;
  readonly enum?: readonly string[];
  readonly description?: string;
  /** Mirror as context key 'config.<key>'. */
  readonly context?: boolean;
}

// ----- runtime state ---------------------------------------------------------------------------

export type FailureCause = 'loadFailed' | 'activateThrew' | 'activateTimeout' | 'dependencyFailed' | 'hostExited';
export type PluginSource = 'builtin' | 'user' | 'dev';

/**
 * The capabilities that need a host decision. `service:<tokenId>` opens a service that the host offers to plugins (HostPluginService).
 * `fs.read`, `fs.write`, `process.spawn`, `pty`, `secrets` and `http` are reserved names: known to the manifest check, never granted by the default
 * policy, and backed by no service yet (the platform services stay deferred; a product host gives them through HostPluginService).
 */
export const KNOWN_CAPABILITY: RegExp = /^(interceptors\.guard|interceptors\.observe|commands\.force|commands\.override|context\.global|configuration\.writeForeign|workbench\.layout|fs\.read|fs\.write|process\.spawn|pty|secrets|http|service:.+)$/;

/**
 * The host's decision about what a plugin may do (contracts.md 14.7). `grant` returns the capabilities the plugin gets: the runtime
 * uses requested ∩ granted, and a refused capability shows in PluginStatus.problems. The default grants a builtin or dev plugin what it
 * declares and a user plugin no elevated capability. A host (ApplicationOptions.pluginPolicy) can ask the user, check a publisher
 * signature, or read an enterprise policy.
 */
export interface PluginPolicy {
  grant(description: PluginDescription): ReadonlySet<string>;
}
export const PluginPolicy: Token<PluginPolicy> = token<PluginPolicy>('tessera.pluginPolicy');

/**
 * A service that the host product offers to plugins (a git service, a project service). It is a public token for the plugins that hold
 * `capability` (or for all when there is none): `requires` resolves without a plugin provider, the gate lets the plugin read it, and
 * `facade` can wrap the value per plugin (attribution, tracking). ApplicationOptions.pluginServices fills the list.
 */
export interface HostPluginService<T = unknown> {
  readonly token: Token<T>;
  /** Capability that a plugin needs to read the service, for example `service:acme.app/GitService`. Absent: every plugin may read it. */
  readonly capability?: string;
  /** Wraps the value for one plugin. Absent: the plugin gets the value as it is. */
  readonly facade?: (pluginId: string) => (value: T) => T;
}
export const HostPluginServices: Token<readonly HostPluginService[]> = token<readonly HostPluginService[]>('tessera.hostPluginServices');

export interface PluginDescription {
  readonly manifest: PluginManifest;
  /** Base URL of the plugin folder: 'app://plugins/acme.tasks/' in Electron, a module map key in tests. */
  readonly location: string;
  readonly source: PluginSource;
  /**
   * When the plugin was installed (ms since the epoch), if the catalog knows. Install precedence for a plugin id that two folders offer is
   * builtin, then dev, then user; inside a source the earlier installedAt wins, then the lower id order. A plugin without a date ranks by
   * the order the manager first saw it, and keeps that rank across updates.
   */
  readonly installedAt?: number;
}

export interface PluginStatus {
  readonly id: string;
  readonly version: string;
  readonly state: PluginState;
  readonly source: PluginSource;
  readonly host: PluginHostKind;
  readonly trust: PluginTrust;
  readonly activationEvents: readonly string[];
  readonly activationReason: string | undefined;
  readonly activationTimeMs: number | undefined;
  readonly failure: { readonly cause: FailureCause; readonly error: SerializedError; readonly count: number } | undefined;
  /** Validation errors, unresolved dependencies, skipped contributions. */
  readonly problems: readonly string[];
}

/** Port: discovery. */
export interface PluginCatalog {
  list(): Promise<readonly PluginDescription[]>;
  readonly onDidChange: Event<void>;
}
export const PluginCatalog: Token<PluginCatalog> = token<PluginCatalog>('tessera.pluginCatalog');

/** Port: loads an entry and returns the ES module namespace. */
export interface PluginLoader {
  load(description: PluginDescription, entry: 'main' | RendererId): Promise<unknown>;
}
export const PluginLoader: Token<PluginLoader> = token<PluginLoader>('tessera.pluginLoader');

export interface ActivationService {
  /** Activates every resolved plugin that listens to the event, plus dependencies. Resolves when all settled. Never rejects. */
  activateByEvent(event: string): Promise<void>;
  isActive(pluginId: string): boolean;
}
export const ActivationService: Token<ActivationService> = token<ActivationService>('tessera.activation');

export interface PluginManager extends ActivationService {
  readonly plugins: Observable<ReadonlyMap<string, PluginStatus>>;
  status(id: string): PluginStatus | undefined;
  add(descriptions: readonly PluginDescription[]): Promise<void>;
  /** reason 'uninstall' (default) or 'update' (a new version of the plugin replaces it). */
  remove(id: string, reason?: Extract<DeactivateReason, 'uninstall' | 'update'>): Promise<void>;
  /** Rejects with TesseraError 'plugin.activationFailed' (or the cause code). */
  activate(id: string, reason?: string): Promise<void>;
  /** reason: why the plugin ends (passed to PluginModule.deactivate). Default 'disable'. */
  deactivate(id: string, reason?: DeactivateReason): Promise<void>;
  /**
   * Shutdown: deactivates every active plugin in reverse dependency waves (parallel inside a wave) within `deadline` (scheduler.now() clock).
   * After the deadline no new deactivate() starts: the plugin is only cleaned up, and listed in `notStarted`. A deactivate() that overruns its share is listed in `timedOut`. Stops accepting activations
   * (`plugin.shuttingDown`) once abortAll() ran.
   */
  deactivateAll(options?: { readonly deadline?: number }): Promise<{ readonly notStarted: readonly string[]; readonly timedOut: readonly string[] }>;
  /** Closes the activation gate and aborts `ctx.signal` of every running plugin. The plugins shutdown step calls it when the gate closes. */
  abortAll(): void;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  readonly onDidChangeState: Event<PluginStatus>;
}
export const PluginManager: Token<PluginManager> = token<PluginManager>('tessera.pluginManager');

export interface PluginHost extends IAsyncDisposable {
  readonly id: string;
  readonly kind: PluginHostKind;
  readonly state: Observable<'starting' | 'ready' | 'unresponsive' | 'exited'>;
  activate(description: PluginDescription, reason: string): Promise<void>;
  deactivate(pluginId: string, reason?: DeactivateReason): Promise<void>;
  readonly onDidExit: Event<{ readonly code: number | null }>;
}

// ----- module and context ----------------------------------------------------------------------

/** Why a plugin ends. A plugin can skip work that only matters when the app goes on (and do work that only matters when it is gone). */
export type DeactivateReason = 'shutdown' | 'disable' | 'reload' | 'uninstall' | 'update';

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  /** reason is additive (a plugin written for v1 ignores it). */
  deactivate?(reason?: DeactivateReason): void | Promise<void>;
}

export interface PluginStorage {
  get<T>(key: string, schema: StateSchema<T>): T;
  set<T>(key: string, value: T, schema: StateSchema<T>): void;
  delete(key: string): void;
  keys(): readonly string[];
  memento<T>(key: string, schema: StateSchema<T>): Memento<T>;
}

/** What a plugin sees of the quit veto step. The veto id is `plugin:<pluginId>`. */
export interface PluginBeforeShutdownEvent {
  readonly reason: ShutdownReason;
  /** true or a promise of true vetoes the quit (for example: unsaved work). A rejected promise counts as a veto. The user's "quit anyway" (force) ends the wait. */
  veto(value: boolean | Promise<boolean>): void;
}

export interface PluginLifecycle {
  /** Registers a quit veto. Removed when the plugin deactivates, like any registration of the plugin (I22). */
  onBeforeShutdown(handler: (e: PluginBeforeShutdownEvent) => void): IDisposable;
}

/** What a plugin receives in `activate(ctx)`: one context for the one host of version 1 (the renderer). */
export interface PluginContext {
  readonly id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  readonly activationReason: string;
  readonly api: TesseraApi;
  /** Like VS Code's context.subscriptions. Disposed in reverse order on deactivation. */
  readonly subscriptions: DisposableStore;
  /** Aborts when deactivation starts. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly storage: { readonly application: PluginStorage; readonly project: PluginStorage };
  readonly lifecycle: PluginLifecycle;
  // The members below hold live objects (services, WorkItems, view providers). Version 1 has one host, the renderer, so they belong to the
  // one context. Members that could cross a process boundary later are marked in contracts.md 14.7; a remote context is a v2 addition.
  readonly services: PluginServices;
  readonly workItems: {
    /** The window root WorkItem, without its DI scope. Children created below it are owned by this plugin. */
    readonly root: PluginWorkItem;
    /** Child of the window root WorkItem. Owner is this plugin: terminated on deactivation. */
    create(id: string, options?: PluginWorkItemOptions): PluginWorkItem;
  };
  readonly views: {
    /** viewType must be declared in contributes.views by this plugin. */
    registerProvider<VM, S, I, Sh, L>(provider: ViewProvider<VM, S, I, Sh, L>): IDisposable;
  };
  readonly interceptors: {
    /** id must be declared in contributes.interceptors. */
    register(id: string, intercept: Interceptor['intercept']): IDisposable;
    registerObserver(id: string, observe: SyncObserver['observe']): IDisposable;
  };
  readonly contributions: {
    definePoint<T>(point: ContributionPoint<T>, handler?: ContributionHandler<T>): IDisposable;
    get<T>(point: ContributionPoint<T>): Observable<readonly Contribution<T>[]>;
  };
}

/** Narrow DI facade. Plugins never get the container itself. */
export interface PluginServices {
  /** Tokens in manifest requires or optional, or in PublicTokens. Others throw 'plugin.capabilityDenied'. */
  get<T>(token: Token<T>): T;
  getOptional<T>(token: Token<T>): T | undefined;
  /**
   * Tokens in manifest provides only. Registered in the window DI scope, owner = plugin id. The factory runs in an
   * injection context that follows the same rule as get(): inject() of an undeclared token throws.
   */
  provide<T>(token: Token<T>, factory: Factory<T>, options?: Pick<ProvideOptions, 'lifetime' | 'intercept'>): IDisposable;
  /**
   * Contributes one value to a multi token (an extension point in code, like IntelliJ extension points or Theia contribution providers).
   * The token id must be in the manifest `contributesTo`. Many plugins may contribute to one token. Registered in the window DI scope, owner = plugin id.
   */
  provideMany<T>(token: MultiToken<T>, factory: Factory<T>, options?: Pick<ProvideOptions, 'lifetime'> & { readonly order?: number }): IDisposable;
  /**
   * Every contribution to a multi token, from all plugins that are active now. The token id must be in the manifest `requires` or `optional`
   * (or be public). The resolver orders the contributors before this plugin (an optional edge: a missing or disabled contributor is no error).
   */
  getAll<T>(token: MultiToken<T>): readonly T[];
  /**
   * Like getAll(), but live: a snapshot (getAll) never changes, this observable follows the contributors. It re-reads when a plugin adds or
   * removes a contribution (a later contributor appears, a disabled one disappears). The subscription ends with the plugin.
   */
  observeAll<T>(token: MultiToken<T>): Observable<readonly T[]>;
}

export interface TesseraApi {
  /** Version of @tessera/plugin-api. */
  readonly version: string;
  readonly commands: {
    registerHandler<A, R>(id: string, handler: CommandHandler<A, R>): IDisposable;
    /** Typed registration: the id and the argument schema come from the `defineCommand` handle, and the handler's types follow it. */
    registerHandler<A, R>(command: CommandDef<A, R>, handler: Omit<CommandHandler<A, R>, 'args'>): IDisposable;
    execute<R = unknown>(id: string, args?: unknown, options?: { readonly signal?: AbortSignal }): Promise<R>;
    /** Typed execute: the argument and result types come from the `defineCommand` handle. */
    run<A, R>(command: CommandDef<A, R>, args: A, options?: { readonly signal?: AbortSignal }): Promise<R>;
  };
  readonly events: {
    /** Publishes on the application node, publish scope global. */
    publish<T>(topic: Topic<T>, payload: T): void;
    subscribe<T>(topic: Topic<T>, handler: EventHandler<T>, options?: Omit<SubscribeOptions<T>, 'owner'>): IDisposable;
  };
  readonly context: {
    /** Application context-key scope. Key must start with '<pluginId>.' unless capability 'context.global'. */
    set(key: string, value: ContextValue): void;
  };
  readonly workbench: {
    showView(viewType: string, options?: Omit<ShowViewOptions, 'workItem'>): Promise<PlacementRef>;
    closePlacement(id: PlacementId): Promise<boolean>;
    readonly onDidChangeFocus: Event<PlacementRef | undefined>;
  };
  readonly window: {
    notify(notification: NotificationInit): IDisposable;
    /** Asks the user to confirm. false when declined or when the plugin ends (the dialog closes with it). */
    confirm(options: Omit<ConfirmOptions, 'signal'>): Promise<boolean>;
    /** Asks the user for a text. undefined when cancelled or when the plugin ends. */
    input(options: Omit<InputOptions, 'signal'>): Promise<string | undefined>;
    /** Shows a progress notification while `task` runs. `progress.signal` aborts on user cancel or when the plugin ends. */
    withProgress<T>(options: ProgressOptions, task: (progress: ProgressReporter) => Promise<T>): Promise<T>;
    pick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined>;
  };
  readonly undo: { push(entry: UndoEntry): void };
  readonly configuration: {
    get<T extends string | number | boolean>(key: string): T | undefined;
    readonly onDidChange: Event<{ readonly keys: readonly string[] }>;
  };
  /** Only the namespaces named in manifest apiProposals. Not covered by semver. */
  readonly experimental: Readonly<Record<string, unknown>>;
}

/** Re-exported helper type so plugins can type `ExecuteOptions` without a deep import. */
export type { ExecuteOptions };

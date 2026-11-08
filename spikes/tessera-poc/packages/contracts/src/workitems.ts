import type { Event, IDisposable, StateSchema } from '@tessera/base';
import type { Observable } from '@tessera/reactive';
import { token, type Factory, type ProvideOptions, type Scope, type Token } from '@tessera/di';
import type { ContextKeyScope, PluginContextKeyScope } from './context-keys.ts';
import type { EventNode } from './events.ts';
import type { Memento } from './storage.ts';

export const WorkItemStatus = { Active: 'active', Inactive: 'inactive', Terminated: 'terminated' } as const;
export type WorkItemStatus = (typeof WorkItemStatus)[keyof typeof WorkItemStatus];

export interface WorkItemController {
  /** SCSF ControlledWorkItem. Runs once inside the WorkItem's injection context, after services are registered. */
  start(workItem: WorkItem): void | Promise<void>;
  onActivate?(): void;
  onDeactivate?(): void;
}

export interface WorkItemOptions {
  /** Registers services in the new DI scope before anything resolves from it. */
  readonly services?: (scope: Scope) => void;
  readonly controller?: WorkItemController;
  /** Default false. */
  readonly activate?: boolean;
  /**
   * Plugin id. The plugin runtime terminates every WorkItem whose owner is that plugin when it deactivates, whichever API
   * created it (it watches WorkItemService.onDidCreate). Plugin code cannot set it: the runtime stamps it.
   */
  readonly owner?: string;
}

/** What a plugin may register in a new WorkItem scope. Not a Scope: no get(), no createChild(), no dispose(). */
export interface ScopeRegistrar {
  /** The token must be in the manifest `provides`. The factory runs under the plugin's injection filter. */
  provide<T>(token: Token<T>, factory: Factory<T>, options?: Pick<ProvideOptions, 'lifetime' | 'intercept'>): IDisposable;
  /** The token must be in the manifest `provides`. */
  provideValue<T>(token: Token<T>, value: T): IDisposable;
}

export interface PluginWorkItemController {
  /** Runs once in the WorkItem's injection context, under the plugin's injection filter. */
  start(workItem: PluginWorkItem): void | Promise<void>;
  onActivate?(): void;
  onDeactivate?(): void;
}

/** WorkItemOptions as a plugin sees them: `owner` is stamped by the runtime, `services` gets a ScopeRegistrar. */
export interface PluginWorkItemOptions {
  readonly services?: (registrar: ScopeRegistrar) => void;
  readonly controller?: PluginWorkItemController;
  /** Default false. */
  readonly activate?: boolean;
}

/**
 * A WorkItem without its DI scope: the only WorkItem type plugin code gets (ctx.workItems, ViewModelContext.workItem,
 * PresenterContext.workItem and, at run time, every WorkItem that WorkItemService and the WorkbenchService hand out).
 * A scope would be a back door to the whole container (contracts 14.6). Every WorkItem the plugin creates through it is
 * owned by the plugin. A plugin may terminate only a WorkItem it owns.
 */
export interface PluginWorkItem {
  readonly id: string;
  readonly path: string;
  readonly parent: PluginWorkItem | undefined;
  /** A node facade: subscribe and on are tracked and end with the plugin. No dispose, no internals. */
  readonly events: EventNode;
  /** A scope facade without dispose and createChild (PluginContextKeyScope). */
  readonly context: PluginContextKeyScope;
  readonly status: Observable<WorkItemStatus>;
  readonly children: Observable<readonly PluginWorkItem[]>;
  readonly owner: string | undefined;
  /** Throws 'workItem.duplicate' if a child with this id exists, 'plugin.deactivated' after the plugin ended. */
  createChild(id: string, options?: PluginWorkItemOptions): PluginWorkItem;
  child(id: string): PluginWorkItem | undefined;
  /** Throws 'plugin.capabilityDenied' for a WorkItem that another owner created (the root included). */
  activate(): void;
  /** Throws 'plugin.capabilityDenied' for a WorkItem that another owner created (the root included). */
  deactivate(): void;
  /** Throws 'plugin.capabilityDenied' for a WorkItem that another owner created (the root included). */
  terminate(): Promise<void>;
  memento<T>(key: string, schema: StateSchema<T>): Memento<T>;
}

/** What a plugin gets for the WorkItemService token: the same service, but every WorkItem is a PluginWorkItem (no `scope`). */
export interface PluginWorkItemService {
  readonly root: PluginWorkItem;
  find(path: string): PluginWorkItem | undefined;
  readonly active: Observable<PluginWorkItem | undefined>;
  readonly onDidCreate: Event<PluginWorkItem>;
  readonly onDidTerminate: Event<PluginWorkItem>;
}

export interface WorkItem {
  /** Unique among siblings. Pattern /^[a-z0-9][a-z0-9.-]*$/. */
  readonly id: string;
  /** 'root/tasks/project-42'. Stable: used for mementos and view instance ownership. */
  readonly path: string;
  readonly parent: WorkItem | undefined;
  /** Kind 'workItem' (the root WorkItem: the window DI scope). Core code only: plugins get a PluginWorkItem, which has none. */
  readonly scope: Scope;
  readonly events: EventNode;
  readonly context: ContextKeyScope;
  readonly status: Observable<WorkItemStatus>;
  readonly children: Observable<readonly WorkItem[]>;
  readonly owner: string | undefined;

  /** Throws 'workItem.duplicate' if a child with this id exists. */
  createChild(id: string, options?: WorkItemOptions): WorkItem;
  child(id: string): WorkItem | undefined;
  activate(): void;
  deactivate(): void;
  /**
   * Children first, then the WorkItem's event node, context-key scope and DI scope. Idempotent. The mementos it handed out are released.
   * Its stored state (`workItem:<path>:*`) stays, because plugin deactivation and shutdown end WorkItems too and the next session restores
   * from it; `discardState: true` (an owner who deletes the use case for good) deletes those keys, for the children as well.
   */
  terminate(options?: { readonly discardState?: boolean }): Promise<void>;
  /** CAB [State]. Stored in the project storage scope under 'workItem:<path>:<key>'. */
  memento<T>(key: string, schema: StateSchema<T>): Memento<T>;
}

export interface WorkItemService {
  readonly root: WorkItem;
  /** By path, for example 'root/tasks'. */
  find(path: string): WorkItem | undefined;
  /** The deepest active WorkItem. */
  readonly active: Observable<WorkItem | undefined>;
  readonly onDidCreate: Event<WorkItem>;
  readonly onDidTerminate: Event<WorkItem>;
}
export const WorkItemService: Token<WorkItemService> = token<WorkItemService>('tessera.workItems');
/** The WorkItem that owns the resolving DI scope. Provided in the window scope (root) and every workItem scope. */
export const CurrentWorkItem: Token<WorkItem> = token<WorkItem>('tessera.currentWorkItem');

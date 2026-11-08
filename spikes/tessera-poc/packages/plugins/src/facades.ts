import { toDisposable, type Event, type IDisposable, type ListenOptions, type TesseraError } from '@tessera/base';
import {
  CommandService,
  ConfigurationService,
  NotificationService,
  StatusBarService,
  WorkbenchService as WorkbenchServiceToken,
  WorkItemService as WorkItemServiceToken,
  type ContextKey,
  type PlacementId,
  type ContextKeyService,
  type ContextKeyScope,
  type ContextValue,
  type EventHandler,
  type EventNode,
  type PluginContextKeyScope,
  type PluginContextKeyService,
  type PluginWorkItemService,
  type PluginWorkbenchService,
  type PlacementView,
  type ViewInstanceView,
  type PublishOptions,
  type SubscribeOptions,
  type Topic,
  type Placement,
  type PluginWorkItem,
  type PluginWorkItemController,
  type PluginWorkItemOptions,
  type ScopeRegistrar,
  type DialogService,
  type UndoService,
  type ViewInstance,
  type WorkbenchService,
  type WorkItem,
  type WorkItemController,
  type WorkItemOptions,
  type WorkItemService,
} from '@tessera/contracts';
import { runFiltered, type InjectionFilter, type Scope } from '@tessera/di';
import { computed, type Observable } from '@tessera/reactive';

/** What the facades need from the runtime of one plugin. */
export interface FacadeEnv {
  readonly pluginId: string;
  /** Token ids from the manifest `provides`. */
  readonly provides: ReadonlySet<string>;
  readonly filter: InjectionFilter;
  /** Capability `context.global`: context keys of scopes the plugin does not own need no plugin-id prefix. */
  readonly mayGlobalContext: boolean;
  /** Throws 'plugin.deactivated' once the plugin ended. */
  assertLive(what: string): void;
  /** The abort signal of the plugin (aborts when deactivation starts). */
  readonly signal: AbortSignal;
  /** Whether the plugin holds the (granted) capability. */
  has(capability: string): boolean;
  /** Whether the view type is declared by this plugin. */
  ownsViewType(viewType: string): boolean;
  /** Whether the setting key is declared in this plugin's manifest (contributes.configuration). */
  declaresSetting(key: string): boolean;
  denied(what: string): TesseraError;
  /** The installed plugin that owns a context key: the one with the longest id such that the key starts with `<id>.`. Undefined when none does. */
  ownerOfContextKey(name: string): string | undefined;
  track(kind: string, name: string, d: IDisposable): IDisposable;
}

export interface Facades {
  /** The plugin's view of a WorkItem: no `scope`, createChild stamps the owner. The same object for the same WorkItem. */
  workItem(raw: WorkItem | PluginWorkItem): PluginWorkItem;
  /** What a plugin gets for the WorkItemService token. */
  workItemService(real: WorkItemService): PluginWorkItemService;
  /** What a plugin gets for the WorkbenchService token: placement() and instance() return views without `scope`. */
  workbench(real: WorkbenchService): PluginWorkbenchService;
  /** What a plugin gets for the UndoService token: push() is stamped with the plugin id, invalidateOwner() is limited to it. */
  undo(real: UndoService): UndoService;
  /** What a plugin gets for the ConfigurationService token: update() writes only the settings the plugin declared, unless `configuration.writeForeign`. */
  configuration(real: ConfigurationService): ConfigurationService;
  /** What a plugin gets for the NotificationService token: notify() is stamped with the plugin id as source, withProgress ends with the plugin. */
  notifications(real: NotificationService): NotificationService;
  /** What a plugin gets for the DialogService token: a dialog closes when the plugin ends, and a dead context cannot open one. */
  dialog(real: DialogService): DialogService;
  /** What a plugin gets for the ContextKeyService token: `root` and `focused` are scope facades, setFocused() is refused. */
  contextKeyService(real: ContextKeyService): PluginContextKeyService;
  /**
   * Wraps a public service: the IDisposable that a registering member returns (every `on...` event, plus the members in
   * REGISTERING_MEMBERS) goes through `track`, so it ends with the plugin. A late call disposes the registration and throws.
   */
  tracked<T>(tokenId: string, value: T): T;
  /** The context-key scope as a plugin may see it (the facade of round 3: no dispose, no createChild). Used by the view door. */
  viewContextScope(raw: ContextKeyScope): ContextKeyScope;
  /** The plugin's view of an EventNode (publish carries the plugin id, refuses `tessera.` topics and late calls). The one home of the topic rule. */
  eventNode(raw: EventNode): EventNode;
}

/**
 * The members of the public services that register something and return an IDisposable. `tracked()` adopts their result.
 * Every member named `on` + capital letter counts as well, so a new event is covered without an entry here.
 * The test in plugin-gate.test.ts walks the public services and fails for a member that is neither listed here nor known as plain.
 */
export const REGISTERING_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  [CommandService.id]: new Set(['onDidExecute']),
  [WorkbenchServiceToken.id]: new Set(['createWorkspace']),
  [WorkItemServiceToken.id]: new Set(['onDidCreate', 'onDidTerminate']),
  [NotificationService.id]: new Set(['notify']),
  [ConfigurationService.id]: new Set(['onDidChange']),
  [StatusBarService.id]: new Set(['add']),
};

const isObservable = (value: unknown): value is Observable<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { get?: unknown }).get === 'function' &&
  typeof (value as { peek?: unknown }).peek === 'function' &&
  typeof (value as { subscribe?: unknown }).subscribe === 'function';

const isDisposable = (value: unknown): value is IDisposable =>
  typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function';

const PLACEMENT_FIELDS: ReadonlySet<string> = new Set<keyof Placement>(['id', 'viewType', 'instanceId', 'workspaceId', 'windowId', 'status', 'visible', 'focused', 'title', 'local', 'context', 'presenter', 'problem']);
const INSTANCE_FIELDS: ReadonlySet<string> = new Set<keyof ViewInstance>(['id', 'viewType', 'key', 'workItemPath', 'viewModel', 'shared', 'placements', 'refCount']);

/** A read-only view of `target` that shows only `allowed` members. The rest (scope, internals of the implementation) is absent. */
function allowlistView<T extends object>(target: T, allowed: ReadonlySet<string>, overrides: Readonly<Record<string, unknown>> = {}): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || !allowed.has(prop)) return undefined;
      if (prop in overrides) return overrides[prop];
      const member: unknown = Reflect.get(t, prop, t);
      return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(t) : member;
    },
    set: () => false,
    has: (_t, prop) => typeof prop === 'string' && allowed.has(prop),
    ownKeys: (t) => Reflect.ownKeys(t).filter((k) => typeof k === 'string' && allowed.has(k)),
    getOwnPropertyDescriptor: (t, prop) => (typeof prop === 'string' && allowed.has(prop) ? Reflect.getOwnPropertyDescriptor(t, prop) : undefined),
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/** Per-plugin facades over the objects that carry a DI scope or an owner (contracts 14.6). */
export function createFacades(env: FacadeEnv): Facades {
  const { pluginId } = env;
  const byRaw = new WeakMap<object, PluginWorkItem>();
  const facadeSet = new WeakSet<object>();
  const eventNodes = new WeakMap<object, EventNode>();
  const contextScopes = { owned: new WeakMap<object, PluginContextKeyScope>(), other: new WeakMap<object, PluginContextKeyScope>() };
  const trackedCache = new WeakMap<object, object>();
  const observableViews = new WeakMap<object, Observable<unknown>>();

  /**
   * The plugin's view of an Observable: reads are the same, but subscribe() is refused after the plugin ended and its
   * subscription ends with the plugin (invariant I22). One view per Observable.
   */
  function trackObservable<T>(raw: Observable<T>): Observable<T> {
    const known = observableViews.get(raw);
    if (known) return known as Observable<T>;
    const view: Observable<T> = {
      name: raw.name,
      get: () => raw.get(),
      peek: () => raw.peek(),
      subscribe: (listener) => {
        env.assertLive(`subscribe to "${raw.name ?? 'an observable'}"`);
        return env.track('subscription', raw.name ?? 'observable', raw.subscribe(listener));
      },
    };
    observableViews.set(raw, view);
    return view;
  }

  /** The plugin's view of an EventNode: subscribe() and on() are stamped with the owner, tracked and refused after the plugin ended. No dispose, no bus. */
  function eventNode(raw: EventNode): EventNode {
    const known = eventNodes.get(raw);
    if (known) return known;
    const facade: EventNode = {
      id: raw.id,
      get parent(): EventNode | undefined {
        return raw.parent === undefined ? undefined : eventNode(raw.parent);
      },
      publish: <T>(topic: Topic<T>, payload: T, options?: PublishOptions) => {
        env.assertLive(`publish to the topic "${topic.id}"`);
        if (topic.id.startsWith('tessera.')) throw env.denied(`publish to the core topic "${topic.id}"`);
        // The publication carries the plugin id (EventMeta.publisher), so a subscriber can tell who published.
        if (raw.publishAs) raw.publishAs(pluginId, topic, payload, options);
        else raw.publish(topic, payload, options);
      },
      subscribe: <T>(topic: Topic<T>, handler: EventHandler<T>, options?: SubscribeOptions<T>) => {
        env.assertLive(`subscribe to the topic "${topic.id}"`);
        return env.track('subscription', topic.id, raw.subscribe(topic, handler, { ...options, owner: pluginId }));
      },
      on: <T>(topic: Topic<T>, options?: SubscribeOptions<T>): Event<T> => {
        const event = raw.on(topic, { ...options, owner: pluginId });
        return (listener: (e: T) => void, listenOptions?: ListenOptions) => {
          env.assertLive(`subscribe to the topic "${topic.id}"`);
          return env.track('subscription', topic.id, event(listener, listenOptions));
        };
      },
    };
    eventNodes.set(raw, facade);
    return facade;
  }

  /**
   * The plugin's view of a context-key scope. `owned` is true for the scope of a WorkItem the plugin created: it ends with that
   * WorkItem, so any key name is fine and no reset is needed. On any other scope (the window, a foreign WorkItem, a placement)
   * a key must start with the plugin id unless `context.global` is granted, and the keys the plugin set are reset with it.
   */
  function contextScope(raw: ContextKeyScope, owned: boolean): PluginContextKeyScope {
    const cache = owned ? contextScopes.owned : contextScopes.other;
    const known = cache.get(raw);
    if (known) return known;
    const touched = new Set<string>();
    const mayWrite = (name: string): void => {
      env.assertLive(`set the context key "${name}"`);
      if (!owned && !env.mayGlobalContext) {
        // The longest installed plugin id that is a prefix owns the key: `acme.git` cannot write the keys of `acme.git.hub`.
        const keyOwner = env.ownerOfContextKey(name) ?? (name.startsWith(`${pluginId}.`) ? pluginId : undefined);
        if (keyOwner !== pluginId) {
          throw env.denied(
            keyOwner === undefined
              ? `set the context key "${name}" on the scope "${raw.id}": keys must start with "${pluginId}." unless capability "context.global" is granted`
              : `set the context key "${name}" on the scope "${raw.id}": the key belongs to the plugin "${keyOwner}" (the longest installed plugin id that is a prefix)`,
          );
        }
      }
    };
    const remember = (name: string): void => {
      if (owned || touched.has(name)) return;
      touched.add(name);
      env.track(
        'contextKey',
        name,
        toDisposable(() => {
          try {
            raw.set(name, undefined);
          } catch {
            // the scope ended before the plugin did: its keys are gone
          }
        }),
      );
    };
    const facade: PluginContextKeyScope = {
      id: raw.id,
      get parent(): PluginContextKeyScope | undefined {
        return raw.parent === undefined ? undefined : contextScope(raw.parent, false);
      },
      getValue: (name) => raw.getValue(name),
      createKey: <K extends string>(name: K, initial?: Parameters<ContextKeyScope['createKey']>[1]) => {
        mayWrite(name);
        const key = (raw as unknown as { createKey(n: string, i?: ContextValue): ContextKey<ContextValue> }).createKey(name, initial as ContextValue);
        remember(name);
        const guarded: ContextKey<ContextValue> = {
          name: key.name,
          get: () => key.get(),
          set: (value) => {
            env.assertLive(`set the context key "${name}"`);
            key.set(value);
          },
          reset: () => key.reset(),
        };
        return guarded as never;
      },
      set: (name, value) => {
        mayWrite(name);
        raw.set(name, value);
        remember(name);
      },
      evaluate: (when) => raw.evaluate(when),
      observe: (when) => trackObservable(raw.observe(when)),
      onDidChange: (listener, options) => env.track('event', `context.change:${raw.id}`, raw.onDidChange(listener, options)),
      bufferChanges: (fn) => raw.bufferChanges(fn),
      snapshot: () => raw.snapshot(),
    };
    cache.set(raw, facade);
    return facade;
  }

  const registrar = (scope: Scope): ScopeRegistrar => {
    const mayProvide = (tokenId: string): void => {
      env.assertLive(`provide the service "${tokenId}"`);
      if (!env.provides.has(tokenId)) throw env.denied(`provide the service "${tokenId}": declare it in manifest provides`);
    };
    return {
      provide: (token, factory, options) => {
        mayProvide(token.id);
        return scope.provide(token, () => runFiltered(env.filter, factory), { ...options, owner: pluginId });
      },
      provideValue: (token, value) => {
        mayProvide(token.id);
        return scope.provideValue(token, value, { owner: pluginId });
      },
    };
  };

  const controllerOf = (controller: PluginWorkItemController): WorkItemController => ({
    // start() runs in the WorkItem's injection context: the plugin's filter applies to its inject() calls
    start: (raw) => runFiltered(env.filter, () => controller.start(workItem(raw))),
    ...(controller.onActivate ? { onActivate: () => controller.onActivate?.() } : {}),
    ...(controller.onDeactivate ? { onDeactivate: () => controller.onDeactivate?.() } : {}),
  });

  const optionsOf = (options: PluginWorkItemOptions | undefined): WorkItemOptions => {
    // Read named fields only: a plugin that smuggles `owner` or a raw `services` through a cast gets neither.
    const services = options?.services;
    const controller = options?.controller;
    return {
      owner: pluginId,
      ...(options?.activate !== undefined ? { activate: options.activate } : {}),
      ...(services ? { services: (scope: Scope) => services(registrar(scope)) } : {}),
      ...(controller ? { controller: controllerOf(controller) } : {}),
    };
  };

  const optionalItem = (raw: WorkItem | undefined): PluginWorkItem | undefined => (raw === undefined ? undefined : workItem(raw));

  function workItem(input: WorkItem | PluginWorkItem): PluginWorkItem {
    if (facadeSet.has(input)) return input as PluginWorkItem;
    const raw = input as WorkItem;
    const cached = byRaw.get(raw);
    if (cached) return cached;
    let children: Observable<readonly PluginWorkItem[]> | undefined;
    const facade: PluginWorkItem = {
      id: raw.id,
      path: raw.path,
      owner: raw.owner,
      events: eventNode(raw.events),
      context: contextScope(raw.context, raw.owner === pluginId),
      status: trackObservable(raw.status),
      get parent(): PluginWorkItem | undefined {
        return optionalItem(raw.parent);
      },
      get children(): Observable<readonly PluginWorkItem[]> {
        children ??= trackObservable(computed(() => raw.children.get().map(workItem), { name: `pluginWorkItem.children:${raw.path}` }));
        return children;
      },
      child: (id) => optionalItem(raw.child(id)),
      createChild: (id, options) => {
        env.assertLive(`create the WorkItem "${id}"`);
        return workItem(raw.createChild(id, optionsOf(options)));
      },
      activate: () => {
        env.assertLive(`activate the WorkItem "${raw.path}"`);
        if (raw.owner !== pluginId) throw env.denied(`activate the WorkItem "${raw.path}": it is not owned by this plugin`);
        raw.activate();
      },
      deactivate: () => {
        if (raw.owner !== pluginId) throw env.denied(`deactivate the WorkItem "${raw.path}": it is not owned by this plugin`);
        raw.deactivate();
      },
      terminate: () => {
        if (raw.owner !== pluginId) return Promise.reject(env.denied(`terminate the WorkItem "${raw.path}": it is not owned by this plugin`));
        return raw.terminate();
      },
      memento: (key, schema) => {
        if (raw.owner !== pluginId) throw env.denied(`open a memento of the WorkItem "${raw.path}": it is not owned by this plugin`);
        return raw.memento(key, schema);
      },
    };
    byRaw.set(raw, facade);
    facadeSet.add(facade);
    return facade;
  }

  const services = new WeakMap<WorkItemService, PluginWorkItemService>();
  const workItemService = (real: WorkItemService): PluginWorkItemService => {
    const known = services.get(real);
    if (known) return known;
    let active: Observable<PluginWorkItem | undefined> | undefined;
    const facade: PluginWorkItemService = {
      get root(): PluginWorkItem {
        return workItem(real.root);
      },
      find: (path) => optionalItem(real.find(path)),
      get active(): Observable<PluginWorkItem | undefined> {
        active ??= trackObservable(computed(() => optionalItem(real.active.get()), { name: 'pluginWorkItems.active' }));
        return active;
      },
      // tracked() adopts the subscriptions (WorkItemService is one of the public services it wraps)
      onDidCreate: (listener, options) => real.onDidCreate((w) => listener(workItem(w)), options),
      onDidTerminate: (listener, options) => real.onDidTerminate((w) => listener(workItem(w)), options),
    };
    services.set(real, facade);
    return facade;
  };

  const workbenches = new WeakMap<WorkbenchService, PluginWorkbenchService>();
  const workbench = (real: WorkbenchService): PluginWorkbenchService => {
    const known = workbenches.get(real);
    if (known) return known;
    const mayChangeLayout = (what: string): void => {
      if (!env.has('workbench.layout')) throw env.denied(`${what}: capability "workbench.layout" is missing`);
    };
    /** A placement of the plugin's own view type is the plugin's to move and force-close. Anything else needs the capability. */
    const mayTouch = (id: PlacementId, what: string): void => {
      const found = real.placement(id);
      if (found === undefined || env.ownsViewType(found.viewType) || env.has('workbench.layout')) return;
      throw env.denied(`${what} the placement "${id}" of a view that the plugin does not own: capability "workbench.layout" is missing`);
    };
    // Explicit members: nothing of the real service leaks through a name that was added later.
    const facade: PluginWorkbenchService = {
      state: real.state,
      focused: real.focused,
      showView: (viewType, options) => {
        env.assertLive(`show the view "${viewType}"`);
        return real.showView(viewType, options);
      },
      activate: (id, options) => {
        env.assertLive('activate a placement');
        return real.activate(id, options);
      },
      hide: (id) => {
        env.assertLive('hide a placement');
        return real.hide(id);
      },
      // One ownership rule: what the plugin's own views do is open; layout-wide operations and foreign placements need `workbench.layout`.
      close: (id, options) => {
        env.assertLive('close a placement');
        if (options?.force === true) mayTouch(id, 'force close');
        return real.close(id, options);
      },
      move: (id, target) => {
        env.assertLive('move a placement');
        mayTouch(id, 'move');
        return real.move(id, target);
      },
      setPartVisible: (windowId, part, visible) => {
        mayChangeLayout('show or hide a part of the window');
        return real.setPartVisible(windowId, part, visible);
      },
      // the plugin cannot create a workspace in the name of another owner
      createWorkspace: (init) => real.createWorkspace({ ...init, owner: pluginId }),
      workspace: (id) => real.workspace(id),
      placement: (id) => {
        const found = real.placement(id);
        return found === undefined ? undefined : allowlistView(found, PLACEMENT_FIELDS, { context: contextScope(found.context, false) }) as unknown as PlacementView;
      },
      instance: (id) => {
        const found = real.instance(id);
        return found === undefined ? undefined : (allowlistView(found, INSTANCE_FIELDS) as ViewInstanceView);
      },
      resetLayout: () => {
        mayChangeLayout('reset the layout');
        return real.resetLayout();
      },
      whenRestored: () => real.whenRestored(),
    };
    workbenches.set(real, facade);
    return facade;
  };

  const undos = new WeakMap<UndoService, UndoService>();
  const undo = (real: UndoService): UndoService => {
    const known = undos.get(real);
    if (known) return known;
    const facade: UndoService = {
      push: (entry, options) => {
        env.assertLive('push an undo entry');
        real.push(entry, { ...options, owner: pluginId }); // the plugin cannot push in the name of another owner
      },
      canUndo: (resource) => real.canUndo(resource),
      canRedo: (resource) => real.canRedo(resource),
      undo: (resource) => real.undo(resource),
      redo: (resource) => real.redo(resource),
      group: (label, fn) => real.group(label, fn),
      invalidateOwner: (owner) => {
        if (owner !== pluginId) throw env.denied(`invalidate the undo entries of "${owner}"`);
        real.invalidateOwner(owner);
      },
      // only the plugin's own entries go: the stacks of other plugins on the same resource stay
      clear: (resource) => real.clear(resource, { owner: pluginId }),
    };
    undos.set(real, facade);
    return facade;
  };

  const configurations = new WeakMap<ConfigurationService, ConfigurationService>();
  const configuration = (real: ConfigurationService): ConfigurationService => {
    const known = configurations.get(real);
    if (known) return known;
    const facade: ConfigurationService = {
      get: (key) => real.get(key),
      observe: (key) => real.observe(key),
      update: (key, value) => {
        if (!env.declaresSetting(key) && !env.has('configuration.writeForeign')) {
          throw env.denied(`change the setting "${key}", which the plugin does not declare: capability "configuration.writeForeign" is missing`);
        }
        real.update(key, value);
      },
      onDidChange: (listener, options) => real.onDidChange(listener, options),
    };
    configurations.set(real, facade);
    return facade;
  };

  const notificationFacades = new WeakMap<NotificationService, NotificationService>();
  const notifications = (real: NotificationService): NotificationService => {
    const known = notificationFacades.get(real);
    if (known) return known;
    const facade: NotificationService = {
      // the plugin cannot post in the name of the core or of another plugin
      notify: (notification) => {
        env.assertLive('show a notification');
        return real.notify({ ...notification, source: pluginId });
      },
      get active() {
        return real.active;
      },
      withProgress: (options, task) => {
        env.assertLive(`show progress "${options.title}"`);
        // the task's signal also aborts when the plugin ends
        return real.withProgress(options, (progress) =>
          task({ report: (update) => progress.report(update), signal: AbortSignal.any([progress.signal, env.signal]) }),
        );
      },
    };
    notificationFacades.set(real, facade);
    return facade;
  };

  const dialogFacades = new WeakMap<DialogService, DialogService>();
  const dialog = (real: DialogService): DialogService => {
    const known = dialogFacades.get(real);
    if (known) return known;
    const facade: DialogService = {
      confirm: (options) => {
        env.assertLive('show a confirm dialog');
        return real.confirm({ ...options, signal: options.signal ? AbortSignal.any([options.signal, env.signal]) : env.signal });
      },
      input: (options) => {
        env.assertLive('show an input dialog');
        return real.input({ ...options, signal: options.signal ? AbortSignal.any([options.signal, env.signal]) : env.signal });
      },
      get pending() {
        return real.pending;
      },
    };
    dialogFacades.set(real, facade);
    return facade;
  };

  const keyServices = new WeakMap<ContextKeyService, PluginContextKeyService>();
  const contextKeyService = (real: ContextKeyService): PluginContextKeyService => {
    const known = keyServices.get(real);
    if (known) return known;
    let focused: Observable<PluginContextKeyScope> | undefined;
    const facade: PluginContextKeyService = {
      get root(): PluginContextKeyScope {
        return contextScope(real.root, false);
      },
      get focused(): Observable<PluginContextKeyScope> {
        focused ??= trackObservable(computed(() => contextScope(real.focused.get(), false), { name: 'pluginContextKeys.focused' }));
        return focused;
      },
      setFocused: () => {
        throw env.denied('change the focused context scope: the workbench owns it');
      },
      parse: (source) => real.parse(source),
      tryParse: (source) => real.tryParse(source),
    };
    keyServices.set(real, facade);
    return facade;
  };

  const tracked = <T>(tokenId: string, value: T): T => {
    if (typeof value !== 'object' || value === null) return value;
    const known = trackedCache.get(value);
    if (known) return known as T;
    const explicit = REGISTERING_MEMBERS[tokenId];
    const proxy = new Proxy(value, {
      get(target, prop) {
        const member: unknown = Reflect.get(target, prop, target);
        // an Observable-valued member: subscribe() on it ends with the plugin
        if (isObservable(member)) return trackObservable(member);
        if (typeof member !== 'function' || typeof prop !== 'string') return member;
        const registers = explicit?.has(prop) === true || /^on[A-Z]/.test(prop);
        return (...args: unknown[]): unknown => {
          const result: unknown = (member as (...a: unknown[]) => unknown).apply(target, args);
          if (isObservable(result)) return trackObservable(result);
          return registers && isDisposable(result) ? env.track(/^on[A-Z]/.test(prop) ? 'event' : prop, `${tokenId}.${prop}`, result) : result;
        };
      },
    });
    trackedCache.set(value, proxy);
    return proxy;
  };

  return { workItem, workItemService, workbench, undo, configuration, notifications, contextKeyService, tracked, eventNode, dialog, viewContextScope: (raw) => contextScope(raw, false) as unknown as ContextKeyScope };
}

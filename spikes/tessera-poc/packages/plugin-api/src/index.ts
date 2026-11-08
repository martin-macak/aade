// @tessera/plugin-api: the semver-stable facade for plugin authors (packages.md 2.4, contracts.md 14.7 and 20).
// A plugin imports this package and nothing else from @tessera. It re-exports a curated subset and adds the
// definition helpers. Everything here works in-process and is semver-stable for version 1. Members that could cross a process boundary later
// (plain data, promises, disposables, events) are marked in contracts.md 14.7; a remote context is a later, additive version.

import {
  ContextKeyService as CoreContextKeyService,
  WorkItemService as CoreWorkItemService,
  WorkbenchService as CoreWorkbenchService,
  type PluginContextKeyService,
  type PluginModule,
  type PluginWorkItemService,
  type PluginWorkbenchService,
} from '@tessera/contracts';
import { token, type Token } from '@tessera/di';
import type { InvocationContext, InvocationKind } from '@tessera/interceptors';

/**
 * Narrows an interceptor context to one invocation kind, so `ctx.data` has the typed shape of that kind (no cast):
 * `if (isKind(ictx, 'command')) ictx.data.commandId`.
 */
export function isKind<K extends InvocationKind>(ctx: InvocationContext, kind: K): ctx is InvocationContext<K> {
  return ctx.kind === kind;
}

/** Defines the main entry of an in-process plugin: `export default definePlugin({ activate(ctx) { ... } })`. */
export function definePlugin(module: PluginModule): PluginModule {
  return module;
}

// There is no defineRemotePlugin in v1: the one PluginContext is the in-process context. A remote (out-of-process) plugin gets its own
// context and definer in a later, additive version; freezing a definer for a context that does not exist yet would pin the wrong type.

// ----- version ---------------------------------------------------------------------------------
export { TESSERA_API_VERSION } from '@tessera/contracts';

// ----- the plugin contract ---------------------------------------------------------------------
export type {
  Contribution,
  ContributionHandler,
  ContributionPoint,
  Memento,
  PluginContext,
  PluginManifest,
  PluginModule,
  PluginServices,
  PluginStorage,
  TesseraApi,
} from '@tessera/contracts';

// ----- public tokens (the ones plugins may use without declaring them in requires) --------------
export {
  CommandService,
  ConfigurationService,
  DialogService,
  NotificationService,
  PublicTokens,
  QuickInputService,
  SelectionService,
  StatusBarService,
  UndoService,
} from '@tessera/contracts';

// Three public tokens have a plugin-facing type: the service a plugin gets is a facade without DI scopes (contracts.md 14.6). The token
// id is the same string as the core token's (token identity is the id, ADR-001), so the gate and the container see one token; only the
// type that `ctx.services.get(...)` returns differs: no `scope` on a WorkItem or a Placement, no dispose on a context-key scope.
export const WorkItemService: Token<PluginWorkItemService> = token<PluginWorkItemService>(CoreWorkItemService.id);
export const WorkbenchService: Token<PluginWorkbenchService> = token<PluginWorkbenchService>(CoreWorkbenchService.id);
export const ContextKeyService: Token<PluginContextKeyService> = token<PluginContextKeyService>(CoreContextKeyService.id);

// ----- commands, events, context, workbench types ---------------------------------------------
export { CoreTopics, MenuId, WorkItemStatus, defineCommand, defineContributionPoint, defineTopic, selectionType } from '@tessera/contracts';
export type {
  CommandContext,
  CommandDef,
  CommandHandler,
  CommandSource,
  ContextKeyScope,
  ContextReader,
  ContextValue,
  EventHandler,
  EventMeta,
  EventNode,
  ExecuteOptions,
  ConfirmOptions,
  InputOptions,
  NotificationInit,
  ProgressOptions,
  ProgressReporter,
  Placement,
  PlacementId,
  PlacementRef,
  PresenterContext,
  Presenter,
  PublishScope,
  QuickPickItem,
  QuickPickOptions,
  SelectionPublisher,
  SelectionType,
  ShowViewOptions,
  Topic,
  UndoEntry,
  ViewContract,
  ViewDescriptor,
  ViewModelContext,
  ViewProvider,
  PlacementView,
  PluginContextKeyScope,
  PluginContextKeyService,
  PluginWorkItem,
  PluginWorkItemService,
  PluginWorkbenchService,
  ViewInstanceView,
  PluginWorkItemController,
  PluginWorkItemOptions,
  ScopeRegistrar,
} from '@tessera/contracts';
// WorkItem and WorkItemOptions are not exported on purpose: they carry the DI scope. Plugins use PluginWorkItem.

// ----- kernel helpers --------------------------------------------------------------------------
export { DisposableStore, Emitter, TesseraError, toDisposable } from '@tessera/base';
export type { Event, IDisposable, Logger, Schema, StateSchema, StoredValue, Migration } from '@tessera/base';
// injectScope and Scope are not exported on purpose: plugins never get the container (contracts.md 14.6). inject() is filtered by the manifest.
export { inject, injectAll, injectLazy, multiToken, token } from '@tessera/di';
export type { MultiToken, ScopeReader, Token } from '@tessera/di';
export { batch, changes, computed, constant, effect, resource, state, transact, untracked } from '@tessera/reactive';
export type { Observable, Resource, State } from '@tessera/reactive';
export type { InvocationContext, Interceptor, SyncObserver } from '@tessera/interceptors';

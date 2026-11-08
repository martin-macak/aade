import { ViewMounter, ViewServicesPolicy } from './adapter.ts';
import { CommandRegistry, CommandService } from './commands.ts';
import { ConfigurationService } from './configuration.ts';
import { ContextKeyService } from './context-keys.ts';
import { DockSurfaceFactory, DockSurfaceHost, WorkbenchAdapterApi } from './dock.ts';
import { EventBus, EventNode } from './events.ts';
import { HostEnvironment } from './host.ts';
import { KeybindingService } from './keybindings.ts';
import { ArrangementMigration, LayoutMigration, LayoutStore } from './layout.ts';
import { LifecycleContribution, LifecycleOptions, LifecycleService } from './lifecycle.ts';
import { MenuRegistry, MenuService } from './menus.ts';
import { ActivationService, ContributionRegistry, HostPluginServices, PluginCatalog, PluginLoader, PluginManager, PluginPolicy } from './plugins.ts';
import { StatusBarService } from './status-bar.ts';
import { StorageBackend, StorageService } from './storage.ts';
import { ErrorReporter, InterceptorRegistry, Logger } from './tokens.ts';
import { UndoOwnerCheck, UndoService } from './undo.ts';
import { DialogService, NotificationService, QuickInputService, SelectionService, ViewInstanceRegistry, ViewRegistry, WorkbenchService } from './workbench.ts';
import { CurrentWorkItem, WorkItemService } from './workitems.ts';

/**
 * Every token that the core registers (contracts.md section 20), public or not. The `tessera.` id prefix is reserved for it:
 * a plugin cannot provide an id in this set or with this prefix, and cannot shadow a core registration at run time.
 * A test checks that this list equals the Token and MultiToken constants that this package exports.
 */
export const CoreTokens: readonly { readonly id: string }[] = [
  ActivationService,
  HostPluginServices,
  PluginPolicy,
  ViewServicesPolicy,
  ContributionRegistry,
  PluginCatalog,
  PluginLoader,
  PluginManager,
  ArrangementMigration,
  LayoutMigration,
  LayoutStore,
  CommandRegistry,
  CommandService,
  ConfigurationService,
  ContextKeyService,
  CurrentWorkItem,
  WorkItemService,
  DockSurfaceFactory,
  DockSurfaceHost,
  WorkbenchAdapterApi,
  ErrorReporter,
  InterceptorRegistry,
  Logger,
  EventBus,
  EventNode,
  HostEnvironment,
  KeybindingService,
  LifecycleContribution,
  LifecycleOptions,
  LifecycleService,
  MenuRegistry,
  MenuService,
  NotificationService,
  DialogService,
  QuickInputService,
  SelectionService,
  ViewInstanceRegistry,
  ViewRegistry,
  WorkbenchService,
  StatusBarService,
  StorageBackend,
  StorageService,
  UndoService,
  UndoOwnerCheck,
  ViewMounter,
];

export const CoreTokenIds: ReadonlySet<string> = new Set(CoreTokens.map((t) => t.id));

/** The id prefix reserved for core tokens. */
export const CORE_TOKEN_PREFIX = 'tessera.';

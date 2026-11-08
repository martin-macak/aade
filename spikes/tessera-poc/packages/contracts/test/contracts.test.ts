import { describe, expect, expectTypeOf, it } from 'vitest';
import { MultiToken, Token } from '@tessera/di';
import type { InvocationContext } from '@tessera/interceptors';
import { createInterceptorRegistry } from '@tessera/interceptors';
import * as contracts from '../src/index.ts';
import type { Schema } from '@tessera/base';
import {
  ActivationService,
  ArrangementMigration,
  ConfigurationService,
  ContributionRegistry,
  DockSurfaceFactory,
  LayoutMigration,
  LayoutStore,
  NotificationService,
  PlacementStatus,
  PluginCatalog,
  PluginLoader,
  PluginManager,
  PluginState,
  QuickInputService,
  SelectionService,
  TESSERA_API_VERSION,
  ViewInstanceRegistry,
  ViewMounter,
  ViewRegistry,
  WORKBENCH_SNAPSHOT_VERSION,
  WorkbenchAdapterApi,
  WorkbenchCommands,
  WorkbenchService,
  defineContributionPoint,
  emptyOverrides,
  selectionType,
  type PluginManifest,
  CommandRegistry,
  CommandService,
  ContextKeyService,
  CoreTopics,
  CurrentWorkItem,
  ErrorReporter,
  EventBus,
  EventNode,
  HostEnvironment,
  InterceptorRegistry,
  KeybindingService,
  LifecycleContribution,
  LifecycleOptions,
  LifecyclePhase,
  LifecycleService,
  Logger,
  MenuId,
  MenuRegistry,
  MenuService,
  PartId,
  PublicTokens,
  ShutdownReason,
  StatusBarService,
  StorageBackend,
  StorageService,
  UndoService,
  WhenSyntaxError,
  WorkItemService,
  WorkItemStatus,
  WorkspaceKind,
  defineCommand,
  defineTopic,
  type CommandInvocation,
  type EventInvocation,
  type CommandSource,
} from '@tessera/contracts';

describe('token catalog (contracts.md section 20)', () => {
  it.each([
    [HostEnvironment, 'tessera.host'],
    [StorageBackend, 'tessera.storageBackend'],
    [Logger, 'tessera.logger'],
    [ErrorReporter, 'tessera.errorReporter'],
    [InterceptorRegistry, 'tessera.interceptors'],
    [LifecycleService, 'tessera.lifecycle'],
    [LifecycleOptions, 'tessera.lifecycleOptions'],
    [LifecycleContribution, 'tessera.lifecycleContribution'],
    [EventBus, 'tessera.eventBus'],
    [EventNode, 'tessera.eventNode'],
    [WorkItemService, 'tessera.workItems'],
    [CurrentWorkItem, 'tessera.currentWorkItem'],
    [ContextKeyService, 'tessera.contextKeys'],
    [CommandRegistry, 'tessera.commandRegistry'],
    [CommandService, 'tessera.commandService'],
    [KeybindingService, 'tessera.keybindings'],
    [MenuRegistry, 'tessera.menuRegistry'],
    [MenuService, 'tessera.menuService'],
    [StatusBarService, 'tessera.statusBar'],
    [UndoService, 'tessera.undo'],
    [StorageService, 'tessera.storage'],
    [ActivationService, 'tessera.activation'],
  ])('token %s has the catalog id %s', (token, id) => {
    expect(token.id).toBe(id);
  });

  it('every token id is unique', () => {
    const ids = [HostEnvironment, StorageBackend, Logger, ErrorReporter, InterceptorRegistry, LifecycleService, LifecycleOptions, LifecycleContribution, EventBus, EventNode, WorkItemService, CurrentWorkItem, ContextKeyService, CommandRegistry, CommandService, KeybindingService, MenuRegistry, MenuService, StatusBarService, UndoService, StorageService, ActivationService].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('PublicTokens lists the nine semver-covered tokens of contracts.md section 20, plus StatusBarService and DialogService (POC additions, see deviations.md)', () => {
    expect(PublicTokens.map((t) => t.id).toSorted()).toEqual([
      'tessera.commandService',
      'tessera.configuration',
      'tessera.contextKeys',
      'tessera.dialog',
      'tessera.notifications',
      'tessera.quickInput',
      'tessera.selection',
      'tessera.statusBar',
      'tessera.undo',
      'tessera.workItems',
      'tessera.workbench',
    ]);
  });
});

describe('stage B tokens, factories and constants (contracts.md sections 14 to 16, 18)', () => {
  it.each([
    [ContributionRegistry, 'tessera.contributions'],
    [PluginCatalog, 'tessera.pluginCatalog'],
    [PluginLoader, 'tessera.pluginLoader'],
    [PluginManager, 'tessera.pluginManager'],
    [ActivationService, 'tessera.activation'],
    [ViewRegistry, 'tessera.viewRegistry'],
    [ViewInstanceRegistry, 'tessera.viewInstances'],
    [WorkbenchService, 'tessera.workbench'],
    [WorkbenchAdapterApi, 'tessera.workbenchAdapter'],
    [SelectionService, 'tessera.selection'],
    [NotificationService, 'tessera.notifications'],
    [QuickInputService, 'tessera.quickInput'],
    [LayoutStore, 'tessera.layoutStore'],
    [LayoutMigration, 'tessera.layoutMigration'],
    [ArrangementMigration, 'tessera.arrangementMigration'],
    [DockSurfaceFactory, 'tessera.dockSurfaceFactory'],
    [ViewMounter, 'tessera.viewMounter'],
    [ConfigurationService, 'tessera.configuration'],
  ])('token id %#', (token, id) => {
    expect(token.id).toBe(id);
  });

  it('defineContributionPoint freezes the point and keeps the optional activation-event function', () => {
    const schema = { safeParse: (i: unknown) => ({ success: true as const, data: i as { id: string } }) };
    const point = defineContributionPoint('things', schema, { description: 'Things', activationEvents: (e) => [`onThing:${e.id}`] });
    expect(Object.isFrozen(point)).toBe(true);
    expect(point.activationEvents?.({ id: 'x' })).toEqual(['onThing:x']);
    expect(defineContributionPoint('plain', schema).activationEvents).toBeUndefined();
  });

  it('selectionType makes a frozen typed key identified by its id', () => {
    const type = selectionType<{ n: number }>('acme/Thing');
    expect(type).toEqual({ id: 'acme/Thing' });
    expect(Object.isFrozen(type)).toBe(true);
  });

  it('constants: the API version is a semver string, the snapshot version is 1, enumerations are as-const objects', () => {
    expect(TESSERA_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WORKBENCH_SNAPSHOT_VERSION).toBe(1);
    expect(PlacementStatus).toEqual({ Pending: 'pending', Placeholder: 'placeholder', Attached: 'attached', Hidden: 'hidden', Closing: 'closing', Closed: 'closed' });
    expect(PluginState.Failed).toBe('failed');
    expect(Object.keys(WorkbenchCommands)).toHaveLength(7);
    expect(emptyOverrides()).toEqual({ views: {}, workspaces: {} });
  });

  it('PluginManifest is a plain data type: a literal with all fields type-checks', () => {
    const manifest: PluginManifest = { id: 'acme.tasks', name: 'Tasks', version: '1.0.0', engines: { tessera: '^1.0.0' }, contributes: { commands: [{ id: 'x' }] } };
    expectTypeOf(manifest.engines.tessera).toEqualTypeOf<string>();
  });
});

describe('enumerations are as-const objects with a union type', () => {
  it('values', () => {
    expect(LifecyclePhase).toEqual({ Starting: 1, Ready: 2, Restored: 3, Eventually: 4 });
    expect(ShutdownReason.Quit).toBe('quit');
    expect(WorkItemStatus.Terminated).toBe('terminated');
    expect(Object.values(MenuId)).toContain('commandPalette');
    expect(PartId.EditorArea).toBe('editorArea');
    expect(WorkspaceKind.Dock).toBe('dock');
    expectTypeOf<LifecyclePhase>().toEqualTypeOf<1 | 2 | 3 | 4>();
    expectTypeOf<WorkItemStatus>().toEqualTypeOf<'active' | 'inactive' | 'terminated'>();
  });
});

describe('defineTopic', () => {
  it('returns a frozen topic with defaults', () => {
    const topic = defineTopic<{ readonly id: string }>('tasks.changed');
    expect(topic).toMatchObject({ id: 'tasks.changed', sticky: false, crossProcess: false, delivery: 'sync', schema: undefined });
    expect(Object.isFrozen(topic)).toBe(true);
  });

  it('keeps the options', () => {
    const schema: Schema<number> = { safeParse: (input) => (typeof input === 'number' ? { success: true, data: input } : { success: false, error: { issues: [] } }) };
    const topic = defineTopic<number>('x.y', { sticky: true, delivery: 'microtask', schema, crossProcess: true, description: 'd' });
    expect(topic).toMatchObject({ sticky: true, delivery: 'microtask', crossProcess: true, description: 'd' });
    expect(topic.schema).toBe(schema);
  });

  it('crossProcess without a schema throws', () => {
    expect(() => defineTopic<number>('x.z', { crossProcess: true })).toThrow(expect.objectContaining({ code: 'validation' }));
  });

  it('core topics carry the documented ids and stickiness', () => {
    expect(CoreTopics.lifecyclePhase).toMatchObject({ id: 'tessera.lifecycle.phase', sticky: true });
    expect(CoreTopics.workbenchRestored).toMatchObject({ id: 'tessera.workbench.restored', sticky: true });
    expect(CoreTopics.commandExecuted).toMatchObject({ id: 'tessera.command.executed', sticky: false });
    expect(CoreTopics.pluginState.id).toBe('tessera.plugin.state');
    expect(CoreTopics.placementOpened.id).toBe('tessera.workbench.placementOpened');
    expect(CoreTopics.placementClosed.id).toBe('tessera.workbench.placementClosed');
  });
});

describe('defineCommand', () => {
  it('returns a typed handle', () => {
    const schema: Schema<{ title: string }> = { safeParse: (i) => ({ success: true, data: i as { title: string } }) };
    const def = defineCommand<{ title: string }, string>('tasks.add', schema);
    expect(def.id).toBe('tasks.add');
    expect(def.args).toBe(schema);
    expectTypeOf(def.resultType).toEqualTypeOf<string | undefined>();
    expect(defineCommand('tasks.clear').args).toBeUndefined();
  });
});

describe('WhenSyntaxError', () => {
  it('carries code, source and column', () => {
    const error = new WhenSyntaxError('Unexpected token', 'a &&', 4);
    expect(error.code).toBe('when.syntax');
    expect(error.source).toBe('a &&');
    expect(error.column).toBe(4);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('invocation kinds are merged into @tessera/interceptors (contracts.md 9.4)', () => {
  it('types the data of a command context', () => {
    const registry = createInterceptorRegistry();
    const ctx = registry.createContext('command', 'tasks.add', { commandId: 'tasks.add', args: undefined, source: 'palette', placementId: undefined, forced: false });
    expectTypeOf(ctx).toEqualTypeOf<InvocationContext<'command'>>();
    expectTypeOf(ctx.data).toEqualTypeOf<Readonly<CommandInvocation>>();
    expectTypeOf(ctx.data.source).toEqualTypeOf<CommandSource>();
    const event = registry.createContext('event', 'tasks.changed', { topicId: 'tasks.changed', payload: 1, scope: 'global', nodeId: 'n', origin: 'local' });
    expectTypeOf(event.data).toEqualTypeOf<Readonly<EventInvocation>>();
    expect(ctx.data.commandId).toBe('tasks.add');
  });
});

describe('core token catalog (plugin-provides-shadows-core-token)', () => {
  it('CoreTokenIds equals every Token and MultiToken that @tessera/contracts exports', () => {
    const exported = (Object.values(contracts) as unknown[])
      .filter((v) => v instanceof Token || v instanceof MultiToken)
      .map((t) => (t as { id: string }).id)
      .toSorted();
    expect([...contracts.CoreTokenIds].toSorted()).toEqual(exported);
    expect(exported.every((id) => id.startsWith(contracts.CORE_TOKEN_PREFIX))).toBe(true);
  });
});

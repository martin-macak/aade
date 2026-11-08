import { TesseraError, toDisposable, type IDisposable, type Schema } from '@tessera/base';
import {
  CommandRegistry,
  KeybindingService,
  MenuRegistry,
  StatusBarService,
  defineContributionPoint,
  type CommandContribution,
  type CommandMetadata,
  type Contribution,
  type ContributionHandler,
  type KeybindingContribution,
  type MenuItemContribution,
  type StatusBarContribution,
} from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { parseWhen } from './when.ts';
import { z } from 'zod';

// The four built-in contribution points of this package (contracts.md 14.2 table).

const commandSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  enablement: z.string().optional(),
  palette: z.boolean().optional(),
  extensible: z.boolean().optional(),
}) as unknown as Schema<CommandContribution>;

const menuItemSchema = z.object({
  menu: z.string().min(1),
  command: z.string().min(1),
  args: z.unknown().optional(),
  group: z.string().optional(),
  order: z.number().optional(),
  when: z.string().optional(),
  alt: z.string().optional(),
  submenu: z.string().optional(),
  title: z.string().optional(),
}) as unknown as Schema<MenuItemContribution>;

const keybindingSchema = z.object({
  key: z.string().min(1),
  mac: z.string().optional(),
  win: z.string().optional(),
  linux: z.string().optional(),
  command: z.string().min(1),
  args: z.unknown().optional(),
  when: z.string().optional(),
}) as unknown as Schema<KeybindingContribution>;

const statusBarSchema = z.object({
  id: z.string().min(1),
  alignment: z.enum(['left', 'right']),
  priority: z.number().optional(),
  text: z.string(),
  tooltip: z.string().optional(),
  command: z.string().optional(),
  when: z.string().optional(),
}) as unknown as Schema<StatusBarContribution>;

export const commandsPoint: ReturnType<typeof defineContributionPoint<CommandContribution>> = defineContributionPoint<CommandContribution>('commands', commandSchema, {
  description: 'Declares a command: title, category, icon and enablement. The code registers the handler.',
  activationEvents: (entry) => [`onCommand:${entry.id}`],
  identity: (entry) => entry.id,
});
export const menusPoint: ReturnType<typeof defineContributionPoint<MenuItemContribution>> = defineContributionPoint<MenuItemContribution>('menus', menuItemSchema, {
  description: 'Adds an item to a menu (palette, view title, context menus).',
});
export const keybindingsPoint: ReturnType<typeof defineContributionPoint<KeybindingContribution>> = defineContributionPoint<KeybindingContribution>('keybindings', keybindingSchema, {
  description: 'Adds a keybinding (source "plugin").',
});
export const statusBarPoint: ReturnType<typeof defineContributionPoint<StatusBarContribution>> = defineContributionPoint<StatusBarContribution>('statusBar', statusBarSchema, {
  description: 'Adds a status bar item.',
});

export function commandsHandler(scope: ScopeReader): ContributionHandler<CommandContribution> {
  const duplicate = (c: Contribution<CommandContribution>): TesseraError | undefined => {
    // A command id belongs to its owner (the core's own commands included): a plugin cannot take over the metadata of another owner.
    const existing = scope.get(CommandRegistry).metadata(c.value.id);
    return existing !== undefined && existing.owner !== c.pluginId
      ? new TesseraError('plugin.duplicateContribution', `command id "${c.value.id}" is already declared by "${existing.owner}"`, { details: { id: c.value.id, owner: existing.owner } })
      : undefined;
  };
  return {
    apply: (c) => {
      const error = duplicate(c);
      if (error) throw error;
      return scope.get(CommandRegistry).declare({ ...c.value, owner: c.pluginId });
    },
    // The batch of one plugin: one publication of the declared map and one version bump, not one per command.
    applyAll: (contributions) => {
      const registry = scope.get(CommandRegistry) as CommandRegistry & { declareMany?: (entries: readonly CommandMetadata[]) => IDisposable[] };
      const results: Array<IDisposable | Error> = contributions.map((c) => duplicate(c) ?? toDisposable(() => undefined));
      const accepted = contributions.filter((_, i) => !(results[i] instanceof Error));
      if (!registry.declareMany) {
        accepted.forEach((c) => void results.splice(contributions.indexOf(c), 1, registry.declare({ ...c.value, owner: c.pluginId })));
        return results;
      }
      const disposables = registry.declareMany(accepted.map((c) => ({ ...c.value, owner: c.pluginId })));
      accepted.forEach((c, i) => void results.splice(contributions.indexOf(c), 1, disposables[i] as IDisposable));
      return results;
    },
  };
}

export function menusHandler(scope: ScopeReader): ContributionHandler<MenuItemContribution> {
  return {
    apply: (c) => scope.get(MenuRegistry).addItem({ ...c.value, owner: c.pluginId }),
  };
}

export function statusBarHandler(scope: ScopeReader): ContributionHandler<StatusBarContribution> {
  return {
    apply: (c) => {
      const { priority, tooltip, command, when, ...rest } = c.value;
      // A bad `when` is a problem of this entry: parse it now, so the entry is dropped and the status of the plugin says why.
      if (when !== undefined) parseWhen(when);
      return scope.get(StatusBarService).add({
        ...rest,
        ...(priority !== undefined ? { priority } : {}),
        ...(tooltip !== undefined ? { tooltip } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(when !== undefined ? { when } : {}),
        owner: c.pluginId,
      });
    },
  };
}

export function keybindingsHandler(scope: ScopeReader): ContributionHandler<KeybindingContribution> {
  return {
    apply: (c) => {
      const registration = scope.get(KeybindingService).register({ ...c.value, source: 'plugin', owner: c.pluginId });
      return toDisposable(() => registration.dispose());
    },
  };
}

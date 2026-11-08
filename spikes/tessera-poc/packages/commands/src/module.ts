import { injectScope } from '@tessera/di';
import {
  ContributionRegistry,
  LifecycleContribution,
  LifecyclePhase,
  CommandRegistry,
  CommandService,
  ContextKeyService,
  KeybindingService,
  MenuRegistry,
  MenuService,
  StatusBarService,
  UndoOwnerCheck,
  UndoService,
  DialogService,
  type ServiceModule,
} from '@tessera/contracts';
import { DefaultCommandService } from './command-service.ts';
import { DefaultContextKeyService } from './context-keys.ts';
import { DefaultKeybindingService } from './keybindings.ts';
import { DefaultMenuRegistry, DefaultMenuService } from './menus.ts';
import { DefaultCommandRegistry } from './registry.ts';
import { commandsHandler, commandsPoint, keybindingsHandler, keybindingsPoint, menusHandler, menusPoint, statusBarHandler, statusBarPoint } from './points.ts';
import { DefaultStatusBarService } from './status-bar.ts';
import { DefaultUndoService } from './undo.ts';

/**
 * Registers context keys, the command registry, menus and the status bar in the application DI scope, and the command
 * service, keybindings, menu service and undo in the window DI scope. Starting contributions define the `commands`,
 * `menus` and `statusBar` points (application scope) and the `keybindings` point (window scope, contracts.md 4 rule 5).
 * Without a ContributionRegistry in the scope (stage A tests), they do nothing.
 */
export const commandsModule: ServiceModule = {
  id: '@tessera/commands',
  install({ application, window }) {
    const owner = 'core';
    application.provide(ContextKeyService, () => new DefaultContextKeyService(application.path), { owner });
    application.provide(CommandRegistry, () => new DefaultCommandRegistry(), { owner });
    application.provide(MenuRegistry, () => new DefaultMenuRegistry(), { owner });
    application.provide(StatusBarService, () => new DefaultStatusBarService(() => window.get(CommandService)), { owner });
    window.provide(
      UndoService,
      () =>
        new DefaultUndoService({
          // resolved at call time: the CommandService and the owner check are created after the undo service
          isOwnerLive: (name) => window.get(UndoOwnerCheck, { optional: true })?.(name) ?? true,
          // confirmBeforeUndo asks the user through the DialogService when the workbench provides one (without it the answer is yes)
          confirm: (entry) => {
            const dialogs = window.get(DialogService, { optional: true });
            return dialogs ? dialogs.confirm({ title: 'Undo', message: `Undo "${entry.label}"?`, confirmLabel: 'Undo', severity: 'warning' }) : Promise.resolve(true);
          },
          execute: (commandId, args) => window.get(CommandService).execute(commandId, args, { source: 'api', undoable: false }),
        }),
      { owner },
    );
    window.provide(CommandService, () => window.createInstance(DefaultCommandService), { owner });
    window.provide(KeybindingService, () => window.createInstance(DefaultKeybindingService), { owner });
    window.provide(MenuService, () => window.createInstance(DefaultMenuService), { owner });
    application.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'commands.points',
          phase: LifecyclePhase.Starting,
          run() {
            const registry = scope.get(ContributionRegistry, { optional: true });
            if (!registry) return;
            registry.definePoint(commandsPoint, commandsHandler(scope));
            registry.definePoint(menusPoint, menusHandler(scope));
            registry.definePoint(statusBarPoint, statusBarHandler(scope));
          },
        };
      },
      { owner, order: -80 },
    );
    window.provideMany(
      LifecycleContribution,
      () => {
        const scope = injectScope();
        return {
          id: 'commands.keybindingsPoint',
          phase: LifecyclePhase.Starting,
          run() {
            scope.get(ContributionRegistry, { optional: true })?.definePoint(keybindingsPoint, keybindingsHandler(scope));
          },
        };
      },
      { owner, order: -80 },
    );
  },
};

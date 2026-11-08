import type { Logger } from '@tessera/base';
import {
  CommandRegistry,
  CommandService,
  ContextKeyService,
  KeybindingService,
  MenuRegistry,
  MenuService,
  StatusBarService,
  UndoService,
  type ActivationService,
  type CommandMetadata,
  type ContextKeyScope,
  ActivationService as ActivationServiceToken,
} from '@tessera/contracts';
import { createTestScope, type TestScope } from '@tessera/testing';
import { eventsModule } from '@tessera/events';
import { commandsModule, type DefaultCommandRegistry } from '@tessera/commands';

export interface Kit {
  readonly t: TestScope;
  readonly commands: CommandService;
  readonly registry: DefaultCommandRegistry;
  readonly keys: ContextKeyService;
  /** the window context-key scope */
  readonly win: ContextKeyScope;
  readonly keybindings: KeybindingService;
  readonly menus: MenuService;
  readonly menuRegistry: MenuRegistry;
  readonly statusBar: StatusBarService;
  readonly undo: UndoService;
}

export function kit(options?: { platform?: 'mac' | 'win' | 'linux'; activation?: ActivationService; logger?: Logger }): Kit {
  const t = createTestScope({ modules: [eventsModule, commandsModule], host: { platform: options?.platform ?? 'linux' }, ...(options?.logger ? { logger: options.logger } : {}) });
  if (options?.activation) t.application.provideValue(ActivationServiceToken, options.activation);
  const keys = t.window.get(ContextKeyService);
  const win = keys.root.createChild('window');
  keys.setFocused(undefined);
  return {
    t,
    commands: t.window.get(CommandService),
    registry: t.window.get(CommandRegistry) as DefaultCommandRegistry,
    keys,
    win,
    keybindings: t.window.get(KeybindingService),
    menus: t.window.get(MenuService),
    menuRegistry: t.window.get(MenuRegistry),
    statusBar: t.window.get(StatusBarService),
    undo: t.window.get(UndoService),
  };
}

export function declare(k: Kit, id: string, extra?: Partial<CommandMetadata>): void {
  k.registry.declare({ id, title: id, owner: 'core', ...extra });
}

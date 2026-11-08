// Shared infrastructure (used by capability 2 and by the manifest commands of capability 4): one declaration becomes a command, a
// menu item, a palette item and a key binding, all removed together by one dispose(). Only native Lumino calls are used inside:
// CommandRegistry.addCommand / addKeyBinding / notifyCommandChanged, Menu.addItem, MenuBar.addMenu, CommandPalette.addItem.
import { type CommandRegistry } from '@lumino/commands';
import { DisposableDelegate, DisposableSet, type IDisposable } from '@lumino/disposable';
import { type CommandPalette, type Menu, type MenuBar, Menu as LuminoMenu } from '@lumino/widgets';
import { type ContextKeys } from './cap2-context-keys.ts';

export interface CommandDeclaration {
  id: string;
  label: string;
  execute: (args: Record<string, unknown>) => unknown;
  /** Enabled only while this returns true; re-evaluated when any context key changes. */
  enabledWhen?: (keys: ContextKeys) => boolean;
  menu?: string;
  palette?: string;
  keys?: string[];
}

export class Contributions {
  private readonly menus = new Map<string, Menu>();
  private readonly conditional = new Set<string>();

  constructor(
    private readonly commands: CommandRegistry,
    private readonly keys: ContextKeys,
    private readonly menuBar: MenuBar,
    private readonly palette: CommandPalette,
  ) {
    keys.changed.connect(() => this.conditional.forEach((id) => commands.notifyCommandChanged(id)));
  }

  menu(name: string): Menu {
    let menu = this.menus.get(name);
    if (!menu) {
      menu = new LuminoMenu({ commands: this.commands });
      menu.title.label = name;
      this.menuBar.addMenu(menu);
      this.menus.set(name, menu);
    }
    return menu;
  }

  declare(spec: CommandDeclaration): IDisposable {
    const set = new DisposableSet();
    set.add(this.commands.addCommand(spec.id, { label: spec.label, execute: (args) => spec.execute(args as Record<string, unknown>), isEnabled: () => spec.enabledWhen?.(this.keys) ?? true }));
    if (spec.enabledWhen) {
      this.conditional.add(spec.id);
      set.add(new DisposableDelegate(() => void this.conditional.delete(spec.id)));
    }
    if (spec.menu) {
      const menu = this.menu(spec.menu);
      const item = menu.addItem({ type: 'command', command: spec.id });
      set.add(new DisposableDelegate(() => menu.removeItem(item)));
    }
    if (spec.palette) {
      const item = this.palette.addItem({ command: spec.id, category: spec.palette });
      set.add(new DisposableDelegate(() => this.palette.removeItem(item)));
    }
    if (spec.keys) set.add(this.commands.addKeyBinding({ command: spec.id, keys: spec.keys, selector: 'body' }));
    return set;
  }
}

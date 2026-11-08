import { toDisposable, type IDisposable } from '@tessera/base';
import {
  CommandRegistry,
  CommandService,
  MenuId,
  MenuRegistry,
  type ContextKeyScope,
  type CommandPresentation,
  type Menu,
  type MenuGroup,
  type MenuItemRule,
  type MenuItemView,
  type MenuRegistry as MenuRegistryType,
  type MenuService,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { computed, state, type Observable, type State } from '@tessera/reactive';
import type { DefaultCommandRegistry } from './registry.ts';
import { createRowGuard } from './row-guard.ts';

export class DefaultMenuRegistry implements MenuRegistryType {
  readonly #rules: State<readonly MenuItemRule[]> = state<readonly MenuItemRule[]>([], { name: 'menus.rules' });

  addItem(rule: MenuItemRule): IDisposable {
    const frozen = Object.freeze({ ...rule });
    this.#rules.update((list) => [...list, frozen]);
    return toDisposable(() => this.#rules.update((list) => list.filter((r) => r !== frozen)));
  }

  items(menu: string): Observable<readonly MenuItemRule[]> {
    return computed(() => this.#rules.get().filter((r) => r.menu === menu), {
      name: `menu.items:${menu}`,
      equals: (a, b) => a.length === b.length && a.every((r, i) => r === b[i]),
    });
  }
}

function groupRank(group: string): string {
  return group === 'navigation' ? '\u0000' : group;
}

export class DefaultMenuService implements MenuService {
  readonly #scope: Scope;

  constructor() {
    this.#scope = injectScope();
  }

  createMenu(menuId: string, context: ContextKeyScope): Menu {
    const scope = this.#scope;
    const registry = scope.get(MenuRegistry) as DefaultMenuRegistry;
    const commands = scope.get(CommandService);
    const commandRegistry = scope.get(CommandRegistry) as DefaultCommandRegistry;
    const isPalette = menuId === MenuId.CommandPalette;
    const rules = registry.items(menuId);
    let disposed = false;

    const presentationOf = (id: string): CommandPresentation => commands.presentation(id, context).get();
    /** Rows whose rule threw are reported once per menu and rule, and skipped. */
    const guardRow = createRowGuard({ menu: menuId });

    const groups = computed<readonly MenuGroup[]>(
      () => {
        interface Row {
          readonly view: MenuItemView;
          readonly group: string;
          readonly order: number;
        }
        const rows: Row[] = [];
        const itemRules = rules.get();

        if (isPalette) {
          // The palette lists every declared command with palette !== false. Menu rules for the palette only restrict
          // where a command appears (their `when`), and may rename it.
          const byCommand = new Map<string, MenuItemRule[]>();
          for (const rule of itemRules) {
            if (rule.command === undefined) continue;
            const list = byCommand.get(rule.command) ?? [];
            list.push(rule);
            byCommand.set(rule.command, list);
          }
          for (const [id, metadata] of commandRegistry.commands.get()) {
            if (metadata.palette === false) continue;
            guardRow(id, metadata.owner, () => {
              const restricting = byCommand.get(id);
              let rule: MenuItemRule | undefined;
              if (restricting) {
                rule = restricting.find((r) => context.evaluate(r.when));
                if (!rule) return;
              }
              const presentation = presentationOf(id);
              if (presentation.status !== 'enabled') return; // the palette hides disabled and unavailable commands
              rows.push({
                view: { id: `${menuId}:${id}`, command: id, submenu: undefined, args: rule?.args, presentation: rule?.title ? { ...presentation, title: rule.title } : presentation },
                group: rule?.group ?? metadata.category ?? 'default',
                order: rule?.order ?? 0,
              });
            });
          }
        } else {
          let index = 0;
          for (const rule of itemRules) {
            index++;
            const position = index;
            guardRow(`${rule.submenu ?? rule.command}#${position}`, rule.owner, () => {
              if (!context.evaluate(rule.when)) return; // `when` is visibility
              if (rule.submenu !== undefined) {
                rows.push({
                  view: {
                    id: `${menuId}:submenu:${rule.submenu}:${position}`,
                    command: undefined,
                    submenu: rule.submenu,
                    args: undefined,
                    presentation: { title: rule.title ?? rule.submenu, category: undefined, icon: undefined, status: 'enabled', toggled: undefined, keybinding: undefined },
                  },
                  group: rule.group ?? 'default',
                  order: rule.order ?? 0,
                });
                return;
              }
              const presentation = presentationOf(rule.command);
              if (presentation.status === 'unavailable') return; // unavailable items are hidden, disabled ones are greyed
              rows.push({
                view: {
                  id: `${menuId}:${rule.command}:${position}`,
                  command: rule.command,
                  submenu: undefined,
                  args: rule.args,
                  presentation: rule.title ? { ...presentation, title: rule.title } : presentation,
                },
                group: rule.group ?? 'default',
                order: rule.order ?? 0,
              });
            });
          }
        }

        const byGroup = new Map<string, Row[]>();
        for (const row of rows) {
          const list = byGroup.get(row.group) ?? [];
          list.push(row);
          byGroup.set(row.group, list);
        }
        return [...byGroup.entries()]
          .toSorted(([a], [b]) => groupRank(a).localeCompare(groupRank(b)))
          .map(([id, list]) => ({
            id,
            items: list.toSorted((a, b) => a.order - b.order || a.view.presentation.title.localeCompare(b.view.presentation.title)).map((r) => r.view),
          }));
      },
      {
        name: `menu.groups:${menuId}`,
        equals: (a, b) =>
          a.length === b.length &&
          a.every(
            (g, i) =>
              g.id === b[i]?.id &&
              g.items.length === b[i]?.items.length &&
              g.items.every((item, j) => {
                const other = b[i]?.items[j];
                return (
                  other !== undefined &&
                  item.id === other.id &&
                  item.args === other.args &&
                  item.presentation.title === other.presentation.title &&
                  item.presentation.status === other.presentation.status &&
                  item.presentation.toggled === other.presentation.toggled &&
                  item.presentation.keybinding === other.presentation.keybinding &&
                  item.presentation.icon === other.presentation.icon
                );
              }),
          ),
      },
    );

    return {
      id: menuId,
      groups,
      run: async (item, options) => {
        if (disposed || item.command === undefined) return undefined;
        return commands.execute(item.command, item.args, {
          source: isPalette ? 'palette' : 'menu',
          context,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      },
      dispose() {
        disposed = true;
      },
    };
  }
}

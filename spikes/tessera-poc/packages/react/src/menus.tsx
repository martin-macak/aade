import { useEffect, useState, type ReactElement } from 'react';
import { MenuService, type ContextKeyScope, type Menu, type MenuItemView } from '@tessera/contracts';
import { useServices } from './contexts.ts';
import { useObservable } from './use-observable.ts';

/**
 * A Menu of the MenuService for one context-key scope. Created in an effect and disposed with it, so StrictMode's
 * double mount leaves no menu behind. undefined until the effect ran.
 */
export function useMenu(menuId: string, context: ContextKeyScope): Menu | undefined {
  const services = useServices();
  const [menu, setMenu] = useState<Menu | undefined>(undefined);
  useEffect(() => {
    const created = services.get(MenuService).createMenu(menuId, context);
    setMenu(created);
    return () => {
      created.dispose();
      setMenu(undefined);
    };
  }, [services, menuId, context]);
  return menu;
}

function MenuButton({ menu, item }: { readonly menu: Menu; readonly item: MenuItemView }): ReactElement {
  const { presentation } = item;
  return (
    <button
      type="button"
      className="tessera-menu-item"
      disabled={presentation.status === 'disabled'}
      title={presentation.keybinding ? `${presentation.title} (${presentation.keybinding})` : presentation.title}
      data-command={item.command}
      onClick={() => void menu.run(item).catch(() => undefined)} // the command service reports the failure
    >
      {presentation.title}
    </button>
  );
}

function MenuGroups({ menu }: { readonly menu: Menu }): ReactElement {
  const groups = useObservable(menu.groups);
  return (
    <>
      {groups.map((group) => (
        <span key={group.id} className="tessera-menu-group" data-group={group.id}>
          {/* the menu model already hides unavailable items: this only draws */}
          {group.items.map((item) => (
            <MenuButton key={item.id} menu={menu} item={item} />
          ))}
        </span>
      ))}
    </>
  );
}

/** A toolbar for a menu (view/title, workspace/title). Items follow `when` (visibility) and enablement (greyed). */
export function MenuToolbar({ menuId, context, label }: { readonly menuId: string; readonly context: ContextKeyScope; readonly label?: string }): ReactElement | null {
  const menu = useMenu(menuId, context);
  if (!menu) return null;
  return (
    <div className="tessera-toolbar" role="toolbar" aria-label={label ?? menuId} data-menu={menuId}>
      <MenuGroups menu={menu} />
    </div>
  );
}

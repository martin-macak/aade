import { MenuService, type ContextKeyScope, type MenuItemView, type PlacementRef } from '@tessera/contracts';
import type { TestApp } from '@tessera/testing';
import type { TaskListIntents, TaskListState } from '@tessera-poc/plugin-tasks/presenter';

export const EDITOR = 'workbench.editorArea';
export const SIDEBAR = 'tasks.sidebar';

/** The items of a menu in a context, flattened. The menu is disposed again. */
export function menuItems(app: TestApp, menuId: string, context: ContextKeyScope): MenuItemView[] {
  const menu = app.get(MenuService).createMenu(menuId, context);
  try {
    return menu.groups.peek().flatMap((g) => g.items);
  } finally {
    menu.dispose();
  }
}

export const titles = (items: readonly MenuItemView[]): string[] => items.map((i) => i.presentation.title);

export function statusOf(items: readonly MenuItemView[], command: string): string | undefined {
  return items.find((i) => i.command === command)?.presentation.status;
}

/** The context a view/title menu of a tasks.list placement evaluates in, without any placement: just the key `view`. */
export function viewContext(app: TestApp, viewType: string): ContextKeyScope {
  const scope = app.workItems.root.context.createChild(`test-view:${viewType}`);
  scope.set('view', viewType);
  return scope;
}

export function presenterOf(app: TestApp, ref: PlacementRef): { readonly intents: TaskListIntents; state(): TaskListState } {
  const presenter = app.workbench.placement(ref.id)?.presenter;
  if (!presenter) throw new Error(`placement ${ref.id} has no presenter`);
  return { intents: presenter.intents as TaskListIntents, state: () => presenter.viewState.peek() as TaskListState };
}

/** Both placements of tasks.list: the side bar tab and a dock tab. */
export async function openTwice(app: TestApp): Promise<{ side: PlacementRef; dock: PlacementRef }> {
  const side = await app.workbench.showView('tasks.list');
  const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
  return { side, dock };
}

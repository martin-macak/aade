import { StatusBarService, computed, definePlugin, token } from '@tessera/plugin-api';
import type { PluginContext, Observable, PluginModule, Token } from '@tessera/plugin-api';

// This plugin must not import sample.tasks. It declares the part of the TaskStore it needs and makes the same token by id:
// tokens compare by string id, never by object identity (contracts.md 7.1, claim C3). The manifest says `requires` it,
// so the provider activates first.
interface OpenTasks {
  readonly openCount: Observable<number>;
}
export const TaskStoreToken: Token<OpenTasks> = token<OpenTasks>('sample.tasks/TaskStore');

export const STATUS_ITEM_ID = 'taskStats.open';

export function openTasksText(count: number): string {
  return count === 1 ? '1 open task' : `${count} open tasks`;
}

const plugin: PluginModule = definePlugin({
  activate(ctx: PluginContext): void {
    const store = ctx.services.get(TaskStoreToken);
    const statusBar = ctx.services.get(StatusBarService);
    const text = computed(() => openTasksText(store.openCount.get()), { name: 'taskStats.text' });
    // the item ends with the plugin: the StatusBarService token the plugin gets tracks the registration (contracts 14.6)
    statusBar.add({ id: STATUS_ITEM_ID, alignment: 'left', priority: 10, text, tooltip: 'Open tasks', command: 'tasks.add', owner: ctx.id });
  },
});

export default plugin;

import { TesseraError, definePlugin, defineTopic } from '@tessera/plugin-api';
import type { PluginContext, PluginModule, Topic } from '@tessera/plugin-api';

// The same topic id as sample.tasks publishes. Topics are matched by id.
const TasksChanged: Topic<unknown> = defineTopic<unknown>('tasks.changed');

export const FAIL_SETTING = 'sample.faulty.failOnActivate';

/**
 * sample.faulty (poc-plan section 3). With the setting on (the default) it registers a command and a subscription and
 * throws: the framework must undo both. With the setting off it activates, and then the command handler, the event
 * subscriber and the interceptor throw: each failure must stay inside its own call.
 */
const plugin: PluginModule = definePlugin({
  activate(ctx: PluginContext): void {
    const failOnActivate = ctx.api.configuration.get<boolean>(FAIL_SETTING) ?? true;
    ctx.api.commands.registerHandler('faulty.boom', {
      run() {
        throw new TesseraError('faulty.boom', 'faulty.boom always fails');
      },
    });
    ctx.api.events.subscribe(TasksChanged, () => {
      throw new Error('sample.faulty subscriber always fails');
    });
    if (failOnActivate) throw new Error('sample.faulty failed on purpose in activate()');
    ctx.interceptors.register('faulty.observer', async () => {
      throw new Error('sample.faulty observer always fails');
    });
  },
});

export default plugin;

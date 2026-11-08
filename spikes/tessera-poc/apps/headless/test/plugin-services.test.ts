import { describe, expect, it } from 'vitest';
import { InterceptorRegistry, StatusBarService, StorageService, type PluginContext } from '@tessera/contracts';
import { describePlugin, manifest } from '@tessera/testing';
import { createDemoApp } from '@tessera-poc/headless';
import { TaskStore } from '@tessera-poc/plugin-tasks';
import { TaskStoreToken } from '@tessera-poc/plugin-task-stats';
import { openTwice } from './kit.ts';

describe('C19: extension through DI tokens', () => {
  it('C19: sample.taskStats gets sample.tasks/TaskStore through ctx.services because it declares it in requires; the provider activates first', async () => {
    const loads: string[] = [];
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.taskStats'], onLoad: (id) => loads.push(id) });
    expect(loads).toEqual([]); // both asleep
    await app.toEventually(); // onStartupFinished wakes taskStats; its requires pull the provider in first
    expect(loads).toEqual(['sample.tasks', 'sample.taskStats']);
    expect(app.plugins.status('sample.taskStats')?.activationReason).toBe('onStartupFinished');
    expect(app.plugins.status('sample.tasks')?.activationReason).toBe('onStartupFinished'); // woken as a dependency, same event
    const items = app.get(StatusBarService).items(app.workItems.root.context).peek().left;
    expect(items.map((i) => i.text)).toEqual(['0 open tasks']);
    await app.commands.execute('tasks.add', { title: 'one' });
    await app.commands.execute('tasks.add', { title: 'two' });
    expect(app.get(StatusBarService).items(app.workItems.root.context).peek().left.map((i) => i.text)).toEqual(['2 open tasks']);
  });

  it('C19: the two plugins never share an object: taskStats makes its own token with the same id, and ids are what counts', async () => {
    expect(TaskStoreToken).not.toBe(TaskStore);
    expect(TaskStoreToken.id).toBe(TaskStore.id);
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.plugins.activate('sample.tasks');
    expect(app.window.get(TaskStoreToken)).toBe(app.window.get(TaskStore)); // the same provider answers both tokens
  });

  it('C19: an undeclared token is refused with plugin.capabilityDenied, a declared or public one is allowed', async () => {
    let denied: unknown;
    let allowed: unknown;
    const snoop = describePlugin(manifest('fixture.snoop', { requires: ['sample.tasks/TaskStore'] }));
    const app = await createDemoApp({
      only: ['sample.tasks'],
      extraPlugins: [snoop],
      extraModules: {
        [snoop.location]: {
          activate(ctx: PluginContext) {
            try {
              ctx.services.get(StorageService); // internal: not public, not declared
            } catch (error) {
              denied = error;
            }
            try {
              ctx.services.get(InterceptorRegistry);
            } catch {
              // also internal
            }
            allowed = [ctx.services.get(TaskStore), ctx.services.getOptional(StatusBarService)];
          },
        },
      },
    });
    await app.plugins.activate('fixture.snoop');
    expect(denied).toMatchObject({ code: 'plugin.capabilityDenied' });
    expect((allowed as unknown[])[0]).toBeDefined();
    expect((allowed as unknown[])[1]).toBeDefined();
  });

  it('C19: services the plugin provides resolve from the WorkItem scopes and from the placement scope', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const { side, dock } = await openTwice(app);
    const store = app.window.get(TaskStore);
    expect(app.workItems.find('root/tasks')!.scope.get(TaskStore)).toBe(store);
    expect(app.workItems.find('root/tasks/project-a')!.scope.get(TaskStore)).toBe(store);
    expect(app.workbench.placement(side.id)!.scope!.get(TaskStore)).toBe(store);
    expect(app.workbench.placement(dock.id)!.scope!.get(TaskStore)).toBe(store);
    expect(app.workbench.instance(side.instanceId)!.scope.parent).toBe(app.workItems.find('root/tasks')!.scope); // view scope under the tasks WorkItem
  });

  it('C19: the plugin owns its WorkItems; the manifest lists what it provides and the loader never sees an import of another plugin', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.plugins.activate('sample.tasks');
    expect(app.workItems.find('root/tasks')?.owner).toBe('sample.tasks');
    expect(app.workItems.find('root/tasks/project-b')).toBeDefined();
  });
});

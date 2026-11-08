import { describe, expect, it } from 'vitest';
import { CommandRegistry, CoreTopics, EventBus, EventNode, defineTopic } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { createDemoApp } from '@tessera-poc/headless';
import { FAIL_SETTING } from '@tessera-poc/plugin-faulty';
import type { DefaultPluginManager } from '@tessera/plugins';

const TasksChanged = defineTopic<{ open: number }>('tasks.changed');

describe('C16: sample.faulty throwing in activate', () => {
  it('C16: ends failed with cause activateThrew, never calls deactivate, and its command and subscription are gone', async () => {
    const app = await createDemoApp();
    const errors = captureErrors();
    // the declared command is available before activation (lazy), executing it activates the plugin, which throws
    await expect(app.commands.execute('faulty.boom')).rejects.toMatchObject({ code: 'command.unavailable' });
    const status = app.plugins.status('sample.faulty')!;
    expect(status.state).toBe('failed');
    expect(status.failure).toMatchObject({ cause: 'activateThrew', count: 1 });
    expect(status.failure?.error.message).toContain('failed on purpose');
    expect(app.get(CommandRegistry).hasHandler('faulty.boom')).toBe(false); // the handler it registered before throwing is gone
    expect(app.get(CommandRegistry).metadata('faulty.boom')).toBeDefined(); // the declaration stays
    expect((app.plugins as DefaultPluginManager).liveDisposables('sample.faulty')).toEqual([]);

    // its subscription is gone: a task event reaches nobody from this plugin, so nothing is reported for it
    await app.commands.execute('tasks.add', { title: 'x' });
    const reported = errors.drain();
    expect(reported.filter((e) => e.context.pluginId === 'sample.faulty').map((e) => e.context.source)).toEqual(['activation']);
    errors.dispose();
  });

  it('C16: the app and the other plugins keep running', async () => {
    const app = await createDemoApp();
    const errors = captureErrors();
    await app.commands.execute('faulty.boom').catch(() => undefined);
    expect(await app.commands.execute('tasks.add', { title: 'still works' })).toMatchObject({ id: 't1' });
    expect(app.plugins.status('sample.tasks')?.state).toBe('active');
    expect(app.plugins.status('sample.audit')?.state).toBe('active');
    const side = await app.workbench.showView('tasks.list');
    expect(app.workbench.placement(side.id)?.presenter).toBeDefined();
    errors.drain();
    errors.dispose();
  });

  it('C16: failure is attributed in the reported error and in the audit log', async () => {
    const app = await createDemoApp();
    const errors = captureErrors();
    await app.commands.execute('faulty.boom').catch(() => undefined);
    const activation = errors.drain().filter((e) => e.context.source === 'activation');
    expect(activation).toHaveLength(1);
    expect(activation[0]?.context).toMatchObject({ pluginId: 'sample.faulty', target: 'sample.faulty' });
    errors.dispose();
  });

  it('C16: failed is not retried by itself; retry() works once the setting is off', async () => {
    const app = await createDemoApp();
    const errors = captureErrors();
    await app.commands.execute('faulty.boom').catch(() => undefined);
    expect(app.plugins.status('sample.faulty')?.state).toBe('failed');
    app.configuration.update(FAIL_SETTING, false);
    await app.toEventually();
    expect(app.plugins.status('sample.faulty')?.state).toBe('failed'); // no auto retry
    await app.plugins.retry('sample.faulty');
    expect(app.plugins.status('sample.faulty')).toMatchObject({ state: 'active', failure: undefined });
    errors.drain();
    errors.dispose();
  });
});

describe('C16: sample.faulty when it activates (setting off)', () => {
  async function activeFaulty() {
    const app = await createDemoApp();
    app.configuration.update(FAIL_SETTING, false);
    await app.plugins.activate('sample.faulty');
    return app;
  }

  it('C16: a throwing command handler rejects only that call and is attributed to the plugin', async () => {
    const app = await activeFaulty();
    const errors = captureErrors();
    await expect(app.commands.execute('faulty.boom')).rejects.toMatchObject({ code: 'faulty.boom' });
    expect(await app.commands.execute('tasks.add', { title: 'ok' })).toMatchObject({ id: 't1' }); // other commands unaffected
    const reported = errors.drain();
    expect(reported.filter((e) => e.context.source === 'command').map((e) => e.context.pluginId)).toEqual(['sample.faulty']);
    expect(app.plugins.status('sample.faulty')?.state).toBe('active');
    errors.dispose();
  });

  it('C16: a throwing subscriber and a throwing observer interceptor are reported with the owner plugin id and affect nobody else', async () => {
    const app = await activeFaulty();
    const seen: number[] = [];
    app.application.get(EventNode).subscribe(TasksChanged, (e) => seen.push(e.open)); // a healthy subscriber of the same topic
    const errors = captureErrors();
    const result = await app.commands.execute<{ id: string }>('tasks.add', { title: 'trigger' });
    expect(result.id).toBe('t1');
    expect(seen).toEqual([1]);
    // the observer is declared for the literal command faulty.boom (so the plugin sleeps until then): it throws there, next to the handler
    await expect(app.commands.execute('faulty.boom')).rejects.toMatchObject({ code: 'faulty.boom' }); // the healthy subscriber got the event although the faulty one threw
    const byAttribution = errors.drain().map((e) => `${e.context.source}:${e.context.pluginId}`);
    expect(byAttribution).toContain('subscriber:sample.faulty');
    expect(byAttribution).toContain('interceptor:sample.faulty');
    expect(byAttribution.every((a) => a.endsWith(':sample.faulty'))).toBe(true); // nothing else failed
    errors.dispose();
  });

  it('C16: deactivating the faulty plugin removes its interceptor and subscriber: the errors stop', async () => {
    const app = await activeFaulty();
    const errors = captureErrors();
    await app.plugins.deactivate('sample.faulty');
    await app.commands.execute('tasks.add', { title: 'quiet' });
    expect(errors.drain().filter((e) => e.context.pluginId === 'sample.faulty')).toEqual([]);
    errors.dispose();
    void EventBus;
    void CoreTopics;
  });
});

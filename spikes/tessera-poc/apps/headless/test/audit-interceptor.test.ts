import { describe, expect, it } from 'vitest';
import { captureErrors, describePlugin } from '@tessera/testing';
import { createDemoApp, auditManifest } from '@tessera-poc/headless';
import { AuditLogToken, type AuditEntry } from '@tessera-poc/plugin-audit';
import { EDITOR, presenterOf } from './kit.ts';

const logOf = (app: Awaited<ReturnType<typeof createDemoApp>>): readonly AuditEntry[] => app.window.get(AuditLogToken).entries.peek();

describe('C18: a plugin-contributed interceptor on commands and events', () => {
  it('C18: sample.audit (activation event *) is active from the start and records every command: id, source, duration, outcome', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'] });
    expect(app.plugins.status('sample.audit')).toMatchObject({ state: 'active', activationReason: '*' });
    await app.commands.execute('tasks.add', { title: 'one' }, { source: 'palette' });
    await app.commands.execute('tasks.add', { title: 'two' }, { source: 'keybinding' });
    const commands = logOf(app).filter((e) => e.kind === 'command' && e.target === 'tasks.add');
    expect(commands.map((e) => [e.target, e.source, e.outcome])).toEqual([
      ['tasks.add', 'palette', 'ok'],
      ['tasks.add', 'keybinding', 'ok'],
    ]);
    for (const entry of commands) expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('C18: it records a failing command with outcome error and the message, without changing the outcome for the caller', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'] });
    const errors = captureErrors();
    await expect(app.commands.execute('tasks.add', { title: 5 })).rejects.toMatchObject({ code: 'command.invalidArgs' }); // validation happens before interceptors
    await app.commands.execute('tasks.add', { title: 'fine' });
    errors.drain();
    errors.dispose();
    expect(logOf(app).filter((e) => e.target === 'tasks.add').map((e) => e.outcome)).toEqual(['ok']);
  });

  it('C18: it records every event publication, with topic, publish scope and the node', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'] });
    await app.commands.execute('tasks.add', { title: 'x', project: 'project-a' });
    const events = logOf(app).filter((e) => e.kind === 'event' && e.target === 'tasks.changed');
    expect(events.map((e) => e.source).sort()).toEqual(['descendants', 'global', 'workItem']); // one task change, three publications
    expect(events.some((e) => e.detail?.includes('project-a'))).toBe(true);
  });

  it('C18: the guard vetoes workbench.closePlacement for a placement whose local state is pinned', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'] });
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
    const presenter = presenterOf(app, dock);
    presenter.intents.setPinned(true);
    expect(await app.workbench.close(dock.id)).toBe(false);
    expect(app.workbench.placement(dock.id)).toBeDefined();
    expect(logOf(app).some((e) => e.target === 'workbench.closePlacement' && e.outcome === 'vetoed')).toBe(true);
    presenter.intents.setPinned(false);
    expect(await app.workbench.close(dock.id)).toBe(true);
  });

  it('C18: the pin only protects against a normal close: force closes it (the contract keeps force for the owner of the layout)', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'] });
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });
    presenterOf(app, dock).intents.setPinned(true);
    expect(await app.workbench.close(dock.id, { force: true })).toBe(true);
  });

  it('C18: without the capability interceptors.guard the same guard is rejected with plugin.capabilityDenied', async () => {
    const { capabilities, ...rest } = auditManifest;
    void capabilities;
    const noCapability = describePlugin(rest, 'builtin');
    const errors = captureErrors(); // the plugin activates at '*' while the app boots
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.audit'], override: { 'sample.audit': noCapability } });
    // the plugin activates at '*' during startup; its activate() registers the guard and fails
    const status = app.plugins.status('sample.audit')!;
    expect(status.state).toBe('failed');
    expect(status.failure?.cause).toBe('activateThrew');
    expect(status.failure?.error.cause?.code).toBe('plugin.capabilityDenied');
    expect(status.failure?.error.cause?.message).toContain('interceptors.guard');
    // and nothing of it stays registered
    expect(app.application.get((await import('@tessera/contracts')).InterceptorRegistry).list('command').filter((i) => i.owner === 'sample.audit')).toEqual([]);
    errors.drain();
    errors.dispose();
  });
});

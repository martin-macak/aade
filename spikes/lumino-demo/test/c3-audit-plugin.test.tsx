import { afterEach, describe, expect, it } from 'vitest';
import { IAuditLog } from '../src/plugins/audit.ts';
import { IInterceptors } from '../src/tokens.ts';
import { boot, settle, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
});

describe('C3 a plugin-contributed interceptor (the audit plugin) on commands and events', () => {
  it('C3: the audit plugin records commands (native observer) and the three event publications of one change, with timing', async () => {
    h = await boot();
    const { win } = h;
    expect(win.plugins.state('sample.audit')).toBe('active'); // autoStart
    const log = win.windowScope.get(IAuditLog);
    await win.app.commands.execute('tasks.add', { title: 'x' });
    await settle();
    const commands = log.entries.filter((e) => e.kind === 'command');
    const events = log.entries.filter((e) => e.kind === 'event');
    expect(commands.map((e) => [e.id, e.outcome])).toContainEqual(['tasks.add', 'ok']);
    expect(commands.every((e) => typeof e.durationMs === 'number')).toBe(true);
    expect(events.map((e) => e.id)).toEqual(['tasks.changed', 'tasks.changed', 'tasks.changed']); // global, descendants, workItem
    expect(events.every((e) => e.outcome === 'ok' && typeof e.durationMs === 'number')).toBe(true);
  });

  it('C3: a failing command is recorded as an error and the failure still reaches the caller', async () => {
    h = await boot();
    const { win } = h;
    const log = win.windowScope.get(IAuditLog);
    await win.app.commands.execute('tasks.add');
    await expect(win.app.commands.execute('tasks.complete')).rejects.toThrow('Select a task first');
    await settle();
    expect(log.entries.some((e) => e.id === 'tasks.complete' && e.outcome === 'error')).toBe(true);
  });

  it('C3: deactivating the audit plugin removes both interceptors', async () => {
    h = await boot();
    const { win } = h;
    const log = win.windowScope.get(IAuditLog);
    await win.app.commands.execute('tasks.add');
    await settle();
    const before = log.entries.length;
    await win.plugins.deactivate('sample.audit');
    await win.app.commands.execute('tasks.add');
    await settle();
    expect(log.entries.length).toBe(before);
  });

  it('C3: a throwing interceptor contributed by a plugin does not break commands or events', async () => {
    h = await boot();
    const { win, errors } = h;
    win.plugins.register({
      id: 'sample.broken-interceptor',
      autoStart: true,
      activate: (ctx) => void ctx.own(ctx.scope.get(IInterceptors).add(() => { throw new Error('broken'); })),
    });
    await win.plugins.activate('sample.broken-interceptor');
    await expect(win.app.commands.execute('tasks.add', { title: 'ok' })).resolves.toBeTypeOf('number');
    expect(errors.length).toBeGreaterThan(0);
  });
});


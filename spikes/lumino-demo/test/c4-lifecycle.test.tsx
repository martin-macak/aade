import { Application } from '@lumino/application';
import { Token } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditPlugin } from '../src/plugins/audit.ts';
import { faultyPlugin } from '../src/plugins/faulty.ts';
import { ITasks } from '../src/plugins/task-store.ts';
import { tasksPlugin } from '../src/plugins/tasks.ts';
import { boot, type Harness } from './kit.tsx';

let h: Harness | undefined;
afterEach(() => {
  h?.stop();
  h = undefined;
  vi.restoreAllMocks();
});
beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));

describe('C4 plugin lifecycle', () => {
  it('C4: contributions exist before the plugin code runs; the first run activates the plugin (lazy by command)', async () => {
    h = await boot();
    const { win } = h;
    expect(win.plugins.state('sample.tasks')).toBe('registered');
    expect(win.app.isPluginActivated('sample.tasks')).toBe(false);
    expect(win.app.commands.hasCommand('tasks.add')).toBe(true); // visible in menu and palette, no plugin code yet
    expect(win.views.getType('tasks.list')).toBeDefined();
    const id = await win.app.commands.execute('tasks.add', { title: 'first' });
    expect(win.plugins.state('sample.tasks')).toBe('active');
    expect(win.app.isPluginActivated('sample.tasks')).toBe(true);
    expect(win.windowScope.get(ITasks).store.tasks.map((t) => t.id)).toEqual([id]);
  });

  it('C4: NATIVE lazy activation by dependency: a plugin that requires a token activates its provider first', async () => {
    const Service = new Token<{ hello: string }>('svc');
    const app = new Application({ shell: new Widget() });
    const order: string[] = [];
    app.registerPlugin({ id: 'provider', provides: Service, activate: () => (order.push('provider'), { hello: 'world' }) });
    app.registerPlugin({ id: 'consumer', requires: [Service], autoStart: true, activate: (_, svc: { hello: string }) => void order.push(`consumer:${svc.hello}`) });
    expect(app.isPluginActivated('provider')).toBe(false);
    await app.activatePlugin('consumer');
    expect(order).toEqual(['provider', 'consumer:world']);
  });

  it('C4: startup failure isolation (native): activatePlugins swallows a failing autoStart plugin, the others still start', async () => {
    h = await boot({ plugins: [auditPlugin, tasksPlugin], start: false });
    const { win, host } = h;
    win.plugins.register({ id: 'boom', autoStart: true, activate: () => { throw new Error('boom at startup'); } });
    await win.start(host.id);
    expect(win.plugins.state('boom')).toBe('failed');
    expect(win.plugins.state('sample.audit')).toBe('active');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Plugin 'boom' failed to activate"), expect.any(Error));
  });

  it('C4: lazy failure isolation: a plugin that throws in activate rejects only the caller, is rolled back, and the app keeps working', async () => {
    h = await boot({ plugins: [auditPlugin, tasksPlugin, faultyPlugin] });
    const { win } = h;
    await expect(win.app.commands.execute('faulty.run')).rejects.toThrow('sample.faulty failed to activate');
    expect(win.plugins.state('sample.faulty')).toBe('failed');
    // The handler that activate registered before it threw was rolled back, so a retry fails cleanly instead of running half-state code.
    await expect(win.app.commands.execute('faulty.run')).rejects.toThrow(/failed to activate/);
    await win.app.commands.execute('tasks.add', { title: 'still works' });
    expect(win.windowScope.get(ITasks).store.tasks).toHaveLength(1);
  });

  it('C4: a command handler that throws rejects the caller and nothing else (native CommandRegistry behaviour)', async () => {
    h = await boot();
    const { win } = h;
    await win.app.commands.execute('tasks.add'); // activate
    await expect(win.app.commands.execute('tasks.complete')).rejects.toThrow('Select a task first');
    await expect(win.app.commands.execute('tasks.add', { title: 'after' })).resolves.toBeTypeOf('number');
  });

  it('C4: deactivation disposes everything the plugin registered, and the plugin can activate again', async () => {
    h = await boot();
    const { win } = h;
    await win.app.commands.execute('tasks.add', { title: 'a' });
    const first = win.windowScope.get(ITasks);
    const placement = await win.open('tasks.list', 'editor');
    await win.plugins.deactivate('sample.tasks');
    expect(win.plugins.state('sample.tasks')).toBe('inactive');
    expect(win.windowScope.tryGet(ITasks)).toBeUndefined(); // the provided service left the DI container
    expect(placement.widget.isDisposed).toBe(true); // its views were closed
    expect(first.root.isDisposed).toBe(true); // its WorkItems ended
    expect(win.views.all()).toHaveLength(0);
    // The command declaration stays (contribution), its handler is gone until the next activation.
    expect(win.app.commands.hasCommand('tasks.add')).toBe(true);
    await win.app.commands.execute('tasks.add', { title: 'again' });
    const second = win.windowScope.get(ITasks);
    expect(second).not.toBe(first);
    expect(second.store.tasks.map((t) => t.title)).toEqual(['again']);
  });

  it('C4: LIMIT (native): deactivatePlugin throws a TypeError when the plugin or any dependent has no deactivate()', async () => {
    const Service = new Token<object>('svc');
    const app = new Application({ shell: new Widget() });
    app.registerPlugin({ id: 'provider', provides: Service, activate: () => ({}), deactivate: () => {} });
    app.registerPlugin({ id: 'dependent', requires: [Service], activate: () => {} }); // no deactivate
    await app.activatePlugin('dependent');
    await expect(app.deactivatePlugin('provider')).rejects.toThrow(TypeError);
    expect(app.isPluginActivated('provider')).toBe(true); // nothing was deactivated
  });

  it('C4: LIMIT (native): a second plugin that provides the same token silently replaces the first', async () => {
    const Service = new Token<{ who: string }>('svc');
    const app = new Application({ shell: new Widget() });
    app.registerPlugin({ id: 'first', provides: Service, activate: () => ({ who: 'first' }) });
    expect(() => app.registerPlugin({ id: 'second', provides: Service, activate: () => ({ who: 'second' }) })).not.toThrow();
    expect((await app.resolveRequiredService(Service)).who).toBe('second');
    expect(app.isPluginActivated('first')).toBe(false);
  });

  it('C4: LIMIT (native): there is no record of a failure and no way to retry state; Application has no stop() for its document listeners', () => {
    const app = new Application({ shell: new Widget() });
    expect('stop' in app).toBe(false);
    expect('dispose' in app).toBe(false);
  });
});

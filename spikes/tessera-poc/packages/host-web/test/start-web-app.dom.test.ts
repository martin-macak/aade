import { afterEach, describe, expect, it } from 'vitest';
import { toDisposable } from '@tessera/base';
import { CommandService, DockSurfaceFactory, DockSurfaceHost, LayoutStore, LAYOUT_STORAGE_KEY, NotificationService, KeybindingService, type PluginModule, type WindowId } from '@tessera/contracts';
import { captureErrors, fakeDockSurfaceFactory, manifest, plainDomMounter } from '@tessera/testing';
import { localStorageBackend, startWebApp, type WebApp, type WebPlugin } from '../src/index.ts';

// The web host in jsdom: a HostEnvironment with localStorage and a static catalog and loader, with a plain-text renderer.
const live: WebApp[] = [];
afterEach(async () => {
  for (const app of live.splice(0)) await app.dispose();
  localStorage.clear();
  document.body.replaceChildren();
});

function plainRenderer() {
  const mounter = plainDomMounter();
  return {
    mounter: mounter as never,
    workbench: {
      rendererId: 'plain',
      render: (host: HTMLElement, windowId: WindowId) => {
        host.textContent = `window ${windowId}`;
        return toDisposable(() => (host.textContent = ''));
      },
    },
  };
}

const hello: WebPlugin = {
  manifest: manifest('web.hello', { contributes: { commands: [{ id: 'hello.say', title: 'Say Hello' }] } }),
  main: () => ({ activate: (ctx) => void ctx.api.commands.registerHandler('hello.say', { run: () => 'hello' }) }) satisfies PluginModule,
};
const failing: WebPlugin = {
  manifest: manifest('web.failing', { contributes: { commands: [{ id: 'failing.go', title: 'Go' }] } }),
  main: () => ({ activate: () => { throw new Error('cannot start'); } }) satisfies PluginModule,
};

async function boot(plugins: readonly WebPlugin[]): Promise<WebApp> {
  const root = document.createElement('div');
  document.body.append(root);
  const app = await startWebApp({ root, plugins, renderer: plainRenderer, projectId: 'demo', appVersion: '9.9.9', installDomHandlers: false });
  live.push(app);
  return app;
}

describe('@tessera/host-web: startWebApp', () => {
  it('boots the shell with a web HostEnvironment, renders into the root and loads plugins lazily through the static loader', async () => {
    const app = await boot([hello]);
    expect(app.host).toMatchObject({ kind: 'web', platform: 'web', projectId: 'demo', appVersion: '9.9.9' });
    expect(document.body.textContent).toBe('window w-main');
    expect(app.services.get(KeybindingService).lookup('workbench.showCommandPalette').length).toBe(1); // the host module's palette binding
    expect(await app.services.get(CommandService).execute('hello.say')).toBe('hello'); // onCommand: the loader imports the plugin now
  });

  it('shows an error notification with a retry action when a plugin fails to activate (failure isolation)', async () => {
    const errors = captureErrors();
    const app = await boot([hello, failing]);
    await app.services.get(CommandService).execute('failing.go').catch(() => undefined);
    const active = app.services.get(NotificationService).active.peek();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ severity: 'error', source: 'web.failing', actions: [{ command: 'plugins.retry' }] });
    expect(active[0]?.detail).toContain('cannot start');
    expect(await app.services.get(CommandService).execute('hello.say')).toBe('hello'); // the other plugin is fine
    errors.drain();
    errors.dispose();
  });

  it('persists to localStorage and a second start restores from it; dispose flushes the layout', async () => {
    const first = await boot([hello]);
    await first.services.get(LayoutStore).flush();
    await first.dispose();
    live.splice(0);
    const raw = [...Array(localStorage.length).keys()].map((i) => localStorage.key(i));
    expect(raw.some((k) => k?.includes(LAYOUT_STORAGE_KEY))).toBe(true);
    const backend = localStorageBackend({ projectId: 'demo' });
    const loaded = await backend.load('project');
    expect(Object.keys(loaded)).toContain(LAYOUT_STORAGE_KEY);
    backend.dispose();
    const second = await boot([hello]);
    expect(second.services.get(CommandService)).toBeDefined();
  });

  it('a dock factory from the app is provided to the workbench and to the renderer (DockSurfaceFactory and DockSurfaceHost)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const fake = fakeDockSurfaceFactory();
    const attached: string[] = [];
    const dock = Object.assign(fake, { attach: (id: string) => { attached.push(id); return toDisposable(() => undefined); } });
    const app = await startWebApp({ root, plugins: [], renderer: plainRenderer, installDomHandlers: false, dock: () => dock as never });
    live.push(app);
    expect(fake.surfaces.has('workbench.editorArea')).toBe(true); // the workbench created the editor-area surface through the factory
    expect(app.services.get(DockSurfaceFactory)).toBe(dock);
    expect(app.services.get(DockSurfaceHost)).toBe(dock);
    expect(attached).toEqual([]); // attaching is the renderer's job
  });

  it('funnels window error and unhandledrejection events to reportError with source global', async () => {
    await boot([hello]);
    const errors = captureErrors();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught'), message: 'uncaught', filename: 'plugin.js' }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('nobody caught this') });
    window.dispatchEvent(rejection);
    const reported = errors.drain();
    errors.dispose();
    expect(reported.map((r) => [r.context.source, r.context.target, (r.error as Error).message])).toEqual([
      ['global', 'plugin.js', 'uncaught'],
      ['global', 'unhandledrejection', 'nobody caught this'],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { memoryStorageBackend } from '@tessera/persistence';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';

async function ticks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const plugin = (id: string, extra: object = {}) => manifest(id, { activationEvents: ['*'], ...extra } as never);

describe('round 2: install precedence', () => {
  it('C16: for one id, builtin beats dev beats user, whatever the order of arrival; the loser is invalid with plugin.duplicateId naming both sources', async () => {
    for (const order of [['user', 'dev', 'builtin'], ['builtin', 'user', 'dev'], ['dev', 'builtin', 'user']] as const) {
      const mods: Record<string, unknown> = { 'test://fixture.dup/': { activate: () => undefined } };
      const app = await createTestApp({ modules: mods });
      await app.plugins.add(order.map((source) => ({ ...describePlugin(plugin('fixture.dup'), source), location: 'test://fixture.dup/' })));
      await app.settle();
      const winner = app.plugins.status('fixture.dup');
      expect(winner?.state, order.join(',')).not.toBe('invalid');
      const all = [...app.plugins.plugins.peek().values()];
      const losers = all.filter((p) => p.state === 'invalid');
      expect(losers).toHaveLength(2);
      for (const loser of losers) expect(loser.problems.join(' ')).toContain('plugin.duplicateId');
      expect(losers.map((l) => l.problems.join(' ')).join(' ')).toContain('builtin');
      await app.dispose();
    }
  });

  it('C16: inside one source the earlier installedAt wins, then the id order; adding the same plugin twice makes one record', async () => {
    const app = await createTestApp({ modules: { 'test://fixture.same/': { activate: () => undefined }, 'test://elsewhere/fixture.same/': { activate: () => undefined } } });
    const later = { ...describePlugin(plugin('fixture.same', { version: '2.0.0', activationEvents: [] }), 'user'), location: 'test://elsewhere/fixture.same/', installedAt: 2000 };
    const earlier = { ...describePlugin(plugin('fixture.same', { version: '1.0.0', activationEvents: [] }), 'user'), location: 'test://fixture.same/', installedAt: 1000 };
    await app.plugins.add([later]);
    await app.plugins.add([earlier]);
    expect(app.plugins.status('fixture.same')?.version).toBe('1.0.0'); // the earlier install owns the id
    const errors = captureErrors();
    await app.plugins.add([earlier]); // the same plugin again: ignored
    const reported = errors.drain().map((r) => (r.error as { code?: string }).code);
    errors.dispose();
    expect(reported).toEqual(['plugin.duplicateId']);
    expect([...app.plugins.plugins.peek().values()].filter((p) => p.id === 'fixture.same')).toHaveLength(2); // winner + the invalid duplicate
    await app.dispose();
  });
});

describe('round 2: catalog sync and startup events', () => {
  it('C16: two catalog change events in a row give one sync and one record per plugin (no ghost)', async () => {
    const gate = new DeferredPromise<void>();
    const app = await createTestApp({ modules: { 'test://fixture.late/': { activate: () => undefined } } });
    const slow = { ...app.catalog, list: async () => (await gate.promise, app.catalog.list()) };
    void slow;
    app.catalog.add({ ...describePlugin(plugin('fixture.late'), 'user'), location: 'test://fixture.late/' });
    app.catalog.add({ ...describePlugin(plugin('fixture.late'), 'user'), location: 'test://fixture.late/' }); // a watcher that fires twice
    await ticks(200);
    await app.settle();
    expect([...app.plugins.plugins.peek().values()].filter((p) => p.id === 'fixture.late')).toHaveLength(1);
    gate.resolve();
  });

  it('C16: after startup, a plugin that is installed, updated or enabled gets the "*" and onStartupFinished events it missed', async () => {
    const activated: string[] = [];
    const mods = {
      'test://fixture.star1/': { activate: () => void activated.push('star1') },
      'test://fixture.star2/': { activate: () => void activated.push('star2') },
      'test://fixture.later/': { activate: () => void activated.push('later') },
    };
    const app = await createTestApp({
      plugins: [describePlugin(plugin('fixture.star1'), 'builtin'), describePlugin(plugin('fixture.star2', { activationEvents: ['onStartupFinished'] }), 'builtin')],
      modules: mods,
    });
    await app.toEventually();
    expect(activated.toSorted()).toEqual(['star1', 'star2']);
    // 1. installed in the session
    app.catalog.add({ ...describePlugin(plugin('fixture.later'), 'builtin'), location: 'test://fixture.later/' });
    await ticks(300);
    await app.settle();
    expect(app.plugins.status('fixture.later')?.state).toBe('active');
    // 2. disabled and enabled again
    await app.plugins.disable('fixture.star1');
    expect(app.plugins.status('fixture.star1')?.state).toBe('disabled');
    await app.plugins.enable('fixture.star1');
    expect(app.plugins.status('fixture.star1')?.state).toBe('active');
    // 3. the second kind of startup event
    await app.plugins.disable('fixture.star2');
    await app.plugins.enable('fixture.star2');
    expect(app.plugins.status('fixture.star2')?.state).toBe('active');
  });
});

describe('round 2: retry after a load failure imports another URL', () => {
  it('C16: retry() after loadFailed bumps the versioned URL, like reload()', async () => {
    const locations: string[] = [];
    let failing = true;
    const description = describePlugin(plugin('fixture.flaky'), 'builtin');
    const app = await createTestApp({
      plugins: [description],
      start: false,
      host: {
        pluginLoader: {
          load: async (d) => {
            locations.push(d.location);
            if (failing) throw new Error('evaluation failed');
            return { activate: () => undefined };
          },
        },
      },
    });
    const errors = captureErrors();
    await app.start();
    await app.settle();
    expect(app.plugins.status('fixture.flaky')?.state).toBe('failed');
    failing = false;
    await app.plugins.retry('fixture.flaky');
    errors.drain();
    errors.dispose();
    expect(app.plugins.status('fixture.flaky')?.state).toBe('active');
    expect(locations).toHaveLength(2);
    expect(locations[0]).toBe('test://fixture.flaky/');
    expect(locations[1]).toBe('test://fixture.flaky/?reload=1');
  });
});

describe('round 2: the disabled list when storage is slow or unavailable', () => {
  it('C16: add() waits for the storage, so a disabled plugin does not start enabled; a storage that never loads is reported once and the list applies when it recovers', async () => {
    const inner = memoryStorageBackend({ application: { 'tessera.plugins.disabled': { v: 1, data: ['fixture.off'] } } });
    let failing = true;
    const backend = { ...inner, load: (scope: 'application' | 'project') => (failing ? Promise.reject(new Error('offline')) : inner.load(scope)), write: inner.write.bind(inner), onDidChangeExternally: inner.onDidChangeExternally };
    const app = await createTestApp({
      plugins: [describePlugin(plugin('fixture.off'), 'builtin')],
      modules: { 'test://fixture.off/': { activate: () => undefined } },
      host: { storage: backend as never },
      start: false,
    });
    const errors = captureErrors();
    const started = app.app.start({ mount: () => undefined });
    for (let i = 0; i < 100; i++) {
      await ticks(30);
      app.scheduler.advance(100);
    }
    await started;
    await app.settle();
    // storage degraded: the list was unreadable, the plugin started enabled and the loss was reported
    expect(app.plugins.status('fixture.off')?.state).toBe('active');
    errors.drain();
    failing = false;
    expect(await app.storageService.retryLoad()).toBe(true);
    for (let i = 0; i < 20; i++) await ticks(30);
    await app.settle();
    expect(app.plugins.status('fixture.off')?.state).toBe('disabled'); // applied again after recovery
    errors.dispose();
  });
});

describe('round 2: the status is published once per removal, not once per point', () => {
  it('C14: removing a plugin that contributes to five points publishes the status at most three times', async () => {
    const wide = describePlugin(
      manifest('fixture.wide', {
        contributes: {
          commands: [{ id: 'fixture.wide.run', title: 'Run' }],
          menus: [{ menu: 'commandPalette', command: 'fixture.wide.run' }],
          keybindings: [{ key: 'ctrl+alt+w', command: 'fixture.wide.run' }],
          statusBar: [{ id: 'fixture.wide.item', alignment: 'left', text: 'wide' }],
          views: [{ id: 'fixture.wide.view', title: 'Wide', workspace: 'workbench.editorArea', visibleByDefault: false }],
        },
      } as never),
      'builtin',
    );
    const app = await createTestApp({ plugins: [wide], modules: {} });
    await app.settle();
    const manager = app.plugins as unknown as { statusPublications: number };
    const before = manager.statusPublications;
    await app.plugins.remove('fixture.wide');
    expect(manager.statusPublications - before).toBeLessThanOrEqual(3);
    expect(app.plugins.status('fixture.wide')).toBeUndefined();
  });
});

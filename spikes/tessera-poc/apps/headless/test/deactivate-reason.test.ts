import { describe, expect, it } from 'vitest';
import { createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';

// uninstall-update-lifecycle-unspecified: deactivate(reason) with the reasons shutdown, disable, reload, uninstall and update.
function recorder() {
  const reasons: Array<string | undefined> = [];
  const versions: string[] = [];
  const module = { activate: () => void versions.push('activated'), deactivate: (reason?: string) => void reasons.push(reason) };
  return { reasons, versions, module };
}

async function boot(version = '1.0.0'): Promise<{ app: TestApp; reasons: Array<string | undefined>; versions: string[] }> {
  const { reasons, versions, module } = recorder();
  const description = describePlugin(manifest('fixture.reason', { version, activationEvents: ['*'] }), 'builtin');
  const app = await createTestApp({ plugins: [description], modules: { [description.location]: module } });
  expect(app.plugins.status('fixture.reason')?.state).toBe('active');
  return { app, reasons, versions };
}

describe('C16: deactivate(reason)', () => {
  it('C16: disable passes "disable"', async () => {
    const { app, reasons } = await boot();
    await app.plugins.disable('fixture.reason');
    expect(reasons).toEqual(['disable']);
  });

  it('C16: reload passes "reload"', async () => {
    const { app, reasons } = await boot();
    await app.plugins.reload('fixture.reason');
    expect(reasons).toEqual(['reload']);
    expect(app.plugins.status('fixture.reason')?.state).toBe('active');
  });

  it('C16: removing the plugin from the catalog passes "uninstall"', async () => {
    const { app, reasons } = await boot();
    app.catalog.remove('fixture.reason');
    await app.settle();
    expect(reasons).toEqual(['uninstall']);
    expect(app.plugins.status('fixture.reason')).toBeUndefined();
  });

  it('C16: a new version in the catalog is a reload: the old one ends with "update", the new one is added and reported', async () => {
    const { app, reasons, versions } = await boot('1.0.0');
    const newer = describePlugin(manifest('fixture.reason', { version: '1.1.0', activationEvents: ['*'] }), 'builtin');
    app.catalog.replace(newer);
    await app.settle();
    expect(reasons).toEqual(['update']);
    expect(app.plugins.status('fixture.reason')?.version).toBe('1.1.0');
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(app.logs.some((l) => l.message.includes('changed to version 1.1.0'))).toBe(true);
  });

  it('C16: shutdown passes "shutdown"', async () => {
    const { app, reasons } = await boot();
    await app.app.shutdown('close');
    expect(reasons).toEqual(['shutdown']);
  });
});

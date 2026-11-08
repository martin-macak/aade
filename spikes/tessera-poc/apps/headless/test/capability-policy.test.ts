import { describe, expect, it } from 'vitest';
import { token } from '@tessera/di';
import { type HostPluginService, type PluginPolicy, type PluginContext, type PluginDescription, type ServiceModule } from '@tessera/contracts';
import { createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';
import { createDemoApp } from '@tessera-poc/headless';

const denied = expect.objectContaining({ code: 'plugin.capabilityDenied' });

async function withPlugin(source: 'builtin' | 'user' | 'dev', extra: Parameters<typeof manifest>[1], options: { policy?: PluginPolicy } = {}) {
  const description = describePlugin(manifest('fixture.cap', extra), source);
  let ctx: PluginContext | undefined;
  const app = await createDemoApp({ only: [], extraPlugins: [description], extraModules: { [description.location]: { activate: (c: PluginContext) => void (ctx = c) } }, ...(options.policy ? { pluginPolicy: options.policy } : {}) });
  await app.plugins.activate('fixture.cap');
  return { app, ctx: ctx as PluginContext, description };
}

describe('C29: manifest validation (capabilities-self-granted-no-host-policy)', () => {
  it('C29: trust "isolated" makes the manifest invalid; an unknown capability, activation event or key is a warning and is ignored (forward compatibility)', async () => {
    const app = await createDemoApp({
      only: [],
      extraPlugins: [
        describePlugin(manifest('fixture.badcap', { capabilities: ['everything'] })),
        describePlugin(manifest('fixture.badevent', { activationEvents: ['onWhenever'] })),
        describePlugin({ ...manifest('fixture.newkey'), surprise: true }),
        describePlugin(manifest('fixture.isolated', { trust: 'isolated' })),
        describePlugin(manifest('fixture.goodcap', { capabilities: ['service:acme.app/Thing'], activationEvents: ['onCommand:a.b', 'onView:a.v', 'onStartupFinished'] })),
      ],
    });
    expect(app.plugins.status('fixture.isolated')?.state).toBe('invalid');
    expect(app.plugins.status('fixture.isolated')?.problems.join(' ')).toContain('isolated');
    for (const id of ['fixture.badcap', 'fixture.badevent', 'fixture.newkey']) expect(app.plugins.status(id)?.state).not.toBe('invalid');
    expect(app.plugins.status('fixture.badcap')?.problems.join(' ')).toContain('plugin.manifestWarning: unknown capability "everything"');
    expect(app.plugins.status('fixture.badevent')?.problems.join(' ')).toContain('plugin.manifestWarning: unknown activation event "onWhenever"');
    expect(app.plugins.status('fixture.newkey')?.problems.join(' ')).toContain('plugin.manifestWarning: unknown manifest key "surprise"');
    expect(app.plugins.status('fixture.goodcap')?.state).not.toBe('invalid');
  });
});

describe('C29: the host policy grants capabilities by source', () => {
  it('C29: by default a builtin plugin gets what it declares', async () => {
    const { ctx, app } = await withPlugin('builtin', { capabilities: ['context.global'] });
    expect(() => ctx.api.context.set('other.key', true)).not.toThrow();
    expect(app.plugins.status('fixture.cap')?.problems).toEqual([]);
  });

  it('the reserved platform capabilities (fs.read, secrets, ...) are known names that the default policy never grants, even to a builtin plugin', async () => {
    const { app } = await withPlugin('builtin', { capabilities: ['fs.read', 'secrets', 'process.spawn', 'context.global'] });
    const problems = app.plugins.status('fixture.cap')?.problems ?? [];
    expect(problems.filter((p) => p.startsWith('plugin.capabilityDenied')).map((p) => /"([^"]+)"/.exec(p)?.[1]).toSorted()).toEqual(['fs.read', 'process.spawn', 'secrets']);
    expect(problems.some((p) => p.startsWith('plugin.manifestWarning'))).toBe(false); // known names: no unknown-capability warning
  });

  it('C29: by default a user plugin gets no elevated capability, and the refusal is a problem in its status', async () => {
    const { ctx, app } = await withPlugin('user', { capabilities: ['context.global', 'interceptors.guard'] });
    expect(() => ctx.api.context.set('other.key', true)).toThrowError(denied);
    expect(app.plugins.status('fixture.cap')?.problems.filter((p) => p.startsWith('plugin.capabilityDenied'))).toHaveLength(2);
    expect(app.plugins.status('fixture.cap')?.state).toBe('active'); // it runs, with less
  });

  it('C29: a dev plugin gets what it declares', async () => {
    const { ctx } = await withPlugin('dev', { capabilities: ['context.global'] });
    expect(() => ctx.api.context.set('other.key', true)).not.toThrow();
  });

  it('C29: a host policy decides: it can grant a user plugin one capability and refuse another', async () => {
    const policy: PluginPolicy = { grant: (d: PluginDescription) => new Set(d.manifest.capabilities?.filter((c) => c === 'context.global')) };
    const { ctx, app } = await withPlugin('user', { capabilities: ['context.global', 'commands.force'] }, { policy });
    expect(() => ctx.api.context.set('other.key', true)).not.toThrow();
    expect(app.plugins.status('fixture.cap')?.problems.join(' ')).toContain('"commands.force"');
  });
});

describe('C29: services of the host product (third-party-feature-gaps, part 1)', () => {
  const Product = token<{ readonly n: number }>('acme.app/GitService');
  const productModule: ServiceModule = {
    id: 'acme.product',
    install({ window }) {
      window.provideValue(Product, { n: 42 }, { owner: 'acme.app' });
    },
  };
  const service: HostPluginService<{ readonly n: number }> = {
    token: Product,
    capability: 'service:acme.app/GitService',
    facade: (pluginId) => (value) => ({ n: value.n + pluginId.length }),
  };

  async function boot(source: 'builtin' | 'user', capabilities: string[] | undefined, services: readonly HostPluginService[] = [service as HostPluginService]): Promise<{ app: TestApp; ctx: PluginContext }> {
    const description = describePlugin(manifest('fixture.git', { requires: [Product.id], ...(capabilities ? { capabilities } : {}) }), source);
    let ctx: PluginContext | undefined;
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: { activate: (c: PluginContext) => void (ctx = c) } }, appModules: [productModule], pluginServices: services });
    await app.plugins.activate('fixture.git').catch(() => undefined);
    return { app, ctx: ctx as PluginContext };
  }

  it('C29: a product token resolves for a plugin that holds the capability, through the per-plugin facade', async () => {
    const { app, ctx } = await boot('builtin', ['service:acme.app/GitService']);
    expect(app.plugins.status('fixture.git')?.state).toBe('active');
    expect(ctx.services.get(Product).n).toBe(42 + 'fixture.git'.length);
  });

  it('C29: it is refused without the capability: the status says so, and every door throws plugin.capabilityDenied', async () => {
    const { app, ctx } = await boot('builtin', undefined);
    expect(app.plugins.status('fixture.git')?.problems.join(' ')).toContain('needs capability "service:acme.app/GitService"');
    expect(() => ctx.services.get(Product)).toThrowError(denied);
    expect(() => ctx.services.getOptional(Product)).toThrowError(denied);
  });

  it('C29: a user plugin cannot hold the capability under the default policy', async () => {
    const { ctx } = await boot('user', ['service:acme.app/GitService']);
    expect(() => ctx.services.get(Product)).toThrowError(denied);
  });

  it('C29: a service without capability is open to every plugin, and a plugin cannot provide a product token', async () => {
    const open: HostPluginService = { token: Product };
    const first = await boot('user', undefined, [open]);
    expect(first.ctx.services.get(Product).n).toBe(42);
    await first.app.dispose(); // one live Application per realm (shell.secondApplication)
    const app = await createTestApp({
      plugins: [describePlugin(manifest('fixture.thief', { provides: [Product.id] }))],
      appModules: [productModule],
      pluginServices: [open],
    });
    expect(app.plugins.status('fixture.thief')?.state).toBe('invalid');
  });
});

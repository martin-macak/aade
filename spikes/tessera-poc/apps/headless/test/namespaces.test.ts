import { describe, expect, it } from 'vitest';
import { CommandRegistry, ContributionRegistry, ViewRegistry, defineContributionPoint, type CommandContext, type PluginContext } from '@tessera/contracts';
import { createTestApp, describePlugin, manifest } from '@tessera/testing';

const denied = expect.objectContaining({ code: 'plugin.capabilityDenied' });
const problemsOf = (app: Awaited<ReturnType<typeof createTestApp>>, id: string): string => (app.plugins.status(id)?.problems ?? []).join('\n');

describe('C14: identifiers are owned (identifier-namespaces-not-owned)', () => {
  it('C14: the first installed plugin owns a command id: a later plugin gets plugin.duplicateContribution, still resolves, and the first command stays', async () => {
    const first = describePlugin(manifest('fixture.first', { contributes: { commands: [{ id: 'shared.run', title: 'First' }] } }));
    const second = describePlugin(manifest('fixture.second', { contributes: { commands: [{ id: 'shared.run', title: 'Second' }, { id: 'second.only', title: 'Only' }] } }));
    const app = await createTestApp({ plugins: [first, second] });
    expect(app.plugins.status('fixture.second')?.state).toBe('resolved');
    expect(problemsOf(app, 'fixture.second')).toContain('plugin.duplicateContribution: commands[0] id "shared.run" is already contributed by "fixture.first"');
    const commands = app.get(CommandRegistry);
    expect(commands.metadata('shared.run')).toMatchObject({ title: 'First', owner: 'fixture.first' });
    expect(commands.metadata('second.only')?.owner).toBe('fixture.second'); // the other entries of the plugin still apply
    expect(problemsOf(app, 'fixture.first')).toBe('');
  });

  it('C14: the order is the install order, not the name', async () => {
    const z = describePlugin(manifest('fixture.zzz', { contributes: { commands: [{ id: 'shared.run', title: 'Z' }] } }));
    const a = describePlugin(manifest('fixture.aaa', { contributes: { commands: [{ id: 'shared.run', title: 'A' }] } }));
    const app = await createTestApp({ plugins: [z, a] });
    expect(app.get(CommandRegistry).metadata('shared.run')?.owner).toBe('fixture.zzz');
    expect(problemsOf(app, 'fixture.aaa')).toContain('already contributed by "fixture.zzz"');
  });

  it('I29: ownership follows rank, not arrival: a late dev plugin takes the id from a user plugin, and disabling it gives the id back', async () => {
    const user = describePlugin(manifest('fixture.user', { contributes: { commands: [{ id: 'shared.run', title: 'User' }] } }), 'user');
    const app = await createTestApp({ plugins: [user] });
    expect(app.get(CommandRegistry).metadata('shared.run')?.owner).toBe('fixture.user');
    const dev = describePlugin(manifest('fixture.dev', { contributes: { commands: [{ id: 'shared.run', title: 'Dev' }] } }), 'dev');
    await app.plugins.add([dev]);
    expect(app.get(CommandRegistry).metadata('shared.run')).toMatchObject({ owner: 'fixture.dev', title: 'Dev' });
    expect(problemsOf(app, 'fixture.user')).toContain('plugin.duplicateContribution: commands[0] id "shared.run" is already contributed by "fixture.dev"');
    expect(problemsOf(app, 'fixture.dev')).toBe('');
    await app.plugins.disable('fixture.dev');
    expect(app.get(CommandRegistry).metadata('shared.run')).toMatchObject({ owner: 'fixture.user', title: 'User' });
    expect(problemsOf(app, 'fixture.user')).toBe(''); // the same as a fresh start with only the user plugin
    await app.plugins.enable('fixture.dev');
    expect(app.get(CommandRegistry).metadata('shared.run')?.owner).toBe('fixture.dev');
  });

  it('I29: any order of add gives the same owners (a builtin added last still owns the id)', async () => {
    const make = (id: string, source: 'builtin' | 'dev' | 'user') => describePlugin(manifest(id, { contributes: { commands: [{ id: 'shared.run', title: id }] } }), source);
    const orders = [
      ['fixture.b', 'fixture.d', 'fixture.u'],
      ['fixture.u', 'fixture.d', 'fixture.b'],
      ['fixture.d', 'fixture.u', 'fixture.b'],
    ];
    for (const order of orders) {
      const all = { 'fixture.b': make('fixture.b', 'builtin'), 'fixture.d': make('fixture.d', 'dev'), 'fixture.u': make('fixture.u', 'user') } as const;
      const app = await createTestApp({ plugins: [] });
      for (const id of order) await app.plugins.add([all[id as keyof typeof all]]);
      expect(app.get(CommandRegistry).metadata('shared.run')?.owner).toBe('fixture.b');
      expect(problemsOf(app, 'fixture.b')).toBe('');
      expect(problemsOf(app, 'fixture.d')).toContain('already contributed by "fixture.b"');
      await app.plugins.remove('fixture.b');
      expect(app.get(CommandRegistry).metadata('shared.run')?.owner).toBe('fixture.d');
      await app.dispose();
    }
  });

  it('C14: a plugin cannot declare a command id that the core declared', async () => {
    const thief = describePlugin(manifest('fixture.thief', { contributes: { commands: [{ id: 'workbench.closePlacement', title: 'Not Close' }] } }));
    const app = await createTestApp({ plugins: [thief] });
    expect(app.get(CommandRegistry).metadata('workbench.closePlacement')?.owner).not.toBe('fixture.thief');
    expect(problemsOf(app, 'fixture.thief')).toContain('plugin.duplicateContribution: commands[0]');
  });

  it('C14: a view type and a setting key have one owner too; disabling the later declarer keeps the first view', async () => {
    const view = (title: string) => ({ contributes: { views: [{ id: 'shared.view', title, workspace: 'workbench.editorArea', visibleByDefault: false }], configuration: [{ key: 'shared.setting', type: 'boolean', default: true }] } });
    const first = describePlugin(manifest('fixture.vfirst', view('First view')));
    const second = describePlugin(manifest('fixture.vsecond', view('Second view')));
    const app = await createTestApp({ plugins: [first, second] });
    expect(app.get(ViewRegistry).descriptor('shared.view')).toMatchObject({ title: 'First view', owner: 'fixture.vfirst' });
    expect(problemsOf(app, 'fixture.vsecond')).toMatch(/views\[0\].*already (contributed|declared)/);
    expect(problemsOf(app, 'fixture.vsecond')).toContain('configuration[0] id "shared.setting"');
    await app.plugins.disable('fixture.vsecond');
    expect(app.get(ViewRegistry).descriptor('shared.view')?.owner).toBe('fixture.vfirst'); // the later declarer never owned it
    expect(app.configuration.get('shared.setting')).toBe(true);
  });

  it('C14: a foreign handler needs the owner\'s consent: only for a command declared extensible and only with a when clause, or the capability commands.override', async () => {
    const owner = describePlugin(
      manifest('fixture.owner', { contributes: { commands: [{ id: 'owner.run', title: 'Run', extensible: true }, { id: 'owner.closed', title: 'Closed' }] } }),
      'builtin',
    );
    const other = describePlugin(manifest('fixture.other', { capabilities: ['commands.override'] }), 'builtin');
    const plain = describePlugin(manifest('fixture.plain'), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const modules = Object.fromEntries([owner, other, plain].map((d) => [d.location, { activate: (c: PluginContext) => void (ctxs[d.manifest.id] = c) }]));
    const app = await createTestApp({ plugins: [owner, other, plain], modules });
    for (const id of ['fixture.owner', 'fixture.other', 'fixture.plain']) await app.plugins.activate(id);
    const ownerCtx = ctxs['fixture.owner'] as PluginContext;
    const plainCtx = ctxs['fixture.plain'] as PluginContext;
    const overrideCtx = ctxs['fixture.other'] as PluginContext;
    expect(() => ownerCtx.api.commands.registerHandler('owner.run', { run: () => 'own' })).not.toThrow(); // its own command
    expect(() => plainCtx.api.commands.registerHandler('owner.run', { run: () => 'hijack' })).toThrowError(denied); // a bare handler for a foreign command
    expect(() => plainCtx.api.commands.registerHandler('workbench.closePlacement', { run: () => 'hijack' })).toThrowError(denied); // a core command
    expect(() => plainCtx.api.commands.registerHandler('owner.closed', { when: 'true', run: () => 'scoped' })).toThrowError(denied); // not extensible: a when clause does not help
    expect(() => plainCtx.api.commands.registerHandler('owner.run', { when: 'false', run: () => 'scoped' })).not.toThrow(); // extensible and scoped
    expect(() => overrideCtx.api.commands.registerHandler('owner.closed', { run: () => 'override' })).not.toThrow(); // the capability
    expect(await app.commands.execute('owner.closed')).toBe('override');
    expect(await app.commands.execute('owner.run')).toBe('own');
    void (undefined as unknown as CommandContext);
  });

  it('C14: ranking: a foreign handler with a tautological when loses to an owner scoped handler and wins over an owner bare handler; a foreign priority counts as 0', async () => {
    const owner = describePlugin(manifest('fixture.owner', { contributes: { commands: [{ id: 'owner.run', title: 'Run', extensible: true }] } }), 'builtin');
    const guest = describePlugin(manifest('fixture.guest'), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const modules = Object.fromEntries([owner, guest].map((d) => [d.location, { activate: (c: PluginContext) => void (ctxs[d.manifest.id] = c) }]));
    const app = await createTestApp({ plugins: [owner, guest], modules });
    await app.plugins.activate('fixture.owner');
    await app.plugins.activate('fixture.guest');
    const ownerCtx = ctxs['fixture.owner'] as PluginContext;
    const guestCtx = ctxs['fixture.guest'] as PluginContext;
    ownerCtx.api.commands.registerHandler('owner.run', { run: () => 'owner-bare' });
    // an old guest handler with a high priority, a newer one with none: the clamp makes the newer one win
    guestCtx.api.commands.registerHandler('owner.run', { when: 'true', priority: 100, run: () => 'guest-old-high' });
    guestCtx.api.commands.registerHandler('owner.run', { when: 'true', run: () => 'guest-new' });
    expect(await app.commands.execute('owner.run')).toBe('guest-new'); // wins over the owner's bare handler
    ownerCtx.api.commands.registerHandler('owner.run', { when: 'mode', run: () => 'owner-scoped' });
    app.contextKeys.root.set('mode', true);
    expect(await app.commands.execute('owner.run')).toBe('owner-scoped'); // the owner's scoped handler beats a foreign handler with any when
    app.contextKeys.root.set('mode', false);
    expect(await app.commands.execute('owner.run')).toBe('guest-new');
  });

  it('C14: two plugins that define the same contribution point: the later one gets a problem, not an exception', async () => {
    const point = defineContributionPoint<{ id: string }>('shared.point', { safeParse: (i) => ({ success: true, data: i as { id: string } }) });
    const a = describePlugin(manifest('fixture.pa', { contributionPoints: [{ id: 'shared.point' }] }));
    const b = describePlugin(manifest('fixture.pb', { contributionPoints: [{ id: 'shared.point' }] }));
    const ctxs: Record<string, PluginContext> = {};
    const modules = Object.fromEntries([a, b].map((d) => [d.location, { activate: (c: PluginContext) => void (ctxs[d.manifest.id] = c) }]));
    const app = await createTestApp({ plugins: [a, b], modules });
    await app.plugins.activate('fixture.pa');
    await app.plugins.activate('fixture.pb');
    (ctxs['fixture.pa'] as PluginContext).contributions.definePoint(point);
    expect(() => (ctxs['fixture.pb'] as PluginContext).contributions.definePoint(point)).not.toThrow();
    expect(problemsOf(app, 'fixture.pb')).toContain('plugin.duplicateContribution: contribution point "shared.point"');
    expect(app.get(ContributionRegistry).points().filter((p) => p.id === 'shared.point')).toHaveLength(1);
  });
});

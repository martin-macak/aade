import { describe, expect, it } from 'vitest';
import { LifecyclePhase, CommandRegistry, ContributionRegistry } from '@tessera/contracts';
import { describePlugin, invalidManifests, manifest, manifests } from '@tessera/testing';
import { resolvePlugins } from '@tessera/plugins';
import { kit } from './kit.ts';

const resolve = (...list: unknown[]) =>
  resolvePlugins({ descriptions: list.map((m) => describePlugin(m)), apiVersion: '1.0.0', coreTokens: new Set(['tessera.commandService']) });

const stateOf = (r: ReturnType<typeof resolve>, id: string) => {
  const found = [...r.results.values()].find((x) => x.id === id);
  return found ? { state: found.state, code: found.code } : undefined;
};

describe('C14: resolution (pure resolver)', () => {
  it('C14: an invalid manifest is invalid with plugin.invalidManifest', () => {
    const r = resolve(invalidManifests['upperCaseId']);
    expect([...r.results.values()][0]).toMatchObject({ state: 'invalid', code: 'plugin.invalidManifest' });
  });

  it('C14: an engines range that the API version does not satisfy is invalid with plugin.engineMismatch', () => {
    expect(stateOf(resolve(manifests['engineMismatch']), 'fixture.future')).toEqual({ state: 'invalid', code: 'plugin.engineMismatch' });
  });

  it('C14: engines are checked first on the raw JSON: a newer plugin with fields this host does not know gives engineMismatch only', () => {
    const future = { ...manifest('fixture.newer', { engines: { tessera: '^1.4.0' } }), contributionKinds: ['themes'], capabilities: ['time.travel'] };
    const r = resolve(future);
    const result = [...r.results.values()][0];
    expect(result).toMatchObject({ state: 'invalid', code: 'plugin.engineMismatch' });
    expect(result?.problems.join(' ')).not.toContain('plugin.invalidManifest');
    // even a manifest that is otherwise broken reports the engines first
    const broken = { id: 'fixture.broken', name: 3, version: 'x', engines: { tessera: '^3.0.0' } };
    expect([...resolve(broken).results.values()][0]).toMatchObject({ code: 'plugin.engineMismatch' });
  });

  it('C14: a plugin that fits the host resolves and carries one warning per unknown key, capability and activation event', () => {
    const r = resolve({ ...manifest('fixture.fits', { engines: { tessera: '^1.0.0' } }), newField: 1, capabilities: ['time.travel'], activationEvents: ['onFullMoon'] });
    const result = [...r.results.values()][0];
    expect(result).toMatchObject({ state: 'resolved' });
    expect(result?.problems).toHaveLength(3);
    expect(result?.problems.every((p) => p.startsWith('plugin.manifestWarning'))).toBe(true);
  });

  it('C14: a duplicate token provider: the plugin added later is invalid, the first stays resolved', () => {
    const r = resolve(manifests['providerA'], manifests['providerB']);
    expect(stateOf(r, 'fixture.providerA')).toEqual({ state: 'resolved', code: undefined });
    expect(stateOf(r, 'fixture.providerB')).toEqual({ state: 'invalid', code: 'plugin.duplicateProvider' });
    // order of arrival decides, not the name
    const reversed = resolve(manifests['providerB'], manifests['providerA']);
    expect(stateOf(reversed, 'fixture.providerB')?.state).toBe('resolved');
    expect(stateOf(reversed, 'fixture.providerA')?.state).toBe('invalid');
  });

  it('C14: providing a token that the core provides is a duplicate provider', () => {
    expect(stateOf(resolve(manifests['providesCoreToken']), 'fixture.core')).toEqual({ state: 'invalid', code: 'plugin.duplicateProvider' });
  });

  it('C14: a dependency cycle makes every plugin in the cycle invalid with plugin.cycle and the path', () => {
    const r = resolve(manifests['cycleA'], manifests['cycleB'], manifests['valid']);
    expect(stateOf(r, 'fixture.cycleA')).toEqual({ state: 'invalid', code: 'plugin.cycle' });
    expect(stateOf(r, 'fixture.cycleB')).toEqual({ state: 'invalid', code: 'plugin.cycle' });
    expect(stateOf(r, 'fixture.valid')?.state).toBe('resolved');
    const problems = [...r.results.values()].find((x) => x.id === 'fixture.cycleA')?.problems.join('\n');
    expect(problems).toMatch(/fixture\.cycleA -> fixture\.cycleB -> fixture\.cycleA|fixture\.cycleB -> fixture\.cycleA -> fixture\.cycleB/);
  });

  it('C14: an optional edge that would close a cycle is dropped with a problem; both plugins resolve (optional-edge-cycle-fatal)', () => {
    const a = manifest('fixture.optA', { provides: ['fixture/OptA'], optional: ['fixture/OptB'] });
    const b = manifest('fixture.optB', { provides: ['fixture/OptB'], requires: ['fixture/OptA'] });
    const r = resolve(a, b);
    expect(stateOf(r, 'fixture.optA')).toEqual({ state: 'resolved', code: undefined });
    expect(stateOf(r, 'fixture.optB')).toEqual({ state: 'resolved', code: undefined });
    expect(r.order.indexOf('fixture.optA')).toBeLessThan(r.order.indexOf('fixture.optB')); // the hard edge decides
    const resultA = [...r.results.values()].find((x) => x.id === 'fixture.optA');
    expect(resultA?.dependsOn).toEqual([]);
    expect(resultA?.problems.join('\n')).toContain('optional dependency "fixture.optB" is ignored');
  });

  it('C14: an optional edge without a cycle still orders the activation', () => {
    const a = manifest('fixture.ordA', { provides: ['fixture/OrdA'], optional: ['fixture/OrdB'] });
    const b = manifest('fixture.ordB', { provides: ['fixture/OrdB'] });
    const r = resolve(a, b);
    expect(r.order.indexOf('fixture.ordB')).toBeLessThan(r.order.indexOf('fixture.ordA'));
  });

  it('C14: only the real members of a hard cycle get plugin.cycle; a plugin that depends on a cyclic one is unresolved and says so', () => {
    const c1 = manifest('fixture.cyc1', { provides: ['fixture/Cyc1'], requires: ['fixture/Cyc2'] });
    const c2 = manifest('fixture.cyc2', { provides: ['fixture/Cyc2'], requires: ['fixture/Cyc1'] });
    const down = manifest('fixture.down', { requires: ['fixture/Cyc1'] });
    const r = resolve(c1, c2, down);
    expect(stateOf(r, 'fixture.cyc1')).toEqual({ state: 'invalid', code: 'plugin.cycle' });
    expect(stateOf(r, 'fixture.cyc2')).toEqual({ state: 'invalid', code: 'plugin.cycle' });
    expect(stateOf(r, 'fixture.down')?.state).toBe('unresolved');
    const problems = [...r.results.values()].find((x) => x.id === 'fixture.down')?.problems.join('\n');
    expect(problems).toMatch(/cyclic|invalid/);
  });

  it('C14: a missing dependency gives unresolved, not invalid, and says which one', () => {
    const r = resolve(manifests['needsMissing']);
    expect(stateOf(r, 'fixture.needsMissing')).toEqual({ state: 'unresolved', code: 'plugin.unresolved' });
    expect([...r.results.values()][0]?.problems.join()).toContain('fixture.absent');
  });

  it('C14: a dependency whose version does not satisfy the range gives unresolved', () => {
    expect(stateOf(resolve(manifests['valid'], manifests['needsOldVersion']), 'fixture.needsOld')?.state).toBe('unresolved');
  });

  it('C14: a required token without provider gives unresolved; a required core token is fine', () => {
    expect(stateOf(resolve(manifests['requiresUnprovided']), 'fixture.requires')?.state).toBe('unresolved');
    expect(stateOf(resolve(manifests['requiresCoreToken']), 'fixture.requiresCore')?.state).toBe('resolved');
  });

  it('C14: unresolved spreads to dependents of an unresolved plugin; an optional provider does not spread', () => {
    const consumer = manifest('fixture.consumer', { dependencies: { 'fixture.needsMissing': '^1.0.0' } });
    expect(stateOf(resolve(manifests['needsMissing'], consumer), 'fixture.consumer')?.state).toBe('unresolved');
    const optionalConsumer = manifest('fixture.optionalConsumer', { optional: ['fixture/Shared'] });
    const broken = manifest('fixture.providerBroken', { provides: ['fixture/Shared'], dependencies: { 'fixture.absent': '^1.0.0' } });
    expect(stateOf(resolve(broken, optionalConsumer), 'fixture.optionalConsumer')?.state).toBe('resolved');
  });

  it('C14: trust "first-party" is accepted only for builtin plugins; the v1 host is in-process only', () => {
    expect(stateOf(resolve(manifests['firstPartyUser']), 'fixture.firstparty')?.state).toBe('invalid');
    const builtin = resolvePlugins({ descriptions: [describePlugin(manifests['firstPartyUser'], 'builtin')], apiVersion: '1.0.0', coreTokens: new Set() });
    expect([...builtin.results.values()][0]?.state).toBe('resolved');
    expect(stateOf(resolve(manifests['utilityHost']), 'fixture.utility')).toEqual({ state: 'invalid', code: 'plugin.invalidManifest' });
  });

  it('C14: a second plugin with the same id is invalid', () => {
    const r = resolve(manifests['valid'], { ...manifests['valid'], name: 'copy' });
    expect([...r.results.values()].map((x) => x.state).sort()).toEqual(['invalid', 'resolved']);
  });

  it('C14: dependencies activate before dependents in the resolution order', () => {
    const dep = manifest('fixture.dependent', { dependencies: { 'fixture.valid': '^1.0.0' } });
    const r = resolve(dep, manifests['valid']);
    expect(r.order.indexOf('fixture.valid')).toBeLessThan(r.order.indexOf('fixture.dependent'));
  });
});

describe('C14: resolution in the PluginManager, with contributions', () => {
  it('C14: states reach the status map; a plugin that was unresolved becomes resolved when its dependency arrives', async () => {
    const k = kit();
    await k.add(manifests['needsMissing']);
    expect(k.manager.status('fixture.needsMissing')?.state).toBe('unresolved');
    expect(k.manager.status('fixture.needsMissing')?.problems.join()).toContain('plugin.unresolved');
    await k.add(manifests['absent']);
    expect(k.manager.status('fixture.needsMissing')?.state).toBe('resolved');
    expect(k.manager.status('fixture.absent')?.state).toBe('resolved');
  });

  it('C14: engine mismatch, invalid manifest and duplicate provider give state invalid in the status map', async () => {
    const k = kit();
    await k.add(manifests['engineMismatch'], invalidManifests['upperCaseId'], manifests['providerA'], manifests['providerB']);
    expect(k.manager.status('fixture.future')?.state).toBe('invalid');
    expect(k.manager.status('fixture.future')?.problems[0]).toMatch(/^plugin\.engineMismatch/);
    expect(k.manager.status('fixture.providerA')?.state).toBe('resolved');
    expect(k.manager.status('fixture.providerB')?.state).toBe('invalid');
    expect(k.manager.status('fixture.providerB')?.problems[0]).toMatch(/^plugin\.duplicateProvider/);
    expect([...k.manager.plugins.peek().values()].filter((s) => s.state === 'invalid')).toHaveLength(3);
  });

  it('C14: contributions apply when the plugin is resolved, not before and not for invalid plugins; they are removed on disable', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting); // defines the built-in points
    const commands = k.t.window.get(CommandRegistry);
    const withCommand = (id: string, extra?: object) => manifest(id, { contributes: { commands: [{ id: `${id}.run`, title: 'Run' }] }, ...extra });
    await k.add(withCommand('fixture.good'), withCommand('fixture.bad', { engines: { tessera: '^9.0.0' } }), withCommand('fixture.lost', { dependencies: { 'fixture.absent': '^1.0.0' } }));
    expect(commands.metadata('fixture.good.run')?.owner).toBe('fixture.good');
    expect(commands.metadata('fixture.bad.run')).toBeUndefined();
    expect(commands.metadata('fixture.lost.run')).toBeUndefined();
    expect(k.manager.status('fixture.good')?.state).toBe('resolved');
    await k.manager.disable('fixture.good');
    expect(k.manager.status('fixture.good')?.state).toBe('disabled');
    expect(commands.metadata('fixture.good.run')).toBeUndefined();
    await k.manager.enable('fixture.good');
    expect(k.manager.status('fixture.good')?.state).toBe('resolved');
    expect(commands.metadata('fixture.good.run')).toBeDefined();
  });

  it('C14: an invalid entry is skipped and listed as plugin.invalidContribution; the other entries still apply', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    const m = manifest('fixture.mixed', { contributes: { commands: [{ id: 'mixed.ok', title: 'OK' }, { id: 'mixed.bad' }, { title: 'no id' }] } });
    await k.add(m);
    const commands = k.t.window.get(CommandRegistry);
    expect(commands.metadata('mixed.ok')).toBeDefined();
    expect(commands.metadata('mixed.bad')).toBeUndefined();
    const problems = k.manager.status('fixture.mixed')?.problems ?? [];
    expect(problems.filter((p) => p.startsWith('plugin.invalidContribution'))).toHaveLength(2);
    expect(k.manager.status('fixture.mixed')?.state).toBe('resolved');
  });

  it('C14: entries for a point that is not defined yet are held and applied when the point is defined; unknown points become problems at Ready', async () => {
    const k = kit();
    const m = manifest('fixture.early', { contributes: { commands: [{ id: 'early.run', title: 'Run' }], 'fixture.custom': [{ x: 1 }] } });
    await k.add(m);
    const commands = k.t.window.get(CommandRegistry);
    expect(commands.metadata('early.run')).toBeUndefined(); // the commands point does not exist yet
    await k.runPhase(LifecyclePhase.Starting);
    expect(commands.metadata('early.run')).toBeDefined();
    await k.runPhase(LifecyclePhase.Ready);
    expect(k.manager.status('fixture.early')?.problems.join()).toContain('unknown contribution point "fixture.custom"');
  });

  it('C14: derived activation events: onCommand for each command, onService for each provided token, plus the declared ones', async () => {
    const k = kit();
    await k.runPhase(LifecyclePhase.Starting);
    await k.add(manifest('fixture.events', { activationEvents: ['onStartupFinished'], provides: ['fixture/Thing'], contributes: { commands: [{ id: 'events.a', title: 'A' }, { id: 'events.b', title: 'B' }] } }));
    expect([...(k.manager.status('fixture.events')?.activationEvents ?? [])].sort()).toEqual(['onCommand:events.a', 'onCommand:events.b', 'onService:fixture/Thing', 'onStartupFinished']);
    expect(k.t.window.get(ContributionRegistry).activationEvents('fixture.events')).toContain('onCommand:events.a');
  });
});

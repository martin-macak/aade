import type { PluginDescription, PluginManifest, PluginSource } from '@tessera/contracts';

// Manifest fixtures for the plugin tests (poc-plan C14). Plain data, no behavior.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A valid manifest for `id`. Overrides replace fields. */
export function manifest(id: string, overrides?: Partial<Mutable<PluginManifest>>): PluginManifest {
  return { id, name: id, version: '1.0.0', engines: { tessera: '^1.0.0' }, main: './main.js', ...overrides };
}

/** Wraps a manifest into the description a catalog lists. The location is the id, so a test loader can key on it. */
export function describePlugin(m: unknown, source: PluginSource = 'user'): PluginDescription {
  const id = (m as { id?: unknown }).id;
  return { manifest: m as PluginManifest, location: typeof id === 'string' ? `test://${id}/` : 'test://unknown/', source };
}

/** Manifests that are invalid in exactly one way each. Typed as unknown: most of them do not fit PluginManifest. */
export const invalidManifests: Readonly<Record<string, unknown>> = {
  notAnObject: 'not a manifest',
  missingId: { name: 'x', version: '1.0.0', engines: { tessera: '^1.0.0' } },
  upperCaseId: manifest('Acme.Tasks'),
  oneSegmentId: manifest('tasks'),
  badVersion: manifest('fixture.badversion', { version: 'one' }),
  missingEngines: { id: 'fixture.noengines', name: 'x', version: '1.0.0' },
  emptyEngines: manifest('fixture.empty', { engines: { tessera: '' } }),
  starEngines: manifest('fixture.star', { engines: { tessera: '*' } }),
  xEngines: manifest('fixture.x', { engines: { tessera: 'x' } }),
  xxxEngines: manifest('fixture.xxx', { engines: { tessera: 'x.x.x' } }),
  orStarEngines: manifest('fixture.orstar', { engines: { tessera: '>=0.0.0 || *' } }),
  garbageEngines: manifest('fixture.garbage', { engines: { tessera: 'not a range' } }),
  badMain: manifest('fixture.badmain', { main: '../outside.js' }),
  badHost: { ...manifest('fixture.badhost'), host: 'main' },
  contributesNotArrays: { ...manifest('fixture.contrib'), contributes: { commands: { id: 'x' } } },
  wildcardDependency: manifest('fixture.wilddep', { dependencies: { 'fixture.other': '*' } }),
};

/** Valid manifests for the resolution tests. */
export const manifests: Readonly<Record<string, PluginManifest>> = {
  valid: manifest('fixture.valid'),
  declarativeOnly: { id: 'fixture.declarative', name: 'Declarative', version: '1.0.0', engines: { tessera: '^1.0.0' }, contributes: { commands: [{ id: 'declarative.hello', title: 'Hello' }] } },
  camelCaseId: manifest('sample.taskStats'),
  engineMismatch: manifest('fixture.future', { engines: { tessera: '^2.0.0' } }),
  providerA: manifest('fixture.providerA', { provides: ['fixture/Shared'] }),
  providerB: manifest('fixture.providerB', { provides: ['fixture/Shared'] }),
  providesCoreToken: manifest('fixture.core', { provides: ['tessera.commandService'] }),
  cycleA: manifest('fixture.cycleA', { dependencies: { 'fixture.cycleB': '^1.0.0' } }),
  cycleB: manifest('fixture.cycleB', { dependencies: { 'fixture.cycleA': '^1.0.0' } }),
  needsMissing: manifest('fixture.needsMissing', { dependencies: { 'fixture.absent': '^1.0.0' } }),
  absent: manifest('fixture.absent'),
  needsOldVersion: manifest('fixture.needsOld', { dependencies: { 'fixture.valid': '^2.0.0' } }),
  requiresUnprovided: manifest('fixture.requires', { requires: ['fixture/Nobody'] }),
  requiresCoreToken: manifest('fixture.requiresCore', { requires: ['tessera.commandService'] }),
  firstPartyUser: manifest('fixture.firstparty', { trust: 'first-party' }),
  utilityHost: manifest('fixture.utility', { host: 'utility' }),
};

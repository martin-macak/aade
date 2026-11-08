import { describe, expect, it } from 'vitest';
import { invalidManifests, manifest, manifests } from '@tessera/testing';
import { isLocalizationKey } from '@tessera/contracts';
import { parseManifest, pluginManifestSchema } from '@tessera/plugins';

describe('C14: manifest validation', () => {
  it('C14: accepts a valid manifest, a declarative-only manifest and a camelCase id (sample.taskStats)', () => {
    for (const m of [manifests['valid'], manifests['declarativeOnly'], manifests['camelCaseId']]) {
      const result = parseManifest(m);
      expect(result, JSON.stringify(m)).toMatchObject({ ok: true });
    }
  });

  it.each(Object.keys(invalidManifests))('C14: rejects the invalid manifest "%s" and says where', (name) => {
    const result = parseManifest(invalidManifests[name]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
  });

  it('C14: a wildcard engines range is rejected in every spelling, a real range is accepted', () => {
    for (const range of ['*', 'x', 'X', '', 'x.x.x', '>=0.0.0 || *', '1.x || *']) {
      expect(parseManifest(manifest('fixture.range', { engines: { tessera: range } })).ok, `range "${range}"`).toBe(false);
    }
    for (const range of ['^1.0.0', '>=1.2.0 <2', '1.x', '~1.4.2']) {
      expect(parseManifest(manifest('fixture.range', { engines: { tessera: range } })).ok, `range "${range}"`).toBe(true);
    }
  });

  it('C14: problems name the field path (engines.tessera, id)', () => {
    const result = parseManifest(invalidManifests['starEngines']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join('\n')).toContain('engines.tessera');
    const id = parseManifest(invalidManifests['upperCaseId']);
    if (!id.ok) expect(id.problems.join('\n')).toContain('id');
  });

  it('C14: the schema is a structural Schema<PluginManifest> (safeParse)', () => {
    expect(typeof pluginManifestSchema.safeParse).toBe('function');
  });
});

describe('round 2: forward-compatible manifest', () => {
  it('C14: unknown keys, capabilities and activation events are warnings; the manifest the host uses drops the unknown capabilities and events', () => {
    const result = parseManifest({ ...manifest('fixture.future'), surprise: 1, capabilities: ['context.global', 'time.travel'], activationEvents: ['onStartupFinished', 'onFullMoon'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(3);
    expect(result.manifest.capabilities).toEqual(['context.global']);
    expect(result.manifest.activationEvents).toEqual(['onStartupFinished']);
  });

  it.each([
    ['a parent folder', '../outside.js'],
    ['a nested parent folder', 'a/../../b.js'],
    ['a leading slash', '/etc/passwd.js'],
    ['a backslash', '..\\evil.js'],
    ['a leading backslash', '\\server\\share.js'],
    ['a scheme', 'https://evil.example/x.js'],
    ['a file URL', 'file:///tmp/x.js'],
    ['a data URL', 'data:text/javascript,alert(1)'],
    ['an encoded dot', '%2e%2e/x.js'],
    ['an encoded slash', 'a%2fb.js'],
    ['an encoded backslash', 'a%5cb.js'],
    ['no script extension', './main.css'],
    ['an empty path', ''],
  ])('C14: main refuses %s', (_label, path) => {
    expect(parseManifest(manifest('fixture.path', { main: path })).ok).toBe(false);
    expect(parseManifest(manifest('fixture.path', { ui: { react: path } })).ok).toBe(false);
  });

  it.each(['./main.js', 'main.mjs', 'dist/main.js', './src/ui/react.js', './src/main.ts', './src/ui-react.tsx'])('C14: main accepts the relative path %s', (path) => {
    expect(parseManifest(manifest('fixture.path', { main: path })).ok).toBe(true);
  });
});

describe('round 2: reserved manifest space', () => {
  it('C14: l10n and contributesTo are accepted (l10n has no effect); the point ids themes and icons are reserved; %key% is a localization key', () => {
    const ok = parseManifest({ ...manifest('fixture.l10n'), l10n: { cs: './cs.json' }, contributesTo: ['acme/Providers'] });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) {
      expect(ok.manifest.l10n).toEqual({ cs: './cs.json' });
      expect(ok.manifest.contributesTo).toEqual(['acme/Providers']);
      expect(ok.warnings).toEqual([]);
    }
    for (const id of ['themes', 'icons']) expect(parseManifest(manifest('fixture.reserved', { contributionPoints: [{ id }] })).ok).toBe(false);
    expect(parseManifest(manifest('fixture.free', { contributionPoints: [{ id: 'acme.themes' }] })).ok).toBe(true);
    expect(isLocalizationKey('%tasks.title%')).toBe(true);
    expect(isLocalizationKey('Tasks')).toBe(false);
    expect(isLocalizationKey('%%')).toBe(false);
  });
});

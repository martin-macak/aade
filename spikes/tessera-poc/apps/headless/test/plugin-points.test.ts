import { describe, expect, it } from 'vitest';
import { toDisposable } from '@tessera/base';
import { ContributionRegistry, defineContributionPoint, type Contribution, type PluginContext } from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';

interface Theme {
  readonly name: string;
}
const swatches = defineContributionPoint<Theme>('swatches', { safeParse: (i) => (typeof i === 'object' && i !== null && typeof (i as Theme).name === 'string' ? { success: true, data: i as Theme } : { success: false, error: { issues: [{ path: [], message: 'name required' }] } }) });

const problemsOf = (app: TestApp, id: string): string => (app.plugins.status(id)?.problems ?? []).join('\n');

function setup() {
  const applied: string[] = [];
  const removed: string[] = [];
  const definer = describePlugin(manifest('fixture.definer', { contributionPoints: [{ id: 'swatches', description: 'Color swatches' }], contributes: { commands: [{ id: 'definer.run', title: 'Run' }] } }), 'builtin');
  const module = {
    activate(ctx: PluginContext) {
      ctx.subscriptions.add(
        ctx.contributions.definePoint(swatches, {
          apply: (c: Contribution<Theme>) => {
            applied.push(c.value.name);
            return toDisposable(() => void removed.push(c.value.name));
          },
        }),
      );
    },
  };
  const consumer = (id: string, name: string) => describePlugin(manifest(id, { contributes: { swatches: [{ name }] } }));
  return { applied, removed, definer, module, consumer };
}

describe('C14: plugin-defined contribution points with a lazy definer (plugin-defined-points-lazy-gap)', () => {
  it('C14: entries for a declared point wait, no problem is reported, and the definer is not activated by the consumer', async () => {
    const { applied, definer, module, consumer } = setup();
    const app = await createTestApp({ plugins: [consumer('fixture.dark', 'dark'), definer], modules: { [definer.location]: module } });
    expect(app.plugins.status('fixture.definer')?.state).toBe('resolved'); // lazy: not loaded
    expect(problemsOf(app, 'fixture.dark')).toBe(''); // Ready passed, the point is declared by an installed plugin
    expect(applied).toEqual([]);
    await app.commands.execute('definer.run').catch(() => undefined); // wakes the definer (onCommand)
    expect(app.plugins.status('fixture.definer')?.state).toBe('active');
    expect(applied).toEqual(['dark']); // the held entry is applied when the point is defined
    expect(problemsOf(app, 'fixture.dark')).toBe('');
  });

  it('C14: a consumer installed after the definer is active is applied at once', async () => {
    const { applied, definer, module, consumer } = setup();
    const app = await createTestApp({ plugins: [definer], modules: { [definer.location]: module } });
    await app.plugins.activate('fixture.definer');
    const late = consumer('fixture.light', 'light');
    app.catalog.add(late);
    await app.settle();
    expect(applied).toEqual(['light']);
    expect(problemsOf(app, 'fixture.light')).toBe('');
  });

  it('C14: when the definer deactivates its entries are removed, and when it activates again they are applied again', async () => {
    const { applied, removed, definer, module, consumer } = setup();
    const app = await createTestApp({ plugins: [definer, consumer('fixture.dark', 'dark')], modules: { [definer.location]: module } });
    await app.plugins.activate('fixture.definer');
    expect(applied).toEqual(['dark']);
    await app.plugins.deactivate('fixture.definer');
    expect(removed).toEqual(['dark']);
    expect(problemsOf(app, 'fixture.dark')).toBe(''); // still a declared point
    await app.plugins.activate('fixture.definer');
    expect(applied).toEqual(['dark', 'dark']);
  });

  it('C14: an entry for a point that nobody declares is reported at Ready, and the problem goes away when the point gets defined (by the host)', async () => {
    const { applied } = setup();
    const ghost = describePlugin(manifest('fixture.ghost', { contributes: { swatches: [{ name: 'ghost' }] } }));
    const app = await createTestApp({ plugins: [ghost] });
    expect(problemsOf(app, 'fixture.ghost')).toContain('unknown contribution point "swatches"');
    app.get(ContributionRegistry).definePoint(swatches, { apply: (c: Contribution<Theme>) => (applied.push(c.value.name), toDisposable(() => undefined)) });
    expect(applied).toEqual(['ghost']);
    expect(problemsOf(app, 'fixture.ghost')).toBe(''); // defined now: the problem is gone
  });

  it('C14: a plugin cannot define a point it does not declare in contributionPoints (plugin.undeclaredPoint)', async () => {
    const rogue = describePlugin(manifest('fixture.rogue'), 'builtin');
    const consumer = describePlugin(manifest('fixture.victim', { contributes: { swatches: [{ name: 'secret' }] } }));
    const seen: string[] = [];
    const app = await createTestApp({
      plugins: [rogue, consumer],
      modules: { [rogue.location]: { activate: (ctx: PluginContext) => ctx.contributions.definePoint(swatches, { apply: (c: Contribution<Theme>) => (seen.push(c.value.name), toDisposable(() => undefined)) }) } },
    });
    const errors = captureErrors();
    await expect(app.plugins.activate('fixture.rogue')).rejects.toMatchObject({ message: expect.stringContaining('is not declared in contributionPoints') });
    expect(errors.drain()).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(app.get(ContributionRegistry).points().some((p) => p.id === 'swatches')).toBe(false);
  });

  it('C14: only the best-ranked declarer defines the point, whichever plugin activates first (I29)', async () => {
    const seen: string[] = [];
    const handler = (tag: string) => ({ apply: (c: Contribution<Theme>) => (seen.push(`${tag}:${c.value.name}`), toDisposable(() => undefined)) });
    const builtin = describePlugin(manifest('fixture.builtin-definer', { contributionPoints: [{ id: 'swatches' }] }), 'builtin');
    const user = describePlugin(manifest('fixture.user-definer', { contributionPoints: [{ id: 'swatches' }], activationEvents: ['*'] }), 'user');
    const consumer = describePlugin(manifest('fixture.consumer', { contributes: { swatches: [{ name: 'one' }] } }));
    const modules = {
      [builtin.location]: { activate: (ctx: PluginContext) => void ctx.contributions.definePoint(swatches, handler('builtin')) },
      [user.location]: { activate: (ctx: PluginContext) => void ctx.contributions.definePoint(swatches, handler('user')) },
    };
    const app = await createTestApp({ plugins: [user, builtin, consumer], modules });
    // the user plugin ('*') activates first; the builtin one only later
    await app.plugins.activate('fixture.user-definer');
    expect(problemsOf(app, 'fixture.user-definer')).toContain('plugin.duplicateContribution: contribution point "swatches" is already declared by "fixture.builtin-definer"');
    expect(seen).toEqual([]); // the lower-ranked definer is ignored
    await app.plugins.activate('fixture.builtin-definer');
    expect(seen).toEqual(['builtin:one']);
  });

  it('C14: the manifest field is strict: an unknown key in contributionPoints is invalid', async () => {
    const bad = describePlugin(manifest('fixture.badpoints', { contributionPoints: [{ id: 'x', title: 'no such key' } as never] }));
    const app = await createTestApp({ plugins: [bad] });
    expect(app.plugins.status('fixture.badpoints')?.state).toBe('invalid');
  });
});

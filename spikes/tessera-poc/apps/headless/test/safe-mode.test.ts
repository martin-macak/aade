import { describe, expect, it } from 'vitest';
import { LAYOUT_STORAGE_KEY, emptyOverrides, type PlacementId } from '@tessera/contracts';
import { createTestApp, describePlugin, manifest } from '@tessera/testing';

const stored = {
  v: 1,
  data: {
    savedAt: '2026-11-06T10:00:00.000Z',
    appVersion: '0.0.0-test',
    windows: [],
    workspaces: {},
    placements: { 'p:fixture.side:fixture.safe': { viewType: 'fixture.safe', instanceId: 'i1', workspaceId: 'fixture.side', local: undefined, dock: undefined } },
    instances: {},
    closedInstances: [],
    overrides: emptyOverrides(),
    focus: undefined,
  },
};

const view = { contributes: { workspaces: [{ id: 'fixture.side', title: 'Side', kind: 'tabs', part: 'primarySideBar' }], views: [{ id: 'fixture.safe', title: 'Safe', workspace: 'fixture.side', visibleByDefault: false }] } };
const builtin = describePlugin(manifest('fixture.builtin', view), 'builtin');
const user = describePlugin(manifest('fixture.user', { activationEvents: ['*'] }), 'user');
const modules = { [builtin.location]: { activate: () => undefined }, [user.location]: { activate: () => undefined } };

describe('C21: safe mode (no-safe-mode-or-crash-loop-guard)', () => {
  it('C21: only builtin plugins resolve, the stored layout is not restored, the context key is set, and the layout on disk is not overwritten', async () => {
    const app = await createTestApp({ plugins: [builtin, user], modules, storage: { project: { [LAYOUT_STORAGE_KEY]: stored } }, safeMode: true });
    expect(app.plugins.status('fixture.builtin')?.state).toBe('resolved');
    expect(app.plugins.status('fixture.user')).toBeUndefined();
    expect(app.contextKeys.root.getValue('app.safeMode')).toBe(true);
    expect(app.workbench.placement('p:fixture.side:fixture.safe' as PlacementId)).toBeUndefined();
    await app.workbench.showView('fixture.safe');
    await app.settle();
    await app.app.shutdown('close');
    expect(app.storage.snapshot('project')[LAYOUT_STORAGE_KEY]).toEqual(stored);
  });

  it('C21: without safe mode the same app resolves the user plugin and restores the layout', async () => {
    const app = await createTestApp({ plugins: [builtin, user], modules, storage: { project: { [LAYOUT_STORAGE_KEY]: stored } } });
    expect(app.plugins.status('fixture.user')?.state).toBe('active');
    expect(app.contextKeys.root.getValue('app.safeMode')).toBeUndefined();
    expect(app.workbench.placement('p:fixture.side:fixture.safe' as PlacementId)).toBeDefined();
  });
});

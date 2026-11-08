import { describe, expect, it } from 'vitest';
import * as ui from '../src/ui.ts';
import * as main from '../src/index.ts';

// The semver gate of @tessera/react/ui (round 2): a new, renamed or removed runtime export fails this test, so a change of the
// plugin-UI surface is a deliberate edit of this list. The type surface is pinned by api/react-ui.d.ts (npm run api:update).
// useService and useServices stay in the main entry for the chrome; the UI surface is render-only (a read-only useViewContext: placement id, view type, reportError).
const UI_EXPORTS = ['REACT_RENDERER_ID', 'defineReactUi', 'defineReactView', 'useObservable', 'useViewContext'];

describe('@tessera/react/ui: the plugin UI surface is guarded', () => {
  it('exports exactly the allowlisted runtime names', () => {
    expect(Object.keys(ui).toSorted()).toEqual(UI_EXPORTS.toSorted());
  });

  it('is a subset of the main entry, which keeps the renderer and the chrome to itself', () => {
    for (const name of UI_EXPORTS) expect(name in main).toBe(true);
    for (const internal of ['useService', 'useServices', 'createReactRenderer', 'ReactViewMounter', 'Workbench', 'StatusBar', 'ChromeBoundary', 'PlacementBoundary', 'ViewHub']) {
      expect(internal in ui).toBe(false);
      expect(internal in main).toBe(true);
    }
  });
});

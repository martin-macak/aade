import { toDisposable } from '@tessera/base';
import { WorkbenchService, type ViewMounter } from '@tessera/contracts';
import type { ScopeReader, Token } from '@tessera/di';
import { dockSurfaceConformance } from '@tessera/testing';
import { DockviewSurface } from '../src/index.ts';

// C27: the dockview surface passes the same DockSurface conformance suite as the fake surface, in real Chromium.
// There is no workbench here, so the services answer "no placement": every panel shows its placeholder.
const services = {
  get(token: Token<unknown>) {
    if (token === (WorkbenchService as Token<unknown>)) return { placement: () => undefined };
    return undefined;
  },
  getAll: () => [],
  has: () => false,
} as unknown as ScopeReader;

const mounter: ViewMounter<HTMLElement> = {
  rendererId: 'stub',
  ensureUi: async () => false,
  canMount: () => false,
  mount: () => toDisposable(() => undefined),
};

dockSurfaceConformance('dockview-core 8.8 (Chromium)', () => {
  const host = document.createElement('div');
  host.style.cssText = 'width:800px;height:600px;position:relative;';
  document.body.append(host);
  const surface = new DockviewSurface({ services });
  return {
    surface,
    host,
    mounter: mounter as ViewMounter,
    panelIds: () => surface.panelIds(),
    dispose: () => host.remove(),
  };
});

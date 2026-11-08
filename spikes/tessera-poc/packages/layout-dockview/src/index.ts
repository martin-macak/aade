// @tessera/layout-dockview: the DockSurface on dockview-core (contracts.md 15.9). The only package that imports dockview-core.
export { dockviewSurfaceFactory } from './factory.ts';
export type { DockviewSurfaceFactory, DockviewSurfaceFactoryOptions } from './factory.ts';
export { DockviewSurface } from './surface.ts';
export type { DockviewSurfaceOptions } from './surface.ts';
export { checkArrangement, DOCKVIEW_ENGINE, DOCKVIEW_ENGINE_VERSION, isSerializedDockview, PLACEMENT_COMPONENT, TAB_COMPONENT, wrapArrangement } from './arrangement.ts';
export type { ArrangementCheck } from './arrangement.ts';

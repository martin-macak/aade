// @tessera/react/ui: the part of the React adapter that plugin UI authors use (semver-guarded, like @tessera/plugin-api).
// The main entry ('@tessera/react') also holds the renderer, the mounter and the window chrome, which are host internals. A plugin UI
// entry imports from here only, and the dependency check enforces it. The surface is pinned by test/ui-surface.test.ts and by the
// committed declaration snapshot api/react-ui.d.ts.
export { useObservable } from './use-observable.ts';
// Service access and command execution are not part of this surface: a view asks for work through the intents of its presenter.
export { useViewContext } from './ui-context.ts';
export type { ViewUiContext } from './ui-context.ts';
export { defineReactUi, defineReactView, REACT_RENDERER_ID } from './define.ts';
export type { ReactUiModule, ReactViewDefinition, ReactViewProps } from './define.ts';

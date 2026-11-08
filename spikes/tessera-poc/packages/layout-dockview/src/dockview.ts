// An ambient module declaration cannot be imported (it has no runtime file), so the reference directive is the right tool here.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./dockview-bundle.d.ts" />
// The one place that imports dockview-core at run time.
//
// dockview-core 8.8.3 ships its stylesheet only inside the self-contained bundle `dist/dockview-core.js` (it injects a <style>
// element when it loads). The package's ESM entry has no CSS and the npm package has no .css file, so an app that uses the ESM
// entry gets an unstyled dock. The bundle is a documented export of the package ("./dist/*"). The surface therefore imports
// its values from the bundle and takes the types from the package entry (same API, same version).
export { createDockview, themeAbyss, themeLight } from 'dockview-core/dist/dockview-core.js';
export type {
  CreateComponentOptions,
  DockviewApi,
  GroupPanelPartInitParameters,
  IContentRenderer,
  IDockviewPanel,
  ITabRenderer,
  SerializedDockview,
  TabPartInitParameters,
} from 'dockview-core';

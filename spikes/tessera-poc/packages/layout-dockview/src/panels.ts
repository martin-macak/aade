import type { PlacementId } from '@tessera/contracts';
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from './dockview.ts';

/** The surface side of a panel: what the content renderer reports to it. */
export interface PanelHooks {
  panelReady(panel: PlacementPanel, api: GroupPanelPartInitParameters['api']): void;
  panelGone(panel: PlacementPanel): void;
  requestClose(id: PlacementId): void;
}

/** The content of one dock panel: a host element for the view and one for a placeholder note. The surface mounts the view into the first. */
export class PlacementPanel implements IContentRenderer {
  readonly element: HTMLElement;
  /** Where the ViewMounter mounts the view. Only the mounter touches its children: a framework owns the nodes it renders. */
  readonly viewHost: HTMLElement;
  /** Where the surface puts its own placeholder note. */
  readonly noteHost: HTMLElement;
  id: PlacementId = '' as PlacementId;
  readonly #hooks: PanelHooks;

  constructor(hooks: PanelHooks) {
    this.#hooks = hooks;
    this.element = document.createElement('div');
    this.element.className = 'tessera-dock-panel';
    this.element.style.cssText = 'height:100%;width:100%;overflow:auto;';
    this.element.tabIndex = -1;
    this.viewHost = document.createElement('div');
    this.viewHost.className = 'tessera-dock-view';
    this.viewHost.style.cssText = 'height:100%;width:100%;';
    this.noteHost = document.createElement('div');
    this.element.append(this.viewHost, this.noteHost);
  }

  init(parameters: GroupPanelPartInitParameters): void {
    const params = parameters.params as { placementId?: string };
    this.id = (params.placementId ?? parameters.api.id) as PlacementId;
    this.#hooks.panelReady(this, parameters.api);
  }

  dispose(): void {
    this.#hooks.panelGone(this);
  }
}

/** The tab: title and a close button. The button never closes the dockview panel; it asks the workbench (contracts.md 15.6). */
export class PlacementTab implements ITabRenderer {
  readonly element: HTMLElement;
  readonly #title: HTMLSpanElement;
  readonly #hooks: PanelHooks;
  #id: PlacementId = '' as PlacementId;
  #off: (() => void) | undefined;

  constructor(hooks: PanelHooks) {
    this.#hooks = hooks;
    this.element = document.createElement('div');
    this.element.className = 'dv-tessera-tab';
    this.#title = document.createElement('span');
    this.#title.className = 'dv-tessera-tab-title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dv-tessera-tab-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#hooks.requestClose(this.#id);
    });
    this.element.append(this.#title, close);
  }

  init(parameters: TabPartInitParameters): void {
    this.#id = ((parameters.params as { placementId?: string }).placementId ?? parameters.api.id) as PlacementId;
    this.#title.textContent = parameters.title;
    const subscription = parameters.api.onDidTitleChange((e) => {
      this.#title.textContent = e.title;
    });
    this.#off = () => subscription.dispose();
  }

  dispose(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

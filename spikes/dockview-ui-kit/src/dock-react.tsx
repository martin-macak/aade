// A small adapter that mounts React 19 into dockview-core panels: one React root per panel element,
// created in init(), unmounted in dispose(). dockview-core itself knows nothing about React.
import type { CreateComponentOptions, DockviewApi, GroupPanelPartInitParameters, IContentRenderer } from 'dockview-core';
import { createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface PanelProps {
  readonly api: GroupPanelPartInitParameters['api'];
  readonly containerApi: DockviewApi;
  readonly params: Record<string, unknown>;
}

/** Counts React roots, so a test can prove that dockview called dispose() and that the root unmounted. */
export interface AdapterStats {
  rootsCreated: number;
  rootsUnmounted: number;
}

export class ReactPanel implements IContentRenderer {
  readonly element: HTMLElement = document.createElement('div');
  private root: Root | undefined;

  constructor(
    private readonly component: ComponentType<PanelProps>,
    private readonly stats: AdapterStats,
  ) {
    this.element.style.width = '100%';
    this.element.style.height = '100%';
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.root = createRoot(this.element);
    this.stats.rootsCreated++;
    this.root.render(createElement(this.component, { api: parameters.api, containerApi: parameters.containerApi, params: parameters.params }));
  }

  dispose(): void {
    if (!this.root) return;
    this.root.unmount();
    this.root = undefined;
    this.stats.rootsUnmounted++;
  }
}

export function createReactComponent(registry: Record<string, ComponentType<PanelProps>>, stats: AdapterStats) {
  return ({ name }: CreateComponentOptions): IContentRenderer => {
    const component = registry[name];
    if (!component) throw new Error(`No React component registered for "${name}"`);
    return new ReactPanel(component, stats);
  };
}

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { toDisposable, type IDisposable } from '@tessera/base';
import type { ViewMounter, WindowId, WorkbenchRenderer } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { type ErrorFallback } from './boundary.tsx';
import { ConfigContext, type PlaceholderProps } from './config.ts';
import { ServicesContext } from './contexts.ts';
import { defaultStyles } from './styles.ts';
import { ReactViewMounter, ViewPortals } from './view-mounter.tsx';
import { Workbench } from './workbench.tsx';

export interface ReactRendererOptions {
  /** The window DI scope. */
  readonly services: ScopeReader;
  readonly placeholder?: (props: PlaceholderProps) => ReactNode;
  readonly errorFallback?: (props: { readonly error: unknown; readonly reload: () => void }) => ReactNode;
  /** Shown in the title bar. Default 'Tessera'. */
  readonly title?: string;
  /** Wrap the root in StrictMode (the demo and the tests do). */
  readonly strictMode?: boolean;
  /** Inject the default stylesheet into the document head. Default true. */
  readonly injectStyles?: boolean;
}

export interface ReactRenderer {
  readonly mounter: ReactViewMounter & ViewMounter<HTMLElement>;
  readonly workbench: WorkbenchRenderer<HTMLElement>;
}

/**
 * Creates the React adapter (contracts.md 18.2): the ViewMounter and the WorkbenchRenderer share one ViewHub. The
 * workbench renderer owns the one React root of the window; views mount into it through portals.
 */
export function createReactRenderer(options: ReactRendererOptions): ReactRenderer {
  const errorFallback: ErrorFallback | undefined = options.errorFallback;
  const mounter = new ReactViewMounter({
    services: options.services,
    ...(errorFallback ? { errorFallback } : {}),
    ...(options.strictMode === undefined ? {} : { strictMode: options.strictMode }),
  });
  const workbench: WorkbenchRenderer<HTMLElement> = {
    rendererId: mounter.rendererId,
    render(host: HTMLElement, windowId: WindowId): IDisposable {
      const document = host.ownerDocument;
      let style: HTMLStyleElement | undefined;
      if (options.injectStyles !== false && !document.getElementById('tessera-default-styles')) {
        style = document.createElement('style');
        style.id = 'tessera-default-styles';
        style.textContent = defaultStyles;
        document.head.append(style);
      }
      mounter.hub.external = true;
      const root = createRoot(host);
      const tree = (
        <ServicesContext value={options.services}>
          <ConfigContext value={{ windowId, mounter, ...(options.placeholder ? { placeholder: options.placeholder } : {}), title: options.title ?? 'Tessera' }}>
            <Workbench />
            <ViewPortals hub={mounter.hub} lookup={(t) => mounter.definition(t)} errorFallback={mounter.errorFallback} />
          </ConfigContext>
        </ServicesContext>
      );
      root.render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree);
      let disposed = false;
      return toDisposable(() => {
        if (disposed) return;
        disposed = true;
        mounter.hub.external = false;
        root.unmount();
        style?.remove();
      });
    },
  };
  return { mounter, workbench };
}

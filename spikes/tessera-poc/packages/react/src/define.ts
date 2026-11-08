import type { ReactNode } from 'react';
import type { UiModule } from '@tessera/contracts';
import type { ViewUiContext } from './ui-context.ts';

export const REACT_RENDERER_ID = 'react';

/** What a React view component receives. Nothing else. */
export interface ReactViewProps<S, I> {
  readonly state: S;
  readonly intents: I;
  /** Read-only: placement id, view type and reportError. No services and no command execution. */
  readonly context: ViewUiContext;
}

export interface ReactViewDefinition {
  readonly viewType: string;
  readonly component: (props: ReactViewProps<never, never>) => ReactNode;
}

export interface ReactUiModule extends UiModule {
  readonly rendererId: 'react';
  readonly views: readonly ReactViewDefinition[];
}

export function defineReactView<S, I>(viewType: string, component: (props: ReactViewProps<S, I>) => ReactNode): ReactViewDefinition {
  return { viewType, component: component as ReactViewDefinition['component'] };
}

/** The default export of a plugin's `ui.react` entry. */
export function defineReactUi(views: readonly ReactViewDefinition[]): ReactUiModule {
  return { rendererId: REACT_RENDERER_ID, views };
}

import { createContext, useContext, type Context, type ReactNode } from 'react';
import type { Placement, WindowId } from '@tessera/contracts';
import type { ReactViewMounter } from './view-mounter.tsx';

export interface PlaceholderProps {
  readonly placement: Placement;
  readonly problem: string | undefined;
}

export interface RendererConfig {
  readonly windowId: WindowId;
  readonly mounter: ReactViewMounter;
  readonly placeholder?: (props: PlaceholderProps) => ReactNode;
  /** Shown in the title bar. */
  readonly title: string;
}

export const ConfigContext: Context<RendererConfig | undefined> = createContext<RendererConfig | undefined>(undefined);

export function useConfig(): RendererConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('Tessera renderer components must render inside createReactRenderer().workbench.');
  return config;
}

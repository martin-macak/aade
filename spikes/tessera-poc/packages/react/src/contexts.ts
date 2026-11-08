import { createContext, useContext, type Context } from 'react';
import type { ScopeReader, Token } from '@tessera/di';
import type { ViewContext } from '@tessera/contracts';

/** The window DI scope. Provided by the renderer root. */
export const ServicesContext: Context<ScopeReader | undefined> = createContext<ScopeReader | undefined>(undefined);
/** The ViewContext of the placement a component renders in. Provided by the placement boundary. */
export const ViewContextContext: Context<ViewContext | undefined> = createContext<ViewContext | undefined>(undefined);

/** The ViewContext of the enclosing placement. Throws outside a view. */
export function useViewContext(): ViewContext {
  const context = useContext(ViewContextContext);
  if (!context) throw new Error('useViewContext() was called outside a placement. Views render inside a placement boundary.');
  return context;
}

/** The window DI scope (renderer chrome) or the enclosing placement's DI scope (views). */
export function useServices(): ScopeReader {
  const view = useContext(ViewContextContext);
  const window = useContext(ServicesContext);
  const scope = view?.services ?? window;
  if (!scope) throw new Error('useService() was called outside a Tessera renderer root.');
  return scope;
}

/** Resolves from the nearest placement DI scope (or the window scope outside views). Child-first, like inject(). */
export function useService<T>(token: Token<T>): T {
  return useServices().get(token);
}

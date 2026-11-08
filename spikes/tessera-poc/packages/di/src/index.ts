export { ResolutionError } from './errors.ts';
export type { ResolutionErrorCode } from './errors.ts';
export { MultiToken, multiToken, Token, token } from './token.ts';
export { DEFAULT_DISPOSE_TIMEOUT_MS, createRootScope, inject, injectAll, injectLazy, injectScope, isInInjectionContext, runFiltered, ScopeKind } from './scope.ts';
export type { Factory, InjectionFilter, Lazy, Lifetime, ProvideOptions, Scope, ScopeDisposeOptions, ScopeReader, ScopeState, ServiceCall, ServiceInterceptionHook } from './scope.ts';

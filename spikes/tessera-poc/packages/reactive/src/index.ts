export { installReactiveEngine, preactEngine } from './engine.ts';
export type { EngineComputed, EngineState, ReactiveEngine } from './engine.ts';
export {
  batch,
  changes,
  computed,
  constant,
  effect,
  fromEvent,
  isObservable,
  reactiveDebug,
  state,
  transact,
  untracked,
  whenTrue,
} from './facade.ts';
export type { Observable, ReactiveDebug, ReactiveOptions, State } from './facade.ts';
export { resource } from './resource.ts';
export type { Resource, ResourceHandle } from './resource.ts';

import { registerModuleInstance } from '@tessera/base';

// Packaging contract: one reactive engine per realm. A second copy reports tessera.duplicateModule once.
registerModuleInstance('@tessera/reactive', import.meta);

export * from './async.ts';
export * from './cancellation.ts';
export * from './dedupe.ts';
export * from './dev.ts';
export * from './disposable.ts';
export * from './disposable-types.ts';
export * from './errors.ts';
export * from './event.ts';
export * from './module-instance.ts';
import { registerModuleInstance } from './module-instance.ts';
export * from './scheduler.ts';
export * from './schema.ts';
export * from './tracker.ts';
export * from './util.ts';

// This module instance announces itself (packaging contract): a second copy in the realm reports tessera.duplicateModule once.
registerModuleInstance('@tessera/base', import.meta);

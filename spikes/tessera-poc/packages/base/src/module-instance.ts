import { TesseraError, reportError } from './errors.ts';

/**
 * Registers the module instance of a package under `globalThis[Symbol.for('@tessera/<pkg>')]` (packaging contract, contracts.md 14.11).
 * Two copies of @tessera/reactive or @tessera/base in one realm (a plugin that bundled its own engine) would split the reactive
 * graph, the scheduler and the error funnel without a visible error. A second, different copy reports `tessera.duplicateModule` once.
 * It never throws. Returns true when this instance is the registered one.
 */
export function registerModuleInstance(pkg: string, instance: object): boolean {
  const key = Symbol.for(pkg);
  const holder = globalThis as unknown as Record<symbol, { instance: object; reported: boolean } | undefined>;
  const known = holder[key];
  if (known === undefined) {
    holder[key] = { instance, reported: false };
    return true;
  }
  if (known.instance === instance) return true;
  if (!known.reported) {
    known.reported = true;
    reportError(new TesseraError('tessera.duplicateModule', `${pkg} is loaded twice in this window: a plugin or a dependency bundles its own copy. Mark it as an external so that the host's copy is shared (plugins.md, packaging).`, { details: { pkg } }), { source: 'unknown', target: pkg });
  }
  return false;
}

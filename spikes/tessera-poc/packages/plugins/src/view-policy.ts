import { TesseraError } from '@tessera/base';
import type { ContextKeyScope, ViewServicesPolicy } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import type { DefaultPluginManager } from './plugin-manager.ts';

/** A reader for a view whose plugin is not running: every read throws, has() is false. */
function deadReader(owner: string): ScopeReader {
  const gone = (): never => {
    throw new TesseraError('plugin.deactivated', `Plugin "${owner}" is not active: its view cannot read services`, { details: { pluginId: owner } });
  };
  return { get: gone as ScopeReader['get'], getAll: gone, has: () => false };
}

const MUTATING_CONTEXT_MEMBERS: ReadonlySet<string> = new Set(['set', 'createKey', 'dispose', 'createChild']);

/**
 * The context scope of a view whose plugin has no runtime (not active, or already cleaned up): reads work, so the view can still
 * render its last state, and everything that would write or create throws plugin.deactivated. It fails closed: the raw scope is never returned.
 */
function deadContext(owner: string, scope: ContextKeyScope): ContextKeyScope {
  return new Proxy(scope, {
    get(target, prop) {
      if (typeof prop === 'string' && MUTATING_CONTEXT_MEMBERS.has(prop)) {
        return (): never => {
          throw new TesseraError('plugin.deactivated', `Plugin "${owner}" is not active: its view cannot change context keys`, { details: { pluginId: owner } });
        };
      }
      const member: unknown = Reflect.get(target, prop, target);
      return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(target) : member;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/**
 * The view door (contracts.md 14.6): a plugin-owned view gets the plugin's gated reader (same check and wrap as
 * CommandContext.services) and the context-key facade. An owner that is not an installed plugin keeps the raw scopes.
 */
export function viewServicesPolicy(manager: DefaultPluginManager): ViewServicesPolicy {
  const isPlugin = (owner: string): boolean => manager.status(owner) !== undefined;
  return {
    readerFor(owner: string, scope: ScopeReader): ScopeReader {
      if (!isPlugin(owner)) return scope;
      const runtime = manager.host.runtimeOf(owner);
      return runtime ? runtime.viewServices(scope) : deadReader(owner);
    },
    contextFor(owner: string, scope: ContextKeyScope): ContextKeyScope {
      if (!isPlugin(owner)) return scope;
      const runtime = manager.host.runtimeOf(owner);
      return runtime ? runtime.viewContext(scope) : deadContext(owner, scope);
    },
  };
}

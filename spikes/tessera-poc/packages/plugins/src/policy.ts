import { TesseraError, reportError } from '@tessera/base';
import { HostPluginServices, PluginPolicy, type HostPluginService, type PluginDescription } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';

/**
 * The default policy (contracts.md 14.7): a builtin or dev plugin gets the capabilities it declares; a user plugin (or any other source) gets no elevated
 * capability (every capability is elevated: guards, force, overrides, global context keys, host services). A host that wants more
 * (an install prompt, a publisher check) passes its own PluginPolicy in ApplicationOptions.
 */
export const defaultPluginPolicy: PluginPolicy = {
  grant(description: PluginDescription): ReadonlySet<string> {
    // Fail closed: only the two sources that the host trusts get what they declare. An unknown source gets nothing.
    if (description.source !== 'builtin' && description.source !== 'dev') return new Set();
    // The reserved platform capabilities (fs.read, fs.write, process.spawn, pty, secrets, http) are known names with no service behind them yet:
    // the default policy never grants them. A product host that offers such a service grants it with its own PluginPolicy.
    return new Set((description.manifest.capabilities ?? []).filter((capability) => !RESERVED_PLATFORM_CAPABILITY.test(capability)));
  },
};

/** The reserved platform capabilities of contracts 14.7: known to the manifest check, never granted by the default policy. */
export const RESERVED_PLATFORM_CAPABILITY: RegExp = /^(fs\.read|fs\.write|process\.spawn|pty|secrets|http)$/;

export interface CapabilityDecision {
  /** requested ∩ granted: what the runtime enforces. */
  readonly granted: ReadonlySet<string>;
  /** Requested and not granted: shown as problems in PluginStatus. */
  readonly refused: readonly string[];
}

/** Asks the policy of the scope (or the default) what a plugin gets. A policy that throws grants nothing. */
export function decideCapabilities(scope: ScopeReader, description: PluginDescription): CapabilityDecision {
  const requested = [...new Set(description.manifest.capabilities ?? [])];
  if (requested.length === 0) return { granted: new Set(), refused: [] };
  const policy = scope.get(PluginPolicy, { optional: true }) ?? defaultPluginPolicy;
  let allowed: ReadonlySet<string>;
  try {
    allowed = policy.grant(description);
  } catch (error) {
    reportError(new TesseraError('plugin.capabilityDenied', `The plugin policy failed for "${description.manifest.id}"; no capability is granted`, { cause: error }), { source: 'activation', pluginId: description.manifest.id, target: 'pluginPolicy' });
    allowed = new Set();
  }
  return { granted: new Set(requested.filter((c) => allowed.has(c))), refused: requested.filter((c) => !allowed.has(c)) };
}

/** The services the host product offers to plugins, by token id. */
export function hostServicesOf(scope: ScopeReader): ReadonlyMap<string, HostPluginService> {
  return new Map((scope.get(HostPluginServices, { optional: true }) ?? []).map((service) => [service.token.id, service]));
}

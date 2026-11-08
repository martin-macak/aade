import { PluginState } from '@tessera/contracts';

/**
 * The allowed plugin state changes: the stateDiagram of contracts 14.4, plus the re-resolution edges that the diagram leaves implicit
 * (a resolved plugin whose dependency goes away becomes unresolved or invalid, an unresolved one can become invalid, and back).
 * `PluginManager#setState` checks every change against this table in dev mode (`plugin.invalidTransition`), and the model test of the
 * manager walks only these edges. A removed plugin leaves the table (the diagram's `[*]`), it has no state to change to.
 */
export const PLUGIN_TRANSITIONS: Readonly<Record<PluginState, ReadonlySet<PluginState>>> = {
  [PluginState.Discovered]: new Set([PluginState.Invalid, PluginState.Unresolved, PluginState.Resolved, PluginState.Disabled]),
  [PluginState.Unresolved]: new Set([PluginState.Resolved, PluginState.Invalid, PluginState.Disabled]),
  [PluginState.Invalid]: new Set([PluginState.Resolved, PluginState.Unresolved, PluginState.Disabled]),
  [PluginState.Resolved]: new Set([PluginState.Activating, PluginState.Failed, PluginState.Disabled, PluginState.Unresolved, PluginState.Invalid]),
  [PluginState.Activating]: new Set([PluginState.Active, PluginState.Failed]),
  [PluginState.Active]: new Set([PluginState.Deactivating, PluginState.Disabled]),
  [PluginState.Deactivating]: new Set([PluginState.Resolved]),
  [PluginState.Failed]: new Set([PluginState.Resolved, PluginState.Discovered, PluginState.Disabled]),
  [PluginState.Disabled]: new Set([PluginState.Discovered]),
};

export function isAllowedTransition(from: PluginState, to: PluginState): boolean {
  return from === to || PLUGIN_TRANSITIONS[from].has(to);
}

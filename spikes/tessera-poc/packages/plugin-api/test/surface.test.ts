import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pluginApi from '../src/index.ts';

// The semver gate of @tessera/plugin-api (packages.md, ADR-014): a new, renamed or removed runtime export fails this test, so a change
// to the public surface is always a deliberate edit of the list below (and a version decision), never a side effect of a re-export.
const RUNTIME_EXPORTS: readonly string[] = [
  'CommandService',
  'ConfigurationService',
  'ContextKeyService',
  'CoreTopics',
  'DialogService',
  'DisposableStore',
  'Emitter',
  'MenuId',
  'NotificationService',
  'PublicTokens',
  'QuickInputService',
  'SelectionService',
  'StatusBarService',
  'TESSERA_API_VERSION',
  'TesseraError',
  'UndoService',
  'WorkItemService',
  'WorkItemStatus',
  'WorkbenchService',
  'batch',
  'changes',
  'computed',
  'constant',
  'defineCommand',
  'defineContributionPoint',
  'definePlugin',
  'defineTopic',
  'effect',
  'inject',
  'injectAll',
  'injectLazy',
  'isKind',
  'multiToken',
  'resource',
  'selectionType',
  'state',
  'toDisposable',
  'token',
  'transact',
  'untracked',
];

describe('@tessera/plugin-api: the surface is guarded', () => {
  it('exports exactly the allowlisted runtime names (sorted snapshot)', () => {
    expect(Object.keys(pluginApi).toSorted()).toEqual([...RUNTIME_EXPORTS].toSorted());
  });

  it('never exports the container or core internals (injectScope, Scope, ViewServicesPolicy, CoreTokenIds, WorkItem scope types)', () => {
    for (const forbidden of ['injectScope', 'createRootScope', 'CoreTokenIds', 'CoreTokens', 'ViewServicesPolicy', 'InterceptorRegistry', 'StorageService', 'EventBus']) {
      expect(forbidden in pluginApi).toBe(false);
    }
  });

  it('TESSERA_API_VERSION equals the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pluginApi.TESSERA_API_VERSION).toBe(pkg.version);
  });
});

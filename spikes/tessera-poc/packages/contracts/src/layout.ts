import type { Migration, MigrationResult, StoredValue } from '@tessera/base';
import { multiToken, token, type MultiToken, type Token } from '@tessera/di';
import type { Box, DockArrangement, DockSlot, LayoutOverrides, PartId } from './ids.ts';

// contracts.md section 16.4: layout snapshot.

export const WORKBENCH_SNAPSHOT_VERSION = 1;

export interface WorkbenchSnapshot {
  /** ISO time */
  readonly savedAt: string;
  readonly appVersion: string;
  readonly windows: readonly WindowSnapshot[];
  readonly workspaces: Readonly<Record<string, WorkspaceSnapshot>>;
  readonly placements: Readonly<Record<string, PlacementSnapshot>>;
  readonly instances: Readonly<Record<string, InstanceSnapshot>>;
  /** Shared state of recently closed instances, most recent first. At most 50. */
  readonly closedInstances: readonly ClosedInstanceSnapshot[];
  readonly overrides: LayoutOverrides;
  readonly focus: string | undefined;
}

export interface WindowSnapshot {
  readonly id: string;
  readonly kind: 'main' | 'auxiliary';
  readonly bounds: Box | undefined;
  readonly parts: Readonly<
    Partial<Record<PartId, { readonly visible: boolean; readonly size: number | undefined; readonly active: string | undefined }>>
  >;
}

export interface WorkspaceSnapshot {
  readonly active: string | undefined;
  readonly collapsed: readonly string[];
  /** Dock workspaces only. Container membership is computed from defaults plus overrides. */
  readonly members: readonly string[] | undefined;
  readonly arrangement: DockArrangement | undefined;
}

export interface PlacementSnapshot {
  readonly viewType: string;
  readonly instanceId: string;
  readonly workspaceId: string;
  /** Stored as is. Migrated lazily with the provider's localState schema when the presenter is created. */
  readonly local: StoredValue | undefined;
  readonly dock: DockSlot | undefined;
}

export interface InstanceSnapshot {
  readonly viewType: string;
  readonly key: string;
  readonly workItemPath: string;
  /** Migrated lazily with the provider's sharedState schema when the view model is created. */
  readonly shared: StoredValue | undefined;
}

export interface ClosedInstanceSnapshot {
  readonly viewType: string;
  readonly key: string;
  readonly shared: StoredValue;
  readonly closedAt: string;
}

/** Steps for the snapshot StateSchema. Contributed by the workbench and by apps. */
export const LayoutMigration: MultiToken<Migration> = multiToken<Migration>('tessera.layoutMigration');

/** Rewrites a dock engine blob between engine versions. */
export interface ArrangementMigration {
  readonly engine: string;
  readonly from: string;
  readonly to: string;
  migrate(data: unknown): unknown;
}
export const ArrangementMigration: MultiToken<ArrangementMigration> = multiToken<ArrangementMigration>('tessera.arrangementMigration');

export interface LayoutStore {
  load(): Promise<MigrationResult<WorkbenchSnapshot>>;
  /** Debounced, 500 ms. Called on every revision and geometry change. */
  scheduleSave(): void;
  /** Registered as the WillShutdown join 'layout.save'. */
  flush(): Promise<void>;
}
export const LayoutStore: Token<LayoutStore> = token<LayoutStore>('tessera.layoutStore');

export const LAYOUT_STORAGE_KEY = 'workbench.layout';

export function emptyOverrides(): LayoutOverrides {
  return { views: {}, workspaces: {} };
}

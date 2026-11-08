import {
  MigrationStatus,
  getScheduler,
  reportError,
  type IDisposable,
  type Migration,
  type MigrationResult,
  type Schema,
  type StateSchema,
} from '@tessera/base';
import {
  LAYOUT_STORAGE_KEY,
  HostEnvironment,
  LayoutMigration,
  StorageService,
  WORKBENCH_SNAPSHOT_VERSION,
  emptyOverrides,
  type LayoutStore,
  type WorkbenchSnapshot,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { z } from 'zod';

const storedValue = z.object({ v: z.number().int(), data: z.unknown() });
const dockSlot = z.object({ group: z.string(), where: z.enum(['grid', 'floating', 'popout']), popoutId: z.string().optional() });
const arrangement = z.object({ engine: z.string(), engineVersion: z.string(), data: z.unknown() });
const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** The zod schema of the snapshot (contracts.md 16.4). Unknown ids are kept, so records are open-ended where it matters. */
export const workbenchSnapshotSchema: Schema<WorkbenchSnapshot> = z.object({
  savedAt: z.string(),
  appVersion: z.string(),
  windows: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['main', 'auxiliary']),
      bounds: box.optional(),
      parts: z.record(z.string(), z.object({ visible: z.boolean(), size: z.number().optional(), active: z.string().optional() })),
    }),
  ),
  workspaces: z.record(
    z.string(),
    z.object({ active: z.string().optional(), collapsed: z.array(z.string()), members: z.array(z.string()).optional(), arrangement: arrangement.optional() }),
  ),
  placements: z.record(
    z.string(),
    z.object({ viewType: z.string(), instanceId: z.string(), workspaceId: z.string(), local: storedValue.optional(), dock: dockSlot.optional() }),
  ),
  instances: z.record(
    z.string(),
    z.object({ viewType: z.string(), key: z.string(), workItemPath: z.string(), shared: storedValue.optional() }),
  ),
  closedInstances: z.array(z.object({ viewType: z.string(), key: z.string(), shared: storedValue, closedAt: z.string() })),
  overrides: z.object({
    views: z.record(z.string(), z.object({ workspace: z.string().optional(), hidden: z.boolean().optional(), order: z.number().optional(), collapsed: z.boolean().optional() })),
    workspaces: z.record(z.string(), z.object({ part: z.string().optional(), order: z.number().optional(), hidden: z.boolean().optional() })),
  }),
  focus: z.string().optional(),
}) as unknown as Schema<WorkbenchSnapshot>;

export function emptySnapshot(appVersion: string): WorkbenchSnapshot {
  return {
    savedAt: new Date(0).toISOString(),
    appVersion,
    windows: [],
    workspaces: {},
    placements: {},
    instances: {},
    closedInstances: [],
    overrides: emptyOverrides(),
    focus: undefined,
  };
}

/**
 * The effective schema version is the base version, raised so that every contributed migration step is reachable:
 * max(WORKBENCH_SNAPSHOT_VERSION, max(step.from) + 1). A test or an app contributes `{ from: 1, migrate }` and the
 * next release then reads version 2 (see deviations.md: the snapshot has version 1 only, so nothing could be older).
 */
export function layoutSchema(appVersion: string, steps: readonly Migration[]): StateSchema<WorkbenchSnapshot> {
  const version = Math.max(WORKBENCH_SNAPSHOT_VERSION, ...steps.map((s) => s.from + 1));
  return { version, schema: workbenchSnapshotSchema, initial: () => emptySnapshot(appVersion), migrations: steps };
}

/** The built-in steps. None yet: version 1 is the first released layout schema. */
export const layoutMigrations: readonly Migration[] = [];

export interface LayoutSource {
  /** Builds the snapshot of the current model. */
  snapshot(): WorkbenchSnapshot;
}

export const SAVE_DEBOUNCE_MS = 500;
/** A stream of changes cannot postpone the save for longer than this (contracts.md 16.4). */
export const SAVE_MAX_WAIT_MS = 2000;
/** One view state (shared or per placement) above this serialized size is left out of the snapshot (layout.viewStateTooLarge). */
export const MAX_VIEW_STATE_BYTES: number = 64 * 1024;

/** Reads and writes `workbench.layout` through the StorageService (project scope). Window DI scope. */
export class DefaultLayoutStore implements LayoutStore, IDisposable {
  readonly #scope: Scope;
  readonly #appVersion: string;
  #source: LayoutSource | undefined;
  #timer: IDisposable | undefined;
  #maxTimer: IDisposable | undefined;
  #disposed = false;
  #schema: { readonly steps: readonly Migration[]; readonly value: StateSchema<WorkbenchSnapshot> } | undefined;

  constructor(appVersion = '0.0.0') {
    this.#scope = injectScope();
    this.#appVersion = appVersion;
  }

  /** The workbench service registers itself as the source of snapshots. */
  setSource(source: LayoutSource): void {
    this.#source = source;
  }

  /** Cached: rebuilt only when the set of contributed LayoutMigration steps changes. */
  schema(): StateSchema<WorkbenchSnapshot> {
    const steps = [...layoutMigrations, ...this.#scope.getAll(LayoutMigration)];
    const cached = this.#schema;
    if (cached && cached.steps.length === steps.length && cached.steps.every((step, index) => step === steps[index])) return cached.value;
    const value = layoutSchema(this.#appVersion, steps);
    this.#schema = { steps, value };
    return value;
  }

  /** Safe mode: the stored layout is neither read nor written. */
  get #safe(): boolean {
    return this.#scope.get(HostEnvironment, { optional: true })?.safeMode === true;
  }

  async load(): Promise<MigrationResult<WorkbenchSnapshot>> {
    const storage = this.#scope.get(StorageService);
    await storage.whenReady();
    if (this.#safe) return { value: this.schema().initial(), status: MigrationStatus.Missing, fromVersion: undefined };
    return storage.getVersioned('project', LAYOUT_STORAGE_KEY, this.schema());
  }

  scheduleSave(): void {
    if (this.#disposed || !this.#source || this.#safe) return;
    const scheduler = getScheduler();
    const fire = (): void => {
      this.#clearTimers();
      this.#write();
    };
    this.#timer?.dispose();
    this.#timer = scheduler.timeout(fire, SAVE_DEBOUNCE_MS);
    // The debounce restarts on every change; the max wait does not, so the save goes out at most 2 s after the first change.
    this.#maxTimer ??= scheduler.timeout(fire, SAVE_MAX_WAIT_MS);
  }

  #clearTimers(): void {
    this.#timer?.dispose();
    this.#maxTimer?.dispose();
    this.#timer = undefined;
    this.#maxTimer = undefined;
  }

  /** Writes the snapshot into storage now (synchronously) and cancels the timers. The storage flush is a separate step (the persistence shutdown step). */
  commit(): void {
    this.#clearTimers();
    if (!this.#source || this.#safe) return;
    if (!this.#scope.get(StorageService).isReady) return; // shutdown before the storage loaded: nothing to write
    this.#write();
  }

  async flush(): Promise<void> {
    this.commit();
    if (!this.#source || this.#safe || !this.#scope.get(StorageService).isReady) return;
    await this.#scope.get(StorageService).flush();
  }

  #write(): void {
    if (!this.#source || this.#disposed) return;
    try {
      const snapshot = this.#source.snapshot();
      this.#scope.get(StorageService).setVersioned('project', LAYOUT_STORAGE_KEY, snapshot, this.schema());
    } catch (error) {
      reportError(error, { source: 'persistence', target: LAYOUT_STORAGE_KEY });
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
  }
}

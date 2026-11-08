import { TesseraError } from './errors.ts';

export interface SchemaIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}
export type SafeParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: ReadonlyArray<SchemaIssue> } };

export interface Schema<T> {
  safeParse(input: unknown): SafeParseResult<T>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

export class ValidationError extends TesseraError {
  readonly issues: ReadonlyArray<SchemaIssue>;

  constructor(message: string, issues: ReadonlyArray<SchemaIssue>) {
    super('validation', message, { details: { issues: issues.map((i) => ({ path: i.path.map(String), message: i.message })) } });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function describeIssues(issues: ReadonlyArray<SchemaIssue>): string {
  return issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ');
}

/** safeParse or throw ValidationError naming `what`. */
export function parseOrThrow<T>(schema: Schema<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(`${what} is invalid: ${describeIssues(result.error.issues)}`, result.error.issues);
}

/** One migration step: from version `from` to `from + 1`. Pure, synchronous, no I/O. */
export interface Migration {
  readonly from: number;
  migrate(data: unknown): unknown;
}

/** A versioned value type. Used by mementos, view state and the layout snapshot. */
export interface StateSchema<T> {
  readonly version: number;
  readonly schema: Schema<T>;
  initial(): T;
  readonly migrations?: readonly Migration[];
}

/** What is stored on disk for a versioned value. */
export interface StoredValue {
  readonly v: number;
  readonly data: unknown;
}

export const MigrationStatus = {
  Current: 'current',
  Migrated: 'migrated',
  Missing: 'missing',
  ResetInvalid: 'reset-invalid',
  ResetNewer: 'reset-newer',
  ResetNoPath: 'reset-no-path',
} as const;
export type MigrationStatus = (typeof MigrationStatus)[keyof typeof MigrationStatus];

export interface MigrationResult<T> {
  readonly value: T;
  readonly status: MigrationStatus;
  readonly fromVersion: number | undefined;
  readonly error?: unknown;
}

/** Pure. Applies steps from stored.v up to schema.version, then validates. Never throws. */
export function migrateValue<T>(stored: StoredValue | undefined, schema: StateSchema<T>): MigrationResult<T> {
  if (stored === undefined || stored === null) {
    return { value: schema.initial(), status: MigrationStatus.Missing, fromVersion: undefined };
  }
  const version = (stored as { v?: unknown }).v;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      value: schema.initial(),
      status: MigrationStatus.ResetInvalid,
      fromVersion: undefined,
      error: new Error('Stored value has no valid version'),
    };
  }
  if (version > schema.version) {
    return { value: schema.initial(), status: MigrationStatus.ResetNewer, fromVersion: version };
  }
  let data = stored.data;
  for (let from = version; from < schema.version; from++) {
    const step = schema.migrations?.find((m) => m.from === from);
    if (!step) {
      return {
        value: schema.initial(),
        status: MigrationStatus.ResetNoPath,
        fromVersion: version,
        error: new Error(`No migration from version ${from} to ${from + 1}`),
      };
    }
    try {
      data = step.migrate(data);
    } catch (error) {
      return { value: schema.initial(), status: MigrationStatus.ResetNoPath, fromVersion: version, error };
    }
  }
  let parsed: SafeParseResult<T>;
  try {
    parsed = schema.schema.safeParse(data);
  } catch (error) {
    return { value: schema.initial(), status: MigrationStatus.ResetInvalid, fromVersion: version, error };
  }
  if (!parsed.success) {
    return {
      value: schema.initial(),
      status: MigrationStatus.ResetInvalid,
      fromVersion: version,
      error: new ValidationError(`Stored value is invalid: ${describeIssues(parsed.error.issues)}`, parsed.error.issues),
    };
  }
  return {
    value: parsed.data,
    status: version === schema.version ? MigrationStatus.Current : MigrationStatus.Migrated,
    fromVersion: version,
  };
}

export function toStoredValue<T>(value: T, schema: StateSchema<T>): StoredValue {
  return { v: schema.version, data: value };
}

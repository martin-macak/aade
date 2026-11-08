import type { Schema, StateSchema } from '@tessera/plugin-api';

// Small hand-written schemas. A real plugin would use zod; plugin-api does not re-export it, so the POC stays dependency-free.

export function schemaOf<T>(check: (input: unknown) => string | undefined): Schema<T> {
  return {
    safeParse(input) {
      const problem = check(input);
      return problem === undefined ? { success: true, data: input as T } : { success: false, error: { issues: [{ path: [], message: problem }] } };
    },
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function stateSchema<T>(version: number, check: (input: unknown) => string | undefined, initial: () => T, migrations?: StateSchema<T>['migrations']): StateSchema<T> {
  return { version, schema: schemaOf<T>(check), initial, ...(migrations ? { migrations } : {}) };
}

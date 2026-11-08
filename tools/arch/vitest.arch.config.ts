// The name differs from vitest.config.ts, so that the Nx Vitest plugin does
// not add a `test` target. This project has only the `archTest` target.
// ArchUnitTS needs `globals: true` for its `toPassAsync` matcher. The first
// rule builds the TypeScript program of the whole repository, which takes
// longer than the default timeout of 5 seconds on a cold start.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 120_000,
  },
});

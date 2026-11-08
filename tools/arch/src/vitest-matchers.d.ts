// ArchUnitTS adds `toPassAsync` to Vitest at runtime, but its types do not
// reach the `expect` of Vitest. This declaration connects them.
import type { CheckOptions } from 'archunit';
import 'vitest';

declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: TypeScript merges this only when the default equals the one of Vitest.
  interface Matchers<T = any> {
    toPassAsync(options?: CheckOptions): Promise<T>;
  }
}

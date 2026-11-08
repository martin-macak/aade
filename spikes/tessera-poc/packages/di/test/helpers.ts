import { afterEach } from 'vitest';
import { createRootScope, type Scope } from '@tessera/di';

/** Creates root scopes that the suite disposes in afterEach (leakCheck runs afterwards). */
export function useRoots(): (options?: Parameters<typeof createRootScope>[0]) => Scope {
  const roots: Scope[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      if (root.state === 'active') await root.dispose();
    }
  });
  return (options) => {
    const root = createRootScope(options);
    roots.push(root);
    return root;
  };
}

export async function errorOf(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

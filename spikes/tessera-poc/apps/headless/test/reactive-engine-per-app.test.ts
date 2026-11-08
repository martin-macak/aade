import { describe, expect, it } from 'vitest';
import { preactEngine, state, type ReactiveEngine } from '@tessera/reactive';
import { createTestApp } from '@tessera/testing';

// A file of its own: the engine choice is locked by the first reactive node of a realm, and vitest gives each file a fresh realm.

describe('process-global-state-per-application: ApplicationOptions.reactiveEngine is restored on dispose', () => {
  it('two sequential applications install different engines, the second install succeeds, and the default engine is back after each dispose', async () => {
    const counting = (id: string): ReactiveEngine & { created: number } => {
      const engine = { ...preactEngine, id, created: 0, state: <T,>(initial: T) => (engine.created++, preactEngine.state(initial)) };
      return engine;
    };
    const one = counting('probe-one');
    const two = counting('probe-two');
    const first = await createTestApp({ start: false, reactiveEngine: one });
    expect(one.created).toBeGreaterThan(0); // the application builds its own state nodes on the engine it installed
    await first.dispose();
    const oneAfter = one.created;
    const second = await createTestApp({ start: false, reactiveEngine: two }); // not reactive.engineLocked: the dispose restored engine and lock
    expect(two.created).toBeGreaterThan(0);
    expect(one.created).toBe(oneAfter);
    await second.dispose();
    const twoAfter = two.created;
    state(0); // outside any application: the default engine, not a disposed one
    expect([one.created, two.created]).toEqual([oneAfter, twoAfter]);
  });
});

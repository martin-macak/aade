import { describe, expect, it } from 'vitest';
describe('process-global-state-per-application: installReactiveEngine returns its restore', () => {
  it('disposing the restore puts the previous engine and lock state back, so a second application can install another engine', async () => {
    const { installReactiveEngine, preactEngine, state } = await import('@tessera/reactive');
    const { peekEngineId } = await import('../src/engine.ts');
    const first = installReactiveEngine({ ...preactEngine, id: 'probe-one' });
    expect(peekEngineId()).toBe('probe-one');
    state(1); // creating a node locks the choice
    expect(() => installReactiveEngine({ ...preactEngine, id: 'probe-two' })).toThrowError(expect.objectContaining({ code: 'reactive.engineLocked' }));
    first.dispose();
    expect(peekEngineId()).toBe('preact-signals-core'); // the default is back
    const second = installReactiveEngine({ ...preactEngine, id: 'probe-two' }); // and the lock is open again
    expect(peekEngineId()).toBe('probe-two');
    second.dispose();
    expect(peekEngineId()).toBe('preact-signals-core');
  });
});

import { describe, expect, it } from 'vitest';
import { DisposableStore, Emitter } from '@tessera/base';
import { createRootScope } from '@tessera/di';
import { leakCheck, resetLeakTracking, type collectLeaks } from '@tessera/testing';
import { effect, state } from '@tessera/reactive';

// The setup file runs leakCheck() after every test. These tests leak on purpose, assert that leakCheck notices,
// and clean up before the setup file looks.

describe('C2: leakCheck finds what teardown forgot', () => {
  it('C2: passes when everything is disposed', () => {
    const store = new DisposableStore('clean');
    const emitter = new Emitter<number>();
    const sub = emitter.event(() => {});
    const s = state(1);
    const fx = effect(() => void s.get());
    const sub2 = s.subscribe(() => {});
    sub.dispose();
    sub2.dispose();
    fx.dispose();
    emitter.dispose();
    store.dispose();
    expect(() => leakCheck()).not.toThrow();
  });

  it('C2: finds an undisposed DisposableStore and names where it was created', () => {
    const store = new DisposableStore('leaky store');
    let message = '';
    try {
      leakCheck();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('undisposed store "leaky store"');
    expect(message).toContain('leak-check.test.ts');
    store.dispose();
  });

  it('C2: finds an emitter that still has listeners, but not an idle one', () => {
    const idle = new Emitter<number>();
    expect(() => leakCheck()).not.toThrow();
    const busy = new Emitter<number>({ name: 'busy' });
    const sub = busy.event(() => {});
    expect(() => leakCheck()).toThrow(/undisposed emitter "busy"/);
    sub.dispose();
    busy.dispose();
    idle.dispose();
  });

  it('C2: finds an undisposed DI scope', async () => {
    const scope = createRootScope({ id: 'forgotten', kind: 'workItem' });
    expect(() => leakCheck()).toThrow(/undisposed scope "workItem:forgotten"/);
    await scope.dispose();
  });

  it('C2: finds live reactive subscriptions and effects', () => {
    const s = state(1);
    const sub = s.subscribe(() => {});
    const fx = effect(() => void s.get());
    let report: ReturnType<typeof collectLeaks> | undefined;
    try {
      leakCheck();
    } catch (error) {
      report = (error as unknown as { report: ReturnType<typeof collectLeaks> }).report;
    }
    expect(report?.liveSubscriptions).toBe(1);
    expect(report?.liveEffects).toBe(1);
    sub.dispose();
    fx.dispose();
  });

  it('C2: reports a leak once: the next check starts clean', () => {
    const store = new DisposableStore();
    expect(() => leakCheck()).toThrow();
    expect(() => leakCheck()).not.toThrow();
    store.dispose();
  });

  it('resetLeakTracking forgets objects created before it', () => {
    const store = new DisposableStore();
    resetLeakTracking();
    expect(() => leakCheck()).not.toThrow();
    store.dispose();
  });
});

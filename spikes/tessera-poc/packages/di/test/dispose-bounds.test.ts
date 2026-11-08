import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRootScope, token } from '@tessera/di';
import { ManualScheduler, captureErrors } from '@tessera/testing';

// ADR-018, round 2: a hung async disposer cannot block scope disposal.
describe('round 2: scope disposal is bounded', () => {
  let scheduler: ManualScheduler;
  let restore: { dispose(): void };
  beforeEach(() => {
    scheduler = new ManualScheduler();
    restore = scheduler.install();
  });
  afterEach(() => restore.dispose());

  const never = (): Promise<void> => new Promise<void>(() => undefined);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it('C3: a hung service dispose is reported as di.disposeTimeout with path, token and owner, and the scope still ends', async () => {
    const capture = captureErrors();
    const Hung = token<{ dispose(): Promise<void> }>('round2.hung');
    const root = createRootScope({ disposeTimeoutMs: 1000 });
    const child = root.createChild('workItem', 'w1');
    child.provide(Hung, () => ({ dispose: never }), { owner: 'sample.hung' });
    child.get(Hung);
    const order: string[] = [];
    child.provideValue(token<object>('round2.after'), { dispose: () => void order.push('after') }, { dispose: true });
    child.get(token<object>('round2.after'));
    let done = false;
    const disposing = root.dispose().then(() => void (done = true));
    await settle();
    expect(done).toBe(false);
    scheduler.advance(1000);
    await disposing;
    const reported = capture.drain();
    capture.dispose();
    expect(done).toBe(true);
    expect(child.state).toBe('disposed');
    expect(root.state).toBe('disposed');
    expect(order).toEqual(['after']); // the disposers after the hung one still run
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toMatchObject({ code: 'di.disposeTimeout', details: { token: 'round2.hung', owner: 'sample.hung' } });
    expect(reported[0]?.context.pluginId).toBe('sample.hung');
  });

  it('C3: a caller deadline shortens the wait: an expired deadline starts every disposer and waits for none', async () => {
    const capture = captureErrors();
    const root = createRootScope({ disposeTimeoutMs: 60_000 });
    root.track({ dispose: never });
    root.track({ dispose: never });
    const started = scheduler.now();
    let done = false;
    const disposing = root.dispose({ deadline: started + 200 }).then(() => void (done = true));
    await settle();
    expect(done).toBe(false);
    scheduler.advance(200);
    await settle();
    await disposing;
    expect(done).toBe(true);
    expect(capture.drain().map((r) => (r.error as { code?: string }).code)).toEqual(['di.disposeTimeout', 'di.disposeTimeout']);
    capture.dispose();
  });

  it('C3: a second dispose call returns the first promise and a late rejection of an abandoned disposer is not unhandled', async () => {
    const capture = captureErrors();
    const root = createRootScope({ disposeTimeoutMs: 10 });
    let rejectLate: (e: Error) => void = () => undefined;
    root.track({ dispose: () => new Promise<void>((_, reject) => void (rejectLate = reject)) });
    const first = root.dispose();
    const second = root.dispose();
    expect(second).toBe(first);
    scheduler.advance(10);
    await first;
    rejectLate(new Error('late'));
    await settle();
    capture.drain();
    capture.dispose();
    expect(root.state).toBe('disposed');
  });

  it('C3: sync and fast async disposers set no timer', async () => {
    const root = createRootScope({ disposeTimeoutMs: 10 });
    root.track({ dispose: () => undefined });
    root.track({ dispose: async () => undefined });
    await root.dispose();
    expect(scheduler.pendingTimers).toBe(0);
  });
});

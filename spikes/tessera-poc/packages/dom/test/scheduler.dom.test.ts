import { describe, expect, it, vi } from 'vitest';
import { domScheduler } from '../src/index.ts';

describe('@tessera/dom: domScheduler', () => {
  it('uses requestIdleCallback when the window has it, and cancels with the disposable', () => {
    const calls: string[] = [];
    const fake = {
      performance: { now: () => 5 },
      requestIdleCallback: (fn: (d: { timeRemaining(): number; didTimeout: boolean }) => void, options?: { timeout?: number }) => {
        calls.push(`request ${options?.timeout ?? 'none'}`);
        fn({ timeRemaining: () => 3, didTimeout: false });
        return 42;
      },
      cancelIdleCallback: (handle: number) => void calls.push(`cancel ${handle}`),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    } as unknown as Window;
    const scheduler = domScheduler(fake);
    expect(scheduler.now()).toBe(5);
    let remaining = -1;
    const handle = scheduler.idle((d) => (remaining = d.timeRemaining()), { timeoutMs: 100 });
    expect(remaining).toBe(3);
    handle.dispose();
    expect(calls).toEqual(['request 100', 'cancel 42']);
  });

  it('falls back to a timeout without requestIdleCallback (Safari, jsdom) and still cancels', async () => {
    const scheduler = domScheduler(window);
    const ran = vi.fn();
    scheduler.idle(ran);
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    scheduler.idle(cancelled).dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('timeout and microtask run in order', async () => {
    const scheduler = domScheduler(window);
    const order: string[] = [];
    scheduler.timeout(() => order.push('timeout'), 1);
    scheduler.microtask(() => order.push('microtask'));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['microtask', 'timeout']);
  });
});

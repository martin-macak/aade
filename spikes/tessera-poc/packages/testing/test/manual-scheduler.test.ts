import { describe, expect, it } from 'vitest';
import { getScheduler } from '@tessera/base';
import { ManualScheduler } from '@tessera/testing';

describe('ManualScheduler', () => {
  it('runs nothing by itself', async () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.microtask(() => log.push('microtask'));
    s.timeout(() => log.push('timeout'), 10);
    s.idle(() => log.push('idle'));
    await Promise.resolve();
    expect(log).toEqual([]);
    expect(s.pending).toBe(3);
  });

  it('flushMicrotasks runs queued microtasks, including the ones they queue', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.microtask(() => {
      log.push('a');
      s.microtask(() => log.push('c'));
    });
    s.microtask(() => log.push('b'));
    s.flushMicrotasks();
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('advance fires timers in time order and moves now()', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.timeout(() => log.push('b at 20'), 20);
    s.timeout(() => log.push('a at 10'), 10);
    s.timeout(() => log.push('c at 30'), 30);
    s.advance(25);
    expect(log).toEqual(['a at 10', 'b at 20']);
    expect(s.now()).toBe(25);
    s.advance(5);
    expect(log).toEqual(['a at 10', 'b at 20', 'c at 30']);
  });

  it('a timer queued by a timer fires inside the same advance if it is due', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.timeout(() => {
      log.push('first');
      s.timeout(() => log.push('second'), 5);
    }, 10);
    s.advance(15);
    expect(log).toEqual(['first', 'second']);
  });

  it('disposing a timer cancels it', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    const handle = s.timeout(() => log.push('x'), 5);
    handle.dispose();
    s.advance(10);
    expect(log).toEqual([]);
    expect(s.pendingTimers).toBe(0);
  });

  it('idle callbacks run on runIdle with a deadline, or on advance with didTimeout when their timeout elapsed', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.idle((d) => log.push(`idle ${d.didTimeout} ${d.timeRemaining()}`));
    s.idle((d) => log.push(`late ${d.didTimeout}`), { timeoutMs: 1000 });
    s.runIdle({ timeRemaining: 7 });
    expect(log).toEqual(['idle false 7', 'late false']);
    s.idle((d) => log.push(`starved ${d.didTimeout}`), { timeoutMs: 1000 });
    s.advance(999);
    expect(log).toHaveLength(2);
    s.advance(1);
    expect(log[2]).toBe('starved true');
  });

  it('install makes it the process-wide scheduler until disposed', () => {
    const original = getScheduler();
    const s = new ManualScheduler();
    const handle = s.install();
    expect(getScheduler()).toBe(s);
    handle.dispose();
    expect(getScheduler()).toBe(original);
  });

  it('tick runs microtasks and then idle callbacks', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.idle(() => log.push('idle'));
    s.microtask(() => log.push('micro'));
    s.tick();
    expect(log).toEqual(['micro', 'idle']);
  });
});

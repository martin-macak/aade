import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { LifecycleService } from '@tessera/contracts';
import { eventsModule } from '@tessera/events';
import { captureErrors, createTestScope } from '@tessera/testing';
import { lifecycleModule, type DefaultLifecycleService } from '@tessera/lifecycle';

function setup() {
  const t = createTestScope({ modules: [eventsModule, lifecycleModule] });
  const lifecycle = t.application.get(LifecycleService) as DefaultLifecycleService;
  const order: string[] = [];
  lifecycle.registerShutdownStep({ id: 'test', order: 100, run: async () => void order.push('dispose') });
  return { t, lifecycle, order };
}

describe('C13: shutdown veto', () => {
  it('C13: runs veto, join, dispose in that order and ends in state done', async () => {
    const { lifecycle, order } = setup();
    lifecycle.onBeforeShutdown((e) => {
      order.push('veto');
      e.veto(false, 'a');
    });
    lifecycle.onWillShutdown((e) => {
      order.push('join');
      e.join('save', async () => void order.push('saved'));
    });
    const result = await lifecycle.shutdown('close');
    expect(result).toEqual({ vetoed: false, vetoedBy: [], timedOut: [] });
    expect(order).toEqual(['veto', 'join', 'saved', 'dispose']);
    expect(lifecycle.shutdownState.peek()).toBe('done');
  });

  it('C13: a veto (true, or a promise of true) stops the shutdown, names the participant and returns to running', async () => {
    const { lifecycle, order } = setup();
    lifecycle.onBeforeShutdown((e) => e.veto(Promise.resolve(true), 'unsaved-editor'));
    lifecycle.onBeforeShutdown((e) => e.veto(false, 'fine'));
    lifecycle.onWillShutdown(() => order.push('join'));
    const result = await lifecycle.shutdown('quit');
    expect(result.vetoed).toBe(true);
    expect(result.vetoedBy).toEqual(['unsaved-editor']);
    expect(order).toEqual([]); // no join, no dispose
    expect(lifecycle.shutdownState.peek()).toBe('running');
  });

  it('C13: a throwing veto handler vetoes and the error is reported', async () => {
    const { lifecycle } = setup();
    const errors = captureErrors();
    lifecycle.onBeforeShutdown(() => {
      throw new Error('handler broke');
    });
    const result = await lifecycle.shutdown('close');
    expect(result.vetoed).toBe(true);
    expect(result.vetoedBy).toHaveLength(1);
    expect(errors.drain().some((e) => e.context.source === 'lifecycle')).toBe(true);
    errors.dispose();
  });

  it('C13: a rejected veto promise vetoes', async () => {
    const { lifecycle } = setup();
    const errors = captureErrors();
    lifecycle.onBeforeShutdown((e) => e.veto(Promise.reject(new Error('dialog crashed')), 'dialog'));
    const result = await lifecycle.shutdown('close');
    expect(result).toMatchObject({ vetoed: true, vetoedBy: ['dialog'] });
    errors.drain();
    errors.dispose();
  });

  it('C13: force skips the vetoes, but still joins and disposes', async () => {
    const { lifecycle, order } = setup();
    lifecycle.onBeforeShutdown((e) => {
      order.push('veto');
      e.veto(true, 'never asked');
    });
    lifecycle.onWillShutdown((e) => e.join('save', async () => void order.push('saved')));
    const result = await lifecycle.shutdown('quit', { force: true });
    expect(result.vetoed).toBe(false);
    expect(order).toEqual(['saved', 'dispose']);
  });

  it('C13: checkVeto runs only the veto step and goes back to running', async () => {
    const { lifecycle, order } = setup();
    lifecycle.onBeforeShutdown((e) => e.veto(true, 'busy'));
    lifecycle.onWillShutdown(() => order.push('join'));
    const result = await lifecycle.checkVeto('quit');
    expect(result).toMatchObject({ vetoed: true, vetoedBy: ['busy'] });
    expect(lifecycle.shutdownState.peek()).toBe('running');
    expect(order).toEqual([]);
  });

  it('C13: onSlowVeto fires with the pending ids after vetoNoticeMs, then the veto can finish', async () => {
    const { t, lifecycle } = setup();
    const slow: string[][] = [];
    lifecycle.onSlowVeto((e) => slow.push([...e.pending]));
    const dialog = new DeferredPromise<boolean>();
    lifecycle.onBeforeShutdown((e) => e.veto(dialog.promise, 'save-dialog'));
    const result = lifecycle.shutdown('close');
    await Promise.resolve();
    t.scheduler.advance(2999);
    expect(slow).toEqual([]);
    t.scheduler.advance(1);
    expect(slow).toEqual([['save-dialog']]);
    dialog.resolve(false);
    expect((await result).vetoed).toBe(false);
  });
});

describe('C13: shutdown join', () => {
  it('C13: joins are bounded: a slow participant is listed in timedOut and the signal aborts', async () => {
    const { t, lifecycle, order } = setup();
    const never = new DeferredPromise<void>();
    let aborted = false;
    lifecycle.onWillShutdown((e) => {
      e.signal.addEventListener('abort', () => (aborted = true));
      e.join('fast', async () => void order.push('fast done'));
      e.join('slow', never.promise);
    });
    const result = lifecycle.shutdown('close');
    for (let i = 0; i < 10; i++) await Promise.resolve(); // the veto phase and the join start
    t.scheduler.advance(3000);
    const done = await result;
    expect(done.timedOut).toEqual(['slow']);
    expect(aborted).toBe(true);
    expect(order).toEqual(['fast done', 'dispose']);
    never.resolve();
  });

  it('C13: a join that rejects is reported and does not block the others', async () => {
    const { lifecycle, order } = setup();
    const errors = captureErrors();
    lifecycle.onWillShutdown((e) => {
      e.join('bad', async () => {
        throw new Error('flush failed');
      });
      e.join('good', async () => void order.push('good'));
    });
    const result = await lifecycle.shutdown('close');
    expect(result.timedOut).toEqual([]);
    expect(order).toEqual(['good', 'dispose']);
    expect(errors.drain().some((e) => e.context.target === 'join:bad')).toBe(true);
    errors.dispose();
  });

  it('C13: a second shutdown call while one runs returns the same result', async () => {
    const { lifecycle } = setup();
    const a = lifecycle.shutdown('close');
    const b = lifecycle.shutdown('close');
    expect(b).toBe(a);
    await a;
  });
});

async function ticks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe('C13: one veto phase in flight (lifecycle-quit-anyway-ignored)', () => {
  it('C13: shutdown(force) during a pending veto ends the veto and goes on to join and dispose', async () => {
    const { lifecycle, order } = setup();
    const dialog = new DeferredPromise<boolean>();
    lifecycle.onBeforeShutdown((e) => {
      order.push('veto');
      e.veto(dialog.promise, 'unsaved-editor');
    });
    lifecycle.onWillShutdown((e) => {
      order.push('join');
      e.join('save', async () => void order.push('saved'));
    });
    const pending = lifecycle.shutdown('quit');
    await ticks();
    expect(lifecycle.shutdownState.peek()).toBe('vetoing');
    const forced = lifecycle.shutdown('quit', { force: true });
    const [first, second] = await Promise.all([pending, forced]);
    expect(first).toEqual({ vetoed: false, vetoedBy: [], timedOut: [] });
    expect(second).toBe(first); // one run, one result
    expect(order).toEqual(['veto', 'join', 'saved', 'dispose']);
    expect(lifecycle.shutdownState.peek()).toBe('done');
    dialog.resolve(true);
  });

  it('C13: two concurrent checkVeto calls share one run of the handlers and give the same result', async () => {
    const { lifecycle } = setup();
    let calls = 0;
    const dialog = new DeferredPromise<boolean>();
    lifecycle.onBeforeShutdown((e) => {
      calls++;
      e.veto(dialog.promise, 'editor');
    });
    const a = lifecycle.checkVeto('quit');
    const b = lifecycle.checkVeto('quit');
    await ticks();
    dialog.resolve(true);
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra).toEqual({ vetoed: true, vetoedBy: ['editor'], timedOut: [] });
    expect(rb).toEqual(ra);
    expect(lifecycle.shutdownState.peek()).toBe('running');
  });

  it('C13: a shutdown during a checkVeto waits for that veto and returns it', async () => {
    const { lifecycle, order } = setup();
    let calls = 0;
    const dialog = new DeferredPromise<boolean>();
    lifecycle.onBeforeShutdown((e) => {
      calls++;
      e.veto(dialog.promise, 'editor');
    });
    const check = lifecycle.checkVeto('quit');
    const quit = lifecycle.shutdown('quit');
    await ticks();
    dialog.resolve(true);
    expect((await check).vetoed).toBe(true);
    expect(await quit).toMatchObject({ vetoed: true, vetoedBy: ['editor'] });
    expect(calls).toBe(1);
    expect(order).toEqual([]); // no dispose
    expect(lifecycle.shutdownState.peek()).toBe('running');
  });

  it('C13: force during a pending checkVeto resolves the check with no vetoes and the shutdown runs', async () => {
    const { lifecycle, order } = setup();
    const dialog = new DeferredPromise<boolean>();
    lifecycle.onBeforeShutdown((e) => e.veto(dialog.promise, 'editor'));
    const check = lifecycle.checkVeto('quit');
    await ticks();
    const result = await lifecycle.shutdown('quit', { force: true });
    expect(result.vetoed).toBe(false);
    expect((await check).vetoed).toBe(false);
    expect(order).toEqual(['dispose']);
    dialog.resolve(true);
  });

  it('C13: the vetoed:false shortcut applies only after the veto step (joining, disposing, done)', async () => {
    const { lifecycle } = setup();
    await lifecycle.shutdown('quit');
    expect(await lifecycle.checkVeto('quit')).toEqual({ vetoed: false, vetoedBy: [], timedOut: [] });
    expect(await lifecycle.shutdown('quit')).toEqual({ vetoed: false, vetoedBy: [], timedOut: [] });
  });

  it('C13: a join that rejects is listed in failed', async () => {
    const { lifecycle } = setup();
    const errors = captureErrors();
    lifecycle.onWillShutdown((e) => {
      e.join('storage.flush', async () => {
        throw new Error('1 key could not be written');
      });
    });
    const result = await lifecycle.shutdown('close');
    expect(result.failed).toEqual(['storage.flush']);
    errors.drain();
    errors.dispose();
  });
});

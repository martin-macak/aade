import { describe, expect, it } from 'vitest';
import { LifecycleService, SHUTDOWN_ORDER } from '@tessera/contracts';
import { eventsModule } from '@tessera/events';
import { captureErrors, createTestScope } from '@tessera/testing';
import { lifecycleModule } from '@tessera/lifecycle';

function setup() {
  const t = createTestScope({ modules: [eventsModule, lifecycleModule] });
  const lifecycle = t.application.get(LifecycleService);
  return { t, lifecycle };
}

const hang = (): Promise<never> => new Promise<never>(() => undefined);

describe('I32: ordered shutdown steps (shutdown-choreography-hardwired-in-shell)', () => {
  it('runs steps by order, calls close() of every step first, and a step at order 350 runs between contributions and layout', async () => {
    const { lifecycle } = setup();
    const log: string[] = [];
    const step = (id: string, order: number, withClose = false) =>
      lifecycle.registerShutdownStep({ id, order, ...(withClose ? { close: () => void log.push(`close:${id}`) } : {}), run: async () => void log.push(id) });
    step('layout', SHUTDOWN_ORDER.layout);
    step('contributions', SHUTDOWN_ORDER.contributions, true);
    step('custom', 350);
    step('plugins', SHUTDOWN_ORDER.plugins, true);
    await lifecycle.shutdown('quit');
    expect(log).toEqual(['close:plugins', 'close:contributions', 'plugins', 'contributions', 'custom', 'layout']);
  });

  it('a hung plugin step and a hung final flush end inside disposeBudgetMs plus the floors (6.5 s) and are reported', async () => {
    const { t, lifecycle } = setup();
    lifecycle.registerShutdownStep({ id: 'plugins', order: SHUTDOWN_ORDER.plugins, run: hang });
    lifecycle.registerShutdownStep({ id: 'storage.flush', order: SHUTDOWN_ORDER.storageFinal, run: hang });
    lifecycle.registerShutdownStep({ id: 'application.dispose', order: SHUTDOWN_ORDER.applicationDispose, run: hang });
    const errors = captureErrors();
    const started = t.scheduler.now();
    const box: { result?: Awaited<ReturnType<typeof lifecycle.shutdown>> } = {};
    void lifecycle.shutdown('quit').then((r) => (box.result = r));
    for (let j = 0; j < 100; j++) await Promise.resolve(); // the shutdown reaches its steps before the clock moves
    while (!box.result && t.scheduler.now() - started < 10_000) {
      t.scheduler.advance(25);
      for (let j = 0; j < 100; j++) await Promise.resolve();
    }
    const result = box.result;
    expect(result).toBeDefined();
    expect(t.scheduler.now() - started).toBeLessThanOrEqual(6500);
    expect(result?.timedOut).toEqual(['plugins', 'storage.flush', 'application.dispose']);
    expect(lifecycle.shutdownState.peek()).toBe('done');
    errors.dispose();
  });

  it('a step that reports failed ids and a step that throws: the next step runs, the result lists both, lifecycle.shutdownStepFailed is reported', async () => {
    const { lifecycle } = setup();
    const ran: string[] = [];
    lifecycle.registerShutdownStep({ id: 'a', order: 10, run: async () => ({ failed: ['storage.flush'], notStarted: ['p1'] }) });
    lifecycle.registerShutdownStep({
      id: 'b',
      order: 20,
      run: async () => {
        throw new Error('boom');
      },
    });
    lifecycle.registerShutdownStep({ id: 'c', order: 30, run: async () => void ran.push('c') });
    const errors = captureErrors();
    const result = await lifecycle.shutdown('quit');
    expect(ran).toEqual(['c']);
    expect(result.failed).toEqual(['storage.flush', 'b']);
    expect(result.notStarted).toEqual(['p1']);
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toEqual(['lifecycle.shutdownStepFailed']);
  });

  it('a duplicate id throws; a disposed registration does not run', async () => {
    const { lifecycle } = setup();
    const ran: string[] = [];
    const first = lifecycle.registerShutdownStep({ id: 'x', order: 1, run: async () => void ran.push('x') });
    expect(() => lifecycle.registerShutdownStep({ id: 'x', order: 2, run: async () => undefined })).toThrowError(expect.objectContaining({ code: 'lifecycle.duplicateShutdownStep' }));
    first.dispose();
    await lifecycle.shutdown('quit');
    expect(ran).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '@tessera/testing';
import {
  Barrier,
  CancellationError,
  DeferredPromise,
  MigrationStatus,
  TesseraError,
  ValidationError,
  createLogger,
  deserializeError,
  generateId,
  getScheduler,
  isCancellationError,
  isDevMode,
  matchGlob,
  migrateValue,
  parseOrThrow,
  raceAbort,
  serializeError,
  setDevMode,
  setScheduler,
  throwIfAborted,
  toStoredValue,
  withTimeout,
  LogLevel,
  type Schema,
  type StateSchema,
} from '@tessera/base';

describe('errors', () => {
  it('TesseraError carries code, details and cause', () => {
    const cause = new Error('root');
    const error = new TesseraError('x.y', 'message', { cause, details: { a: 1 } });
    expect(error.code).toBe('x.y');
    expect(error.details).toEqual({ a: 1 });
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it('serializeError and deserializeError round-trip code, details and cause chain', () => {
    const error = new TesseraError('x.y', 'outer', { cause: new TesseraError('inner.code', 'inner'), details: { id: 'p1' } });
    const wire = JSON.parse(JSON.stringify(serializeError(error)));
    const back = deserializeError(wire);
    expect(back.code).toBe('x.y');
    expect(back.message).toBe('outer');
    expect(back.details).toEqual({ id: 'p1' });
    expect((back.cause as TesseraError).code).toBe('inner.code');
  });

  it('serializeError handles non-errors', () => {
    expect(serializeError('text')).toEqual({ name: 'NonError', message: 'text' });
    expect(serializeError({ a: 1 }).message).toBe('{"a":1}');
  });
});

describe('cancellation', () => {
  it('raceAbort rejects with CancellationError when the signal aborts first', async () => {
    const controller = new AbortController();
    const never = new Promise<number>(() => {});
    const raced = raceAbort(never, controller.signal);
    controller.abort();
    const error = await raced.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancellationError);
    expect(isCancellationError(error)).toBe(true);
    expect((error as CancellationError).code).toBe('cancelled');
    expect((error as CancellationError).name).toBe('AbortError');
  });

  it('raceAbort passes the promise result through and removes its listener', async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve(3), controller.signal)).resolves.toBe(3);
    await expect(raceAbort(Promise.reject(new Error('no')), controller.signal)).rejects.toThrow('no');
    await expect(raceAbort(Promise.resolve(1), AbortSignal.abort())).rejects.toBeInstanceOf(CancellationError);
  });

  it('throwIfAborted throws only for an aborted signal', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(AbortSignal.abort())).toThrow(CancellationError);
  });
});

describe('schemas and migrations', () => {
  const numberSchema: Schema<{ n: number }> = {
    safeParse(input) {
      const n = (input as { n?: unknown } | null)?.n;
      return typeof n === 'number' ? { success: true, data: { n } } : { success: false, error: { issues: [{ path: ['n'], message: 'n must be a number' }] } };
    },
  };
  const v3: StateSchema<{ n: number }> = {
    version: 3,
    schema: numberSchema,
    initial: () => ({ n: 0 }),
    migrations: [
      { from: 1, migrate: (d) => ({ n: Number((d as { count: string }).count) }) },
      { from: 2, migrate: (d) => ({ n: (d as { n: number }).n * 10 }) },
    ],
  };

  it('parseOrThrow returns data or throws ValidationError naming what was parsed', () => {
    expect(parseOrThrow(numberSchema, { n: 1 }, 'thing')).toEqual({ n: 1 });
    let error: ValidationError | undefined;
    try {
      parseOrThrow(numberSchema, {}, 'the thing');
    } catch (e) {
      error = e as ValidationError;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.code).toBe('validation');
    expect(error?.message).toContain('the thing');
    expect(error?.issues[0]?.path).toEqual(['n']);
  });

  it('missing: initial()', () => {
    expect(migrateValue(undefined, v3)).toMatchObject({ status: MigrationStatus.Missing, value: { n: 0 }, fromVersion: undefined });
  });

  it('current: stored version equals schema version', () => {
    expect(migrateValue({ v: 3, data: { n: 5 } }, v3)).toMatchObject({ status: MigrationStatus.Current, value: { n: 5 } });
  });

  it('migrated: applies steps one by one in order', () => {
    expect(migrateValue({ v: 1, data: { count: '4' } }, v3)).toMatchObject({ status: MigrationStatus.Migrated, value: { n: 40 }, fromVersion: 1 });
    expect(migrateValue({ v: 2, data: { n: 4 } }, v3)).toMatchObject({ status: MigrationStatus.Migrated, value: { n: 40 }, fromVersion: 2 });
  });

  it('reset-newer: stored version is newer than the app', () => {
    expect(migrateValue({ v: 9, data: { n: 5 } }, v3)).toMatchObject({ status: MigrationStatus.ResetNewer, value: { n: 0 }, fromVersion: 9 });
  });

  it('reset-no-path: a step is missing or throws', () => {
    const gap: StateSchema<{ n: number }> = { ...v3, migrations: [v3.migrations![1]!] };
    expect(migrateValue({ v: 1, data: {} }, gap).status).toBe(MigrationStatus.ResetNoPath);
    const result = migrateValue({ v: 1, data: null }, v3);
    expect(result.status).toBe(MigrationStatus.ResetNoPath);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('reset-invalid: validation fails after migration, or the envelope is malformed', () => {
    expect(migrateValue({ v: 3, data: { n: 'x' } }, v3)).toMatchObject({ status: MigrationStatus.ResetInvalid, value: { n: 0 } });
    expect(migrateValue({ v: 'x', data: 1 } as never, v3).status).toBe(MigrationStatus.ResetInvalid);
    expect(migrateValue({ v: 0, data: 1 }, v3).status).toBe(MigrationStatus.ResetInvalid);
  });

  it('never throws, even if the schema throws', () => {
    const exploding: StateSchema<number> = { version: 1, schema: { safeParse: () => { throw new Error('boom'); } }, initial: () => 0 };
    expect(migrateValue({ v: 1, data: 1 }, exploding).status).toBe(MigrationStatus.ResetInvalid);
  });

  it('toStoredValue writes the envelope', () => {
    expect(toStoredValue({ n: 1 }, v3)).toEqual({ v: 3, data: { n: 1 } });
  });
});

describe('matchGlob', () => {
  it.each([
    ['tasks.add', 'tasks.add', true],
    ['tasks.*', 'tasks.add', true],
    ['tasks.*', 'tasks.add.more', false],
    ['tasks.*', 'tasks', false],
    ['*', 'tasks.add', false],
    ['*', 'tasks', true],
    ['**', 'a.b.c', true],
    ['tasks.**', 'tasks', true],
    ['tasks.**', 'tasks.a.b', true],
    ['**.add', 'tasks.x.add', true],
    ['**.add', 'add', true],
    ['**.add', 'tasks.remove', false],
    ['tasks.a*', 'tasks.add', true],
    ['tasks.a*', 'tasks.remove', false],
    ['a.*.c', 'a.b.c', true],
    ['a.*.c', 'a.b.d', false],
  ] as const)('matchGlob(%s, %s) is %s', (pattern, value, expected) => {
    expect(matchGlob(pattern, value)).toBe(expected);
  });
});

describe('async helpers', () => {
  it('Barrier waits until opened', async () => {
    const barrier = new Barrier();
    let passed = false;
    void barrier.wait().then(() => (passed = true));
    await Promise.resolve();
    expect(passed).toBe(false);
    barrier.open();
    await barrier.wait();
    expect(barrier.isOpen).toBe(true);
    expect(passed).toBe(true);
  });

  it('DeferredPromise settles once', async () => {
    const d = new DeferredPromise<number>();
    d.resolve(1);
    d.resolve(2);
    d.reject(new Error('late'));
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(1);
  });

  it('withTimeout rejects with code timeout through the scheduler and passes results otherwise', async () => {
    const scheduler = new ManualScheduler();
    const install = scheduler.install();
    const slow = withTimeout(new Promise<number>(() => {}), 1000, 'slow work');
    scheduler.advance(1000);
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });
    const fast = withTimeout(Promise.resolve(5), 1000, 'fast work');
    await expect(fast).resolves.toBe(5);
    expect(scheduler.pendingTimers).toBe(0);
    install.dispose();
  });
});

describe('scheduler, logging, ids, dev mode', () => {
  it('setScheduler swaps the process-wide scheduler and the handle restores it', () => {
    const original = getScheduler();
    const manual = new ManualScheduler();
    const handle = setScheduler(manual);
    expect(getScheduler()).toBe(manual);
    handle.dispose();
    expect(getScheduler()).toBe(original);
  });

  it('createLogger filters by level and child() extends the name', () => {
    const records: string[] = [];
    const logger = createLogger('app', { level: LogLevel.Info, sink: (r) => records.push(`${r.logger}:${r.message}`) });
    logger.debug('hidden');
    logger.info('shown');
    logger.child('sub').warn('also shown');
    expect(records).toEqual(['app:shown', 'app.sub:also shown']);
  });

  it('generateId has the prefix and is unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('p')));
    expect(ids.size).toBe(100);
    expect([...ids][0]).toMatch(/^p-[0-9a-f]{12}$/);
  });

  it('dev mode defaults to on and can be switched', () => {
    expect(isDevMode()).toBe(true);
    setDevMode(false);
    expect(isDevMode()).toBe(false);
    setDevMode(true);
  });
});

describe('errors: the deduping reporter (no-plugin-resource-limits)', () => {
  it('forwards the first report, counts equal ones for 5 s, then emits one "suppressed N" record', async () => {
    const { createTestScope } = await import('@tessera/testing');
    const { dedupingReporter } = await import('@tessera/base');
    const t = createTestScope({ flat: true });
    const seen: Array<{ error: unknown; context: { target?: string; pluginId?: string } }> = [];
    const reporter = dedupingReporter({ report: (error, context) => void seen.push({ error, context }) });
    const context = { source: 'command', target: 'tasks.add', pluginId: 'acme.loop' } as const;
    for (let i = 0; i < 100; i++) reporter.report(new TesseraError('command.failed', 'boom'), context);
    reporter.report(new TesseraError('command.failed', 'boom'), { ...context, pluginId: 'acme.other' }); // another owner: its own entry
    expect(seen).toHaveLength(2);
    t.scheduler.advance(4999);
    expect(seen).toHaveLength(2);
    t.scheduler.advance(1);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.error).toMatchObject({ code: 'errors.suppressed', details: { code: 'command.failed', suppressed: 99 } });
    expect(seen[2]?.context.pluginId).toBe('acme.loop');
    // after the window the same error is forwarded again
    reporter.report(new TesseraError('command.failed', 'boom'), context);
    expect(seen).toHaveLength(4);
    reporter.dispose();
  });

  it('keys on the data the report is about: two quarantined keys give two reports, and errors.suppressed lists the distinct dropped keys', async () => {
    const { createTestScope } = await import('@tessera/testing');
    const { dedupingReporter } = await import('@tessera/base');
    const t = createTestScope({ flat: true });
    const seen: Array<{ error: unknown }> = [];
    const reporter = dedupingReporter({ report: (error) => void seen.push({ error }) });
    const context = { source: 'persistence', target: 'write:application' } as const;
    reporter.report(new TesseraError('storage.tooLarge', 'big', { details: { key: 'a' } }), context);
    reporter.report(new TesseraError('storage.tooLarge', 'big', { details: { key: 'b' } }), context);
    expect(seen).toHaveLength(2); // not one: the second key is different data
    reporter.report(new TesseraError('storage.tooLarge', 'big', { details: { key: 'b' } }), context);
    reporter.report(new TesseraError('storage.tooLarge', 'big', { details: { key: 'b' } }), context);
    t.scheduler.advance(5000);
    const summary = seen.map((s) => s.error).filter((e) => (e as { code?: string }).code === 'errors.suppressed');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ details: { suppressed: 2, keys: ['b'] } });
    reporter.dispose();
  });

  it('regression:dedupe-unique-detail-flood: a loop with a new details.id on every report forwards at most 10 reports per window, then one errors.suppressed', async () => {
    const { createTestScope } = await import('@tessera/testing');
    const { dedupingReporter } = await import('@tessera/base');
    const t = createTestScope({ flat: true });
    const seen: Array<{ error: unknown }> = [];
    const reporter = dedupingReporter({ report: (error) => void seen.push({ error }) });
    const context = { source: 'command', target: 'generate', pluginId: 'acme.gen' } as const;
    for (let i = 0; i < 100; i++) reporter.report(new TesseraError('command.failed', 'boom', { details: { id: `id-${i}` } }), context);
    expect(seen).toHaveLength(10); // the cap; the first ten distinct ids still give ten reports
    // another owner has its own budget
    reporter.report(new TesseraError('command.failed', 'boom', { details: { id: 'x' } }), { ...context, pluginId: 'acme.other' });
    expect(seen).toHaveLength(11);
    t.scheduler.advance(5000);
    const summaries = seen.map((s) => s.error as { code?: string; details?: { suppressed: number; keys: string[] } }).filter((e) => e.code === 'errors.suppressed');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.details?.suppressed).toBe(90);
    expect(summaries[0]?.details?.keys).toHaveLength(20); // the list of keys stays bounded
    // the window is over: the budget is back
    const before = seen.length;
    for (let i = 0; i < 100; i++) reporter.report(new TesseraError('command.failed', 'boom', { details: { id: `again-${i}` } }), context);
    expect(seen.length - before).toBe(10);
    reporter.dispose();
  });
});

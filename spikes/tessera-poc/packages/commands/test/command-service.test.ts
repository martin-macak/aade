import { describe, expect, it } from 'vitest';
import { CancellationError, createLogger, LogLevel, type LogRecord } from '@tessera/base';
import { token, type Scope } from '@tessera/di';
import { CoreTopics, EventBus, EventNode, WorkItemService, WorkbenchService, type CommandExecutedEvent, type CommandSource, type PlacementId } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { declare, kit } from './kit.ts';

describe('C11: CommandService.execute', () => {
  it('C11: an unknown id rejects with command.notFound and execute never throws synchronously', async () => {
    const k = kit();
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = k.commands.execute('does.not.exist');
    }).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: 'command.notFound' });
  });

  it('C11: execute never throws synchronously, whatever goes wrong', async () => {
    const k = kit();
    declare(k, 'a.declaredOnly');
    k.registry.registerHandler('a.throws', {
      run: () => {
        throw new Error('handler failed');
      },
    });
    const capture = captureErrors();
    const calls = [
      () => k.commands.execute('does.not.exist'),
      () => k.commands.execute('a.declaredOnly'),
      () => k.commands.execute('a.throws'),
      () => k.commands.execute('a.throws', undefined, { signal: AbortSignal.abort() }),
    ];
    for (const call of calls) {
      let promise: Promise<unknown> | undefined;
      expect(() => (promise = call())).not.toThrow();
      await expect(promise).rejects.toBeInstanceOf(Error);
    }
    capture.drain();
    capture.dispose();
  });

  it('C11: runs the handler with args and returns its result (sync and async handlers)', async () => {
    const k = kit();
    declare(k, 'tasks.add');
    k.registry.registerHandler('tasks.add', { run: (args: { title: string }) => `added ${args.title}` });
    k.registry.registerHandler('tasks.later', { run: async () => 'async result' });
    await expect(k.commands.execute('tasks.add', { title: 'write tests' })).resolves.toBe('added write tests');
    await expect(k.commands.execute('tasks.later')).resolves.toBe('async result');
  });

  it('C11: a declared command without a handler rejects with command.unavailable when nothing can activate it', async () => {
    const k = kit();
    declare(k, 'a.noHandler');
    await expect(k.commands.execute('a.noHandler')).rejects.toMatchObject({ code: 'command.unavailable' });
  });

  it('C11: a sleeping plugin is activated by onCommand:<id>, then the handler runs', async () => {
    const events: string[] = [];
    const k = kit({
      activation: {
        isActive: () => false,
        async activateByEvent(event) {
          events.push(event);
          k.registry.registerHandler('tasks.add', { run: () => 'ran after activation' }, 'sample.tasks');
        },
      },
    });
    declare(k, 'tasks.add', { owner: 'sample.tasks' });
    await expect(k.commands.execute('tasks.add')).resolves.toBe('ran after activation');
    expect(events).toEqual(['onCommand:tasks.add']);
    await k.commands.execute('tasks.add');
    // The question is asked on every execution (a dormant plugin may guard the command), the plugin manager answers it from an index
    // at once when nobody waits; the handler is not registered a second time.
    expect(events).toEqual(['onCommand:tasks.add', 'onCommand:tasks.add']);
  });

  it('C11: if activation does not provide a handler the command is unavailable', async () => {
    const k = kit({ activation: { isActive: () => false, activateByEvent: async () => {} } });
    declare(k, 'tasks.add', { owner: 'sample.tasks' });
    await expect(k.commands.execute('tasks.add')).rejects.toMatchObject({ code: 'command.unavailable' });
  });

  it('C11: an internal command (handler without metadata) is executable', async () => {
    const k = kit();
    k.registry.registerHandler('internal.thing', { run: () => 'internal' });
    await expect(k.commands.execute('internal.thing')).resolves.toBe('internal');
  });

  it('C11: unregistering the handler makes the command unavailable again', async () => {
    const k = kit();
    declare(k, 'a.b');
    const handle = k.registry.registerHandler('a.b', { run: () => 1 });
    await expect(k.commands.execute('a.b')).resolves.toBe(1);
    handle.dispose();
    await expect(k.commands.execute('a.b')).rejects.toMatchObject({ code: 'command.unavailable' });
  });
});

describe('C11: enablement is enforced for every source', () => {
  const sources: CommandSource[] = ['palette', 'keybinding', 'menu', 'view', 'api', 'rpc'];

  it.each(sources)('C11: a disabled command rejects with command.disabled from source %s, and runs once enabled', async (source) => {
    const k = kit();
    let runs = 0;
    declare(k, 'tasks.complete', { enablement: 'tasks.hasSelection' });
    k.registry.registerHandler('tasks.complete', { run: () => ++runs });
    await expect(k.commands.execute('tasks.complete', undefined, { source, context: k.win })).rejects.toMatchObject({ code: 'command.disabled' });
    expect(runs).toBe(0);
    k.win.set('tasks.hasSelection', true);
    await expect(k.commands.execute('tasks.complete', undefined, { source, context: k.win })).resolves.toBe(1);
  });

  it('C11: enablement is evaluated in the given context-key scope, else in the focused one', async () => {
    const k = kit();
    declare(k, 'tasks.complete', { enablement: 'tasks.hasSelection' });
    k.registry.registerHandler('tasks.complete', { run: () => 'ok' });
    const placement = k.win.createChild('placement:p1');
    placement.set('tasks.hasSelection', true);
    await expect(k.commands.execute('tasks.complete')).rejects.toMatchObject({ code: 'command.disabled' });
    await expect(k.commands.execute('tasks.complete', undefined, { context: placement })).resolves.toBe('ok');
    k.keys.setFocused(placement);
    await expect(k.commands.execute('tasks.complete')).resolves.toBe('ok');
  });

  it('C11: handler.isEnabled is an extra check', async () => {
    const k = kit();
    let allowed = false;
    declare(k, 'a.b');
    k.registry.registerHandler('a.b', { isEnabled: () => allowed, run: () => 'ran' });
    await expect(k.commands.execute('a.b')).rejects.toMatchObject({ code: 'command.disabled' });
    allowed = true;
    await expect(k.commands.execute('a.b')).resolves.toBe('ran');
  });

  it('C11: force skips the enablement check and is audited with a warn log, not with an error report', async () => {
    const records: LogRecord[] = [];
    const k = kit({ logger: createLogger('test', { level: LogLevel.Debug, sink: (r) => void records.push(r) }) });
    const capture = captureErrors();
    declare(k, 'a.b', { enablement: 'never' });
    k.registry.registerHandler('a.b', { run: () => 'forced' });
    await expect(k.commands.execute('a.b')).rejects.toMatchObject({ code: 'command.disabled' });
    await expect(k.commands.execute('a.b', undefined, { force: true, source: 'rpc' })).resolves.toBe('forced');
    expect(capture.drain()).toEqual([]); // a legitimate forced execution is not an application error
    capture.dispose();
    const audited = records.filter((r) => r.level === LogLevel.Warn);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.message).toContain('a.b');
    expect(audited[0]?.data).toMatchObject({ commandId: 'a.b', source: 'rpc' });
  });
});

describe('C11: CommandContext.services falls back from the placement to its WorkItem to the window', () => {
  const Marker = token<string>('fixture/Marker');

  function fakes(k: ReturnType<typeof kit>, options: { readonly placementScope: Scope | undefined; readonly workItemScope: Scope | undefined }): void {
    const ref = { id: 'p1', viewType: 'v', instanceId: 'i1', workspaceId: 'w', windowId: 'win' };
    k.t.window.provideValue(WorkbenchService, {
      placement: (id: string) => (id === 'p1' ? { ...ref, scope: options.placementScope } : undefined),
      instance: (id: string) => (id === 'i1' ? { id, viewType: 'v', key: 'k', workItemPath: 'root/tasks' } : undefined),
    } as unknown as WorkbenchService);
    k.t.window.provideValue(WorkItemService, { find: (path: string) => (path === 'root/tasks' && options.workItemScope ? { scope: options.workItemScope } : undefined) } as unknown as WorkItemService);
  }

  async function markerSeenBy(k: ReturnType<typeof kit>): Promise<string | undefined> {
    let seen: string | undefined;
    k.registry.registerHandler('a.who', { run: (_a: unknown, ctx) => void (seen = ctx.services.get(Marker, { optional: true })) });
    await k.commands.execute('a.who', undefined, { placementId: 'p1' as PlacementId });
    return seen;
  }

  it('C11: a placement with a presenter: its scope', async () => {
    const k = kit();
    const placementScope = k.t.window.createChild('placement', 'p1');
    placementScope.provideValue(Marker, 'placement');
    const workItemScope = k.t.window.createChild('workItem', 'tasks');
    workItemScope.provideValue(Marker, 'workItem');
    fakes(k, { placementScope, workItemScope });
    expect(await markerSeenBy(k)).toBe('placement');
  });

  it('C11: a placement without a presenter (pending, placeholder): the scope of its WorkItem, not the window', async () => {
    const k = kit();
    k.t.window.provideValue(Marker, 'window');
    const workItemScope = k.t.window.createChild('workItem', 'tasks');
    workItemScope.provideValue(Marker, 'workItem');
    fakes(k, { placementScope: undefined, workItemScope });
    expect(await markerSeenBy(k)).toBe('workItem');
  });

  it('C11: no placement scope and no WorkItem: the window scope', async () => {
    const k = kit();
    k.t.window.provideValue(Marker, 'window');
    fakes(k, { placementScope: undefined, workItemScope: undefined });
    expect(await markerSeenBy(k)).toBe('window');
  });
});

describe('C11: execution runs through command interceptors with an AbortSignal', () => {
  it('C11: interceptors wrap the handler; they see command id, args, source and a signal', async () => {
    const k = kit();
    const log: string[] = [];
    k.t.interceptors.register({
      id: 'audit',
      kinds: ['command'],
      async intercept(ctx, next) {
        log.push(`in ${ctx.target} source=${ctx.data.source} args=${JSON.stringify(ctx.data.args)} signal=${ctx.signal.aborted}`);
        const result = await next();
        log.push(`out ${String(result)}`);
        return result;
      },
    });
    declare(k, 'a.b');
    k.registry.registerHandler('a.b', { run: (args: { n: number }) => args.n * 2 });
    await expect(k.commands.execute('a.b', { n: 21 }, { source: 'palette' })).resolves.toBe(42);
    expect(log).toEqual(['in a.b source=palette args={"n":21} signal=false', 'out 42']);
  });

  it('C11: a guard interceptor can veto, and the veto is the caller\'s rejection; the handler never runs', async () => {
    const k = kit();
    let ran = false;
    k.t.interceptors.register({
      id: 'deny',
      kinds: ['command'],
      match: 'a.*',
      phase: 'guard',
      intercept: async () => {
        throw new Error('denied');
      },
    });
    declare(k, 'a.b');
    k.registry.registerHandler('a.b', { run: () => (ran = true) });
    const error = await k.commands.execute('a.b').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'interceptor.failed', interceptorId: 'deny' });
    expect(ran).toBe(false);
  });

  it('C11: an interceptor can rewrite the arguments with ctx.with()', async () => {
    const k = kit();
    k.t.interceptors.register({
      id: 'rewrite',
      kinds: ['command'],
      intercept: (ctx, next) => next(ctx.with({ data: { ...ctx.data, args: 'rewritten' } })),
    });
    k.registry.registerHandler('a.b', { run: (args: unknown) => args });
    await expect(k.commands.execute('a.b', 'original')).resolves.toBe('rewritten');
  });

  it('C11: the caller signal aborts the handler signal and the call rejects with CancellationError and outcome cancelled', async () => {
    const k = kit();
    const outcomes: string[] = [];
    k.commands.onDidExecute((e) => outcomes.push(e.outcome));
    const controller = new AbortController();
    k.registry.registerHandler('a.slow', {
      run: (_args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new CancellationError()), { once: true });
        }),
    });
    const pending = k.commands.execute('a.slow', undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancellationError);
    expect(outcomes).toEqual(['cancelled']);
  });

  it('C11: an already aborted signal rejects before the handler runs', async () => {
    const k = kit();
    let ran = false;
    k.registry.registerHandler('a.b', { run: () => (ran = true) });
    await expect(k.commands.execute('a.b', undefined, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancellationError);
    expect(ran).toBe(false);
  });

  it('C11: disposing the window scope (shutdown) aborts the signal of running commands', async () => {
    const k = kit();
    let signal: AbortSignal | undefined;
    k.registry.registerHandler('a.slow', {
      run: (_args, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    });
    void k.commands.execute('a.slow').catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await k.t.window.dispose();
    expect(signal?.aborted).toBe(true);
  });

  it('C11: a nested ctx.execute() runs with the outer invocation as parent: one trace, depth + 1', async () => {
    const k = kit();
    const seen: Array<{ id: string; depth: number; trace: string }> = [];
    k.t.interceptors.register({
      id: 'trace',
      kinds: ['command'],
      async intercept(ctx, next) {
        seen.push({ id: ctx.target, depth: ctx.depth, trace: ctx.traceId });
        return next();
      },
    });
    k.registry.registerHandler('outer', { run: (_a, ctx) => ctx.execute('inner') });
    k.registry.registerHandler('inner', { run: () => 'inner result' });
    await expect(k.commands.execute('outer')).resolves.toBe('inner result');
    expect(seen.map((s) => [s.id, s.depth])).toEqual([['outer', 0], ['inner', 1]]);
    expect(seen[0]?.trace).toBe(seen[1]?.trace);
  });

  it('C11: a command that calls itself is stopped by the depth limit (interceptor.depth)', async () => {
    const k = kit();
    const capture = captureErrors();
    k.t.interceptors.register({ id: 'any', kinds: ['command'], intercept: (_c, next) => next() });
    k.registry.registerHandler('loop', { run: (_a, ctx) => ctx.execute('loop') });
    await expect(k.commands.execute('loop')).rejects.toMatchObject({ code: 'interceptor.depth' });
    capture.drain();
    capture.dispose();
  });
});

describe('C11: results are reported', () => {
  it('C11: onDidExecute and the commandExecuted topic carry id, source, outcome, duration, error code and owner', async () => {
    const k = kit();
    const capture = captureErrors();
    const fromEvent: CommandExecutedEvent[] = [];
    const fromBus: CommandExecutedEvent[] = [];
    k.commands.onDidExecute((e) => fromEvent.push(e));
    k.t.window.get(EventNode).subscribe(CoreTopics.commandExecuted, (e) => fromBus.push(e));
    declare(k, 'ok.cmd', { owner: 'sample.tasks' });
    declare(k, 'fail.cmd', { owner: 'sample.faulty', enablement: 'never' });
    declare(k, 'boom.cmd', { owner: 'sample.faulty' });
    k.registry.registerHandler('ok.cmd', { run: () => 'ok' }, 'sample.tasks');
    k.registry.registerHandler('fail.cmd', { run: () => 'x' }, 'sample.faulty');
    k.registry.registerHandler('boom.cmd', { run: () => { throw new Error('handler exploded'); } }, 'sample.faulty');
    await k.commands.execute('ok.cmd', undefined, { source: 'menu' });
    await k.commands.execute('fail.cmd').catch(() => {});
    await k.commands.execute('boom.cmd').catch(() => {});
    await k.commands.execute('missing.cmd').catch(() => {});
    expect(fromEvent.map((e) => [e.commandId, e.source, e.outcome, e.errorCode, e.owner])).toEqual([
      ['ok.cmd', 'menu', 'ok', undefined, 'sample.tasks'],
      ['fail.cmd', 'api', 'rejected', 'command.disabled', 'sample.faulty'],
      ['boom.cmd', 'api', 'error', undefined, 'sample.faulty'],
      ['missing.cmd', 'api', 'rejected', 'command.notFound', undefined],
    ]);
    expect(fromEvent.every((e) => e.durationMs >= 0)).toBe(true);
    expect(fromBus).toEqual(fromEvent);
    capture.drain();
    capture.dispose();
  });

  it('C11: a handler error rejects only that call and is reported once with source command and the owner plugin', async () => {
    const k = kit();
    const capture = captureErrors();
    declare(k, 'boom', { owner: 'sample.faulty' });
    k.registry.registerHandler('boom', { run: () => { throw new Error('boom'); } }, 'sample.faulty');
    k.registry.registerHandler('fine', { run: () => 'fine' });
    await expect(k.commands.execute('boom')).rejects.toThrow('boom');
    await expect(k.commands.execute('fine')).resolves.toBe('fine');
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toEqual({ source: 'command', target: 'boom', pluginId: 'sample.faulty' });
  });

  it('C11: run(CommandDef) is the typed form of execute', async () => {
    const { defineCommand } = await import('@tessera/contracts');
    const k = kit();
    const add = defineCommand<{ title: string }, string>('tasks.add');
    k.registry.registerHandler('tasks.add', { run: (a: { title: string }) => `added ${a.title}` });
    await expect(k.commands.run(add, { title: 'x' })).resolves.toBe('added x');
  });

  it('the bus root is not used for commandExecuted: the window node is', () => {
    const k = kit();
    expect(k.t.window.get(EventNode)).not.toBe(k.t.window.get(EventBus).root);
  });
});

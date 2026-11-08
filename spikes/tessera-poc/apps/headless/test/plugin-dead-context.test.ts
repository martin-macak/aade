import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { DialogService, InterceptorRegistry, UndoService, defineTopic, type PluginContext } from '@tessera/contracts';
import { token } from '@tessera/di';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';

async function ticks(count = 40): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const deactivated = expect.objectContaining({ code: 'plugin.deactivated' });

describe('I30: a dead plugin context acts nowhere (late-plugin-api-calls-not-gated-after-deactivation)', () => {
  it('after disable, execute, run, publish, showView, closePlacement, pick and notify throw plugin.deactivated', async () => {
    const a = describePlugin(manifest('fixture.a', { activationEvents: ['*'], contributes: { commands: [{ id: 'a.run', title: 'Run' }] } }), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const app = await createTestApp({ plugins: [a], modules: { [a.location]: { activate: (c: PluginContext) => void (ctxs['a'] = c) } } });
    const ctx = ctxs['a'] as PluginContext;
    await app.plugins.disable('fixture.a');
    const topic = defineTopic<object>('fixture.a.topic');
    await expect(ctx.api.commands.execute('workbench.closePlacement')).rejects.toMatchObject({ code: 'plugin.deactivated' });
    expect(() => ctx.api.events.publish(topic, {})).toThrowError(deactivated);
    expect(() => ctx.api.workbench.showView('any.view')).toThrowError(deactivated);
    expect(() => ctx.api.workbench.closePlacement('p1' as never)).toThrowError(deactivated);
    expect(() => ctx.api.window.pick([], {})).toThrowError(deactivated);
    expect(() => ctx.api.window.notify({ severity: 'info', message: 'late' })).toThrowError(deactivated);
  });

  it('a command that a plugin started aborts when the plugin is disabled, and a guard sees the invoker', async () => {
    const caller = describePlugin(manifest('fixture.caller', { activationEvents: ['*'] }), 'builtin');
    const callee = describePlugin(manifest('fixture.callee', { activationEvents: ['*'], contributes: { commands: [{ id: 'callee.slow', title: 'Slow' }] } }), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const started = new DeferredPromise<void>();
    const seen: Array<{ signal: AbortSignal }> = [];
    const app = await createTestApp({
      plugins: [caller, callee],
      modules: {
        [caller.location]: { activate: (c: PluginContext) => void (ctxs['caller'] = c) },
        [callee.location]: {
          activate: (c: PluginContext) =>
            void c.api.commands.registerHandler('callee.slow', {
              run: (_a: unknown, cc) => {
                seen.push({ signal: cc.signal });
                started.resolve();
                return new Promise<string>((_resolve, reject) => cc.signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true }));
              },
            }),
        },
      },
    });
    const invokers: Array<string | undefined> = [];
    app.get(InterceptorRegistry).register({ id: 'test.invoker', kinds: ['command'], mode: 'observer', owner: 'test', intercept: (ctx: { data: unknown }, next: (c: unknown) => unknown) => (invokers.push((ctx.data as { invoker?: string }).invoker), next(ctx)) } as never);
    const errors = captureErrors();
    const running = (ctxs['caller'] as PluginContext).api.commands.execute('callee.slow');
    const outcome = running.then(() => 'resolved', (e: unknown) => (e as { name?: string }).name ?? 'rejected');
    await started.promise;
    expect(invokers).toContain('fixture.caller');
    await app.plugins.disable('fixture.caller');
    await ticks();
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(await outcome).not.toBe('resolved');
    errors.drain();
    errors.dispose();
    // a call from a user (not a plugin) carries no invoker
    invokers.length = 0;
    await app.commands.execute('workbench.focusNext').catch(() => undefined);
    expect(invokers.every((i) => i === undefined)).toBe(true);
  });
});

describe('plugin-entry-load-unbounded: the import of the main entry has a time bound', () => {
  it('a loader that never settles fails the activation with plugin.loadTimeout, onCommand rejects, disable resolves', async () => {
    const hung = describePlugin(manifest('fixture.hung', { main: './m.js', contributes: { commands: [{ id: 'hung.run', title: 'Run' }] } }), 'builtin');
    const app = await createTestApp({ plugins: [hung], modules: { [hung.location]: () => new Promise(() => undefined) } });
    const errors = captureErrors();
    const activation = app.plugins.activate('fixture.hung').then(() => 'ok', (e: unknown) => e);
    await ticks();
    await app.advance(10_000);
    const failure = (await activation) as { code?: string; cause?: { cause?: { code?: string } } };
    expect(failure.code).toBe('plugin.activationFailed');
    expect(app.plugins.status('fixture.hung')?.failure?.cause).toBe('loadFailed');
    expect(JSON.stringify(app.plugins.status('fixture.hung')?.failure?.error)).toContain('plugin.loadTimeout');
    await expect(app.commands.execute('hung.run')).rejects.toBeDefined();
    await app.plugins.disable('fixture.hung'); // resolves; does not hang
    expect(app.plugins.status('fixture.hung')?.state).toBe('disabled');
    errors.drain();
    errors.dispose();
  });
});

describe('plugin-entry-load-unbounded: disable while the load is still pending', () => {
  it('disable() issued before the load bound resolves within load + activate + 1 s, and the state is disabled', async () => {
    const hung = describePlugin(manifest('fixture.hung2', { main: './m.js' }), 'builtin');
    const app = await createTestApp({ plugins: [hung], modules: { [hung.location]: () => new Promise(() => undefined) } });
    const errors = captureErrors();
    const activation = app.plugins.activate('fixture.hung2').then(() => 'ok', (e: unknown) => e);
    await ticks();
    await app.advance(1_000); // the load is pending and the bound is not reached
    let disabled = false;
    const disabling = app.plugins.disable('fixture.hung2').then(() => void (disabled = true));
    await ticks();
    expect(disabled).toBe(false); // it waits for the pending activation
    await app.advance(10_000 + 10_000 + 1_000); // loadTimeoutMs + activateTimeoutMs + 1 s
    await ticks();
    await disabling;
    expect(disabled).toBe(true);
    expect(app.plugins.status('fixture.hung2')?.state).toBe('disabled');
    await activation;
    errors.drain();
    errors.dispose();
  });
});

describe('declared-interceptor-never-activates: a plugin that only declares a guard is activated by what it guards', () => {
  it('the guard-only plugin activates on onCommand:owner.danger and blocks the command before its handler runs', async () => {
    const owner = describePlugin(manifest('fixture.owner', { activationEvents: ['*'], contributes: { commands: [{ id: 'owner.danger', title: 'Danger' }] } }), 'builtin');
    const guard = describePlugin(
      manifest('fixture.guard', { capabilities: ['interceptors.guard'], contributes: { interceptors: [{ id: 'block', kinds: ['command'], match: 'owner.danger', mode: 'guard' }] } }),
      'builtin',
    );
    const ran: string[] = [];
    const app = await createTestApp({
      plugins: [owner, guard],
      modules: {
        [owner.location]: { activate: (c: PluginContext) => void c.api.commands.registerHandler('owner.danger', { run: () => void ran.push('danger') }) },
        [guard.location]: {
          activate: (c: PluginContext) =>
            void c.interceptors.register('block', () => {
              throw Object.assign(new Error('blocked by guard'), { code: 'guard.blocked' });
            }),
        },
      },
    });
    expect(app.plugins.status('fixture.guard')?.state).toBe('resolved'); // declared, not active yet
    const errors = captureErrors();
    await expect(app.commands.execute('owner.danger')).rejects.toMatchObject({ message: expect.stringContaining('blocked') });
    expect(ran).toEqual([]);
    expect(app.plugins.status('fixture.guard')?.state).toBe('active');
    errors.drain();
    errors.dispose();
  });
});

describe('context-key-prefix-overlaps-plugin-ids: the longest installed plugin id that is a prefix owns the key', () => {
  it('acme.git cannot write acme.git.hub.x, acme.git.hub can, and both can write their own keys', async () => {
    const git = describePlugin(manifest('acme.git', { activationEvents: ['*'] }), 'builtin');
    const hub = describePlugin(manifest('acme.git.hub', { activationEvents: ['*'] }), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const modules = Object.fromEntries([git, hub].map((d) => [d.location, { activate: (c: PluginContext) => void (ctxs[d.manifest.id] = c) }]));
    const app = await createTestApp({ plugins: [git, hub], modules });
    expect(() => ctxs['acme.git']?.api.context.set('acme.git.own', true)).not.toThrow();
    expect(() => ctxs['acme.git']?.api.context.set('acme.git.hub.open', true)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    expect(() => ctxs['acme.git.hub']?.api.context.set('acme.git.hub.open', true)).not.toThrow();
    expect(app.contextKeys.root.getValue('acme.git.hub.open')).toBe(true);
  });
});

describe('update-enable-do-not-reactivate-dependents: disable then enable and an update bring provider and consumer back', () => {
  const provider = (version = '1.0.0') => describePlugin(manifest('fixture.prov', { version, provides: ['fixture.prov/Svc'], contributes: { commands: [{ id: 'prov.run', title: 'Prov' }] } }), 'builtin');
  const consumer = describePlugin(manifest('fixture.cons', { requires: ['fixture.prov/Svc'], contributes: { commands: [{ id: 'cons.run', title: 'Cons' }] } }), 'builtin');
  const svc = token<object>('fixture.prov/Svc');
  const modules = (prov: ReturnType<typeof provider>) => ({
    [prov.location]: { activate: (c: PluginContext) => void (c.services.provide(svc, () => ({})), c.api.commands.registerHandler('prov.run', { run: () => 'p' })) },
    [consumer.location]: { activate: (c: PluginContext) => void (c.services.get(svc), c.api.commands.registerHandler('cons.run', { run: () => 'c' })) },
  });

  it('disable then enable of the provider activates the provider and then the consumer again', async () => {
    const prov = provider();
    const app = await createTestApp({ plugins: [prov, consumer], modules: modules(prov) });
    await app.commands.execute('cons.run'); // the onCommand event activates the consumer and, through the dependency, the provider
    expect(app.plugins.status('fixture.cons')?.state).toBe('active');
    await app.plugins.disable('fixture.prov');
    expect(app.plugins.status('fixture.cons')?.state).not.toBe('active');
    await app.plugins.enable('fixture.prov');
    expect(app.plugins.status('fixture.prov')?.state).toBe('active');
    expect(app.plugins.status('fixture.cons')?.state).toBe('active');
  });

  it('an update of the provider (a new version from the catalog) activates both again', async () => {
    const prov = provider();
    const app = await createTestApp({ plugins: [prov, consumer], modules: modules(prov) });
    await app.commands.execute('cons.run');
    const next = provider('1.1.0');
    app.catalog.replace(next);
    await ticks(200);
    await app.settle();
    expect(app.plugins.status('fixture.prov')).toMatchObject({ version: '1.1.0', state: 'active' });
    expect(app.plugins.status('fixture.cons')?.state).toBe('active');
  });
});

describe('no-confirm-input-progress-ui-for-plugins: dialogs reach undo, guards and plugins', () => {
  it('confirmBeforeUndo asks the DialogService: "no" keeps the entry, "yes" undoes it', async () => {
    const app = await createTestApp({ plugins: [] });
    const undone: string[] = [];
    app.get(UndoService).push({ label: 'Delete file', code: 'x.delete', resource: 'doc', confirmBeforeUndo: true, undo: () => void undone.push('undo'), redo: () => undefined });
    const dialogs = app.get(DialogService);
    const first = app.get(UndoService).undo('doc');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(dialogs.pending.peek()[0]).toMatchObject({ kind: 'confirm', confirmLabel: 'Undo' });
    dialogs.pending.peek()[0]?.cancel();
    expect(await first).toBe(false);
    expect(undone).toEqual([]);
    expect(app.get(UndoService).canUndo('doc').peek()).toBe(true); // the entry stays
    const second = app.get(UndoService).undo('doc');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    dialogs.pending.peek()[0]?.accept();
    expect(await second).toBe(true);
    expect(undone).toEqual(['undo']);
  });

  it('an interactive guard of a plugin blocks the command on "no" and lets it run on "yes"', async () => {
    const owner = describePlugin(manifest('fixture.owner', { activationEvents: ['*'], contributes: { commands: [{ id: 'owner.wipe', title: 'Wipe' }] } }), 'builtin');
    const guard = describePlugin(
      manifest('fixture.askguard', { activationEvents: ['*'], capabilities: ['interceptors.guard'], contributes: { interceptors: [{ id: 'ask', kinds: ['command'], match: 'owner.wipe', mode: 'guard', interactive: true }] } }),
      'builtin',
    );
    const ran: string[] = [];
    const app = await createTestApp({
      plugins: [owner, guard],
      modules: {
        [owner.location]: { activate: (c: PluginContext) => void c.api.commands.registerHandler('owner.wipe', { run: () => void ran.push('wiped') }) },
        [guard.location]: {
          activate: (c: PluginContext) =>
            void c.interceptors.register('ask', async (ictx, next) => {
              if (!(await c.api.window.confirm({ message: 'Wipe everything?' }))) throw new Error('declined by the user');
              return next(ictx);
            }),
        },
      },
    });
    const dialogs = app.get(DialogService);
    const errors = captureErrors();
    const no = app.commands.execute('owner.wipe').then(() => 'ran', (e: unknown) => (e as Error).message);
    for (let i = 0; i < 40 && dialogs.pending.peek().length === 0; i++) await Promise.resolve();
    dialogs.pending.peek()[0]?.cancel();
    expect(await no).toContain('declined');
    expect(ran).toEqual([]);
    const yes = app.commands.execute('owner.wipe');
    for (let i = 0; i < 40 && dialogs.pending.peek().length === 0; i++) await Promise.resolve();
    dialogs.pending.peek()[0]?.accept();
    await yes;
    expect(ran).toEqual(['wiped']);
    errors.drain();
    errors.dispose();
  });

  it('the plugin API: input returns the value, withProgress returns the result and cancels with the plugin, and a dead context is refused', async () => {
    const p = describePlugin(manifest('fixture.dlg', { activationEvents: ['*'] }), 'builtin');
    const ctxs: Record<string, PluginContext> = {};
    const app = await createTestApp({ plugins: [p], modules: { [p.location]: { activate: (c: PluginContext) => void (ctxs['p'] = c) } } });
    const ctx = ctxs['p'] as PluginContext;
    const dialogs = app.get(DialogService);
    const answer = ctx.api.window.input({ prompt: 'Name?', value: 'x' });
    expect(dialogs.pending.peek()[0]).toMatchObject({ kind: 'input', message: 'Name?' });
    dialogs.pending.peek()[0]?.accept('abc');
    expect(await answer).toBe('abc');
    expect(await ctx.api.window.withProgress({ title: 'Work' }, async (progress) => (progress.report({ message: 'half', fraction: 0.5 }), 42))).toBe(42);
    // a progress task that waits for its signal ends when the plugin is disabled
    const waiting = ctx.api.window.withProgress({ title: 'Wait' }, (progress) => new Promise<string>((resolve) => progress.signal.addEventListener('abort', () => resolve('aborted'))));
    const pendingDialog = ctx.api.window.confirm({ message: 'Still there?' });
    await app.plugins.disable('fixture.dlg');
    expect(await waiting).toBe('aborted');
    expect(await pendingDialog).toBe(false); // the dialog closed with the plugin
    await expect(ctx.api.window.confirm({ message: 'late' })).rejects.toMatchObject({ code: 'plugin.deactivated' });
    await expect(ctx.api.window.withProgress({ title: 'late' }, async () => 1)).rejects.toMatchObject({ code: 'plugin.deactivated' });
  });
});

describe('command-declare-full-map-copy: a plugin with 50 commands publishes the declared map once', () => {
  it('one publication per plugin add, every command declared, and a duplicate id still becomes a problem', async () => {
    const { CommandRegistry } = await import('@tessera/contracts');
    const app = await createTestApp({ plugins: [describePlugin(manifest('first.p', { contributes: { commands: [{ id: 'dup.id', title: 'First' }] } }), 'builtin')] });
    const registry = app.get(CommandRegistry) as unknown as { publications: number; metadata(id: string): { owner: string } | undefined };
    const before = registry.publications;
    const commands = Array.from({ length: 50 }, (_, i) => ({ id: `bulk.c${i}`, title: `Command ${i}` }));
    await app.plugins.add([describePlugin(manifest('bulk.many', { contributes: { commands: [...commands, { id: 'dup.id', title: 'Second' }] } }), 'user')]);
    expect(registry.publications - before).toBe(1);
    expect(registry.metadata('bulk.c49')?.owner).toBe('bulk.many');
    expect(registry.metadata('dup.id')?.owner).toBe('first.p');
    expect((app.plugins.status('bulk.many')?.problems ?? []).join('\n')).toContain('already contributed by "first.p"');
  });
});

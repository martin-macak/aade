import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import {
  CoreTopics,
  NotificationService,
  StatusBarService,
  UndoService,
  ViewServicesPolicy,
  WorkbenchService,
  ConfigurationService,
  defineTopic,
  type CommandContext,
  type PluginContext,
  type PluginSource,
} from '@tessera/contracts';
import { captureErrors, createTestApp, describePlugin, manifest, type TestApp } from '@tessera/testing';

const denied = expect.objectContaining({ code: 'plugin.capabilityDenied' });
const note = defineTopic<{ n: number }>('fixture.note');

interface Boot {
  readonly app: TestApp;
  readonly ctx: PluginContext;
  readonly handlers: Record<string, CommandContext | undefined>;
}

/** One fixture plugin with a command, a declared setting, a view and a declared interceptor of each kind. */
async function boot(options: {
  readonly id?: string;
  readonly source?: PluginSource | string;
  readonly capabilities?: readonly string[];
  readonly interceptors?: ReadonlyArray<Record<string, unknown>>;
  readonly extra?: Record<string, unknown>;
  readonly activate?: (ctx: PluginContext, state: Boot['handlers']) => void;
  readonly more?: ReadonlyArray<{ readonly description: ReturnType<typeof describePlugin>; readonly module: unknown }>;
}): Promise<Boot> {
  const id = options.id ?? 'fixture.one';
  const handlers: Boot['handlers'] = {};
  const description = describePlugin(
    manifest(id, {
      ...(options.capabilities ? { capabilities: [...options.capabilities] } : {}),
      activationEvents: ['*'],
      contributes: {
        commands: [{ id: `${id}.run`, title: 'Run' }],
        views: [{ id: `${id}.view`, title: 'View', workspace: 'workbench.editorArea', visibleByDefault: false }],
        configuration: [{ key: `${id}.setting`, type: 'boolean', default: false }],
        ...(options.interceptors ? { interceptors: [...options.interceptors] } : {}),
        ...options.extra,
      },
    } as never),
    options.source as PluginSource | undefined,
  );
  let ctx: PluginContext | undefined;
  const app = await createTestApp({
    plugins: [description, ...(options.more ?? []).map((m) => m.description)],
    modules: {
      [description.location]: {
        activate(c: PluginContext) {
          ctx = c;
          c.api.commands.registerHandler(`${id}.run`, { run: (args: unknown, command: CommandContext) => void (handlers[`${id}.run`] = command, args) });
          options.activate?.(c, handlers);
        },
      },
      ...Object.fromEntries((options.more ?? []).map((m) => [m.description.location, m.module])),
    },
  });
  await app.settle();
  return { app, ctx: ctx as PluginContext, handlers };
}

describe('round 2: plugin interceptors cannot rewrite invocation data', () => {
  it('C18: an observer interceptor with no capability cannot write ctx.data.args; the handler receives the original', async () => {
    const outcomes: string[] = [];
    let received: unknown;
    const { app } = await boot({
      interceptors: [{ id: 'spy', kinds: ['command'], match: 'fixture.one.run', mode: 'observer' }],
      activate: (c) => {
        c.interceptors.register('spy', async (ictx, next) => {
          const args = (ictx.data as { args: { n: number; list: number[] } }).args;
          for (const attempt of [() => (args.n = 99), () => args.list.push(1)]) {
            try {
              attempt();
              outcomes.push('wrote');
            } catch (error) {
              outcomes.push((error as { code?: string }).code ?? 'other');
            }
          }
          return next();
        });
        c.api.commands.registerHandler('fixture.one.run', { run: (args: unknown) => void (received = args) });
      },
    });
    const errors = captureErrors();
    const args = { n: 1, list: [0] };
    await app.commands.execute('fixture.one.run', args);
    errors.drain();
    errors.dispose();
    expect(outcomes).toEqual(['interceptor.readOnly', 'interceptor.readOnly']);
    expect(received).toBe(args);
    expect(args).toEqual({ n: 1, list: [0] });
  });

  it('C18: observing service, persistence, ipc or activation needs interceptors.observe; a user plugin cannot hold it; commands and events need none', async () => {
    const attempt = (c: PluginContext, id: string): string | undefined => {
      try {
        c.interceptors.register(id, async (_i, next) => next());
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    const kinds = ['service', 'persistence', 'ipc', 'activation'] as const;
    const declared = [...kinds.map((kind) => ({ id: `obs-${kind}`, kinds: [kind], mode: 'observer' })), { id: 'obs-command', kinds: ['command'], mode: 'observer' }];
    const results: Record<string, string | undefined> = {};
    // 1. a user plugin that asks for the capability: refused by the default policy
    const user = await boot({ source: 'user', capabilities: ['interceptors.observe'], interceptors: declared, activate: (c) => declared.forEach((d) => (results[`user:${d.id}`] = attempt(c, d.id))) });
    for (const kind of kinds) expect(results[`user:obs-${kind}`]).toBe('plugin.capabilityDenied');
    expect(results['user:obs-command']).toBeUndefined();
    expect(user.app.plugins.status('fixture.one')?.problems.join(' ')).toContain('interceptors.observe');
    await user.app.dispose();
    // 2. a builtin plugin without the capability: refused; with it: allowed
    const plain = await boot({ source: 'builtin', interceptors: declared, activate: (c) => declared.forEach((d) => (results[`builtin:${d.id}`] = attempt(c, d.id))) });
    for (const kind of kinds) expect(results[`builtin:obs-${kind}`]).toBe('plugin.capabilityDenied');
    await plain.app.dispose();
    const allowed = await boot({ source: 'builtin', capabilities: ['interceptors.observe'], interceptors: declared, activate: (c) => declared.forEach((d) => (results[`cap:${d.id}`] = attempt(c, d.id))) });
    for (const d of declared) expect(results[`cap:${d.id}`]).toBeUndefined();
    await allowed.app.dispose();
  });
});

describe('round 2: one ownership rule for write doors', () => {
  it('C29: a plugin cannot publish to a tessera.* topic; its own publications carry EventMeta.publisher', async () => {
    const seen: Array<{ publisher: string | undefined; n: number }> = [];
    const { ctx } = await boot({
      activate: (c) => {
        c.api.events.subscribe(note, (payload, meta) => void seen.push({ publisher: meta.publisher, n: payload.n }));
      },
    });
    expect(() => ctx.api.events.publish(CoreTopics.lifecyclePhase, { phase: 0 } as never)).toThrowError(denied);
    expect(() => ctx.workItems.root.events.publish(CoreTopics.pluginState, { pluginId: 'x', state: 'active' } as never)).toThrowError(denied);
    ctx.api.events.publish(note, { n: 1 });
    ctx.workItems.root.events.publish(note, { n: 2 });
    expect(seen).toEqual([
      { publisher: 'fixture.one', n: 1 },
      { publisher: 'fixture.one', n: 2 },
    ]);
  });

  it('C29: force close and move of a foreign placement, resetLayout and setPartVisible need workbench.layout; own placements do not', async () => {
    const otherPlugin = describePlugin(
      manifest('fixture.two', { activationEvents: ['*'], contributes: { views: [{ id: 'fixture.two.view', title: 'Two', workspace: 'workbench.editorArea', visibleByDefault: false }] } } as never),
      'builtin',
    );
    const provider = (viewType: string) => ({
      viewType,
      createViewModel: () => ({}),
      createPresenter: () => ({ viewState: { get: () => 0, peek: () => 0, subscribe: () => ({ dispose: () => undefined }), name: undefined } as never, intents: {}, dispose: () => undefined }),
    });
    for (const withCapability of [false, true]) {
      const { app, ctx } = await boot({
        source: 'builtin',
        capabilities: withCapability ? ['workbench.layout'] : [],
        activate: (c) => c.views.registerProvider(provider('fixture.one.view') as never),
        more: [{ description: otherPlugin, module: { activate: (c: PluginContext) => c.views.registerProvider(provider('fixture.two.view') as never) } }],
      });
      const workbench = ctx.services.get(WorkbenchService);
      const own = await app.workbench.showView('fixture.one.view');
      const foreign = await app.workbench.showView('fixture.two.view', { workspace: 'workbench.editorArea' });
      const windowId = Object.keys(app.workbench.state.peek().windows)[0] as never;
      if (!withCapability) {
        expect(() => workbench.close(foreign.id, { force: true })).toThrowError(denied);
        expect(() => workbench.move(foreign.id, { workspace: 'workbench.editorArea' } as never)).toThrowError(denied);
        expect(() => workbench.resetLayout()).toThrowError(denied);
        expect(() => workbench.setPartVisible(windowId, 'panel' as never, true)).toThrowError(denied);
        expect(await workbench.close(own.id, { force: true })).toBe(true); // its own placement: open
      } else {
        expect(await workbench.close(foreign.id, { force: true })).toBe(true);
        await workbench.resetLayout();
      }
      await app.dispose();
    }
  });

  it('C29: ConfigurationService.update writes the plugin’s own declared keys; a foreign key needs configuration.writeForeign', async () => {
    const plain = await boot({ source: 'builtin', capabilities: [] });
    const config = plain.ctx.services.get(ConfigurationService);
    config.update('fixture.one.setting', true);
    expect(config.get('fixture.one.setting')).toBe(true);
    expect(() => config.update('fixture.other.setting', true)).toThrowError(denied);
    await plain.app.dispose();
    const wide = await boot({ source: 'builtin', capabilities: ['configuration.writeForeign'] });
    const wideConfig = wide.ctx.services.get(ConfigurationService);
    expect(() => wideConfig.update('fixture.one.setting', false)).not.toThrow();
    await wide.app.dispose();
  });

  it('C29: notifications through the facade carry the plugin id as source, whatever the plugin passes', async () => {
    const { app, ctx } = await boot({});
    ctx.services.get(NotificationService).notify({ message: 'hello', severity: 'info', source: 'core' } as never);
    const active = app.get(NotificationService).active.peek();
    expect(active.find((n) => n.message === 'hello')?.source).toBe('fixture.one');
  });

  it('C29: undo.clear removes only the plugin’s own entries on a resource', async () => {
    const other = describePlugin(manifest('fixture.two', { activationEvents: ['*'] }), 'builtin');
    let secondCtx: PluginContext | undefined;
    const { app, ctx } = await boot({ source: 'builtin', more: [{ description: other, module: { activate: (c: PluginContext) => void (secondCtx = c) } }] });
    const entry = (code: string) => ({ label: code, code, resource: 'doc:1', undo: () => undefined, redo: () => undefined });
    ctx.services.get(UndoService).push(entry('mine'));
    (secondCtx as PluginContext).services.get(UndoService).push(entry('theirs'));
    ctx.services.get(UndoService).clear('doc:1');
    const undo = app.get(UndoService);
    expect(undo.canUndo('doc:1').peek()).toBe(true);
    await undo.undo('doc:1');
    expect(undo.canUndo('doc:1').peek()).toBe(false);
  });
});

describe('round 2: fail closed', () => {
  it('C29: the default policy grants only builtin and dev; an unknown source is an invalid plugin', async () => {
    for (const source of ['builtin', 'dev'] as const) {
      const ok = await boot({ source, capabilities: ['interceptors.guard'] });
      expect(ok.app.plugins.status('fixture.one')?.problems.join(' ')).not.toContain('not granted');
      await ok.app.dispose();
    }
    const user = await boot({ source: 'user', capabilities: ['interceptors.guard'] });
    expect(user.app.plugins.status('fixture.one')?.problems.join(' ')).toContain('not granted');
    await user.app.dispose();
    const typo = await boot({ source: 'usr', capabilities: ['interceptors.guard'] });
    expect(typo.app.plugins.status('fixture.one')?.state).toBe('invalid');
    expect(typo.app.plugins.status('fixture.one')?.problems.join(' ')).toContain('unknown plugin source');
    await typo.app.dispose();
  });

  it('C29: the view door gives a dead context facade (reads work, writes throw plugin.deactivated) for an installed plugin without a runtime', async () => {
    const { app } = await boot({ source: 'builtin' });
    await app.plugins.deactivate('fixture.one');
    const scope = app.workItems.root.context.createChild('view-door');
    scope.set('anything', 1);
    const dead = app.get(ViewServicesPolicy).contextFor('fixture.one', scope);
    expect(dead.getValue('anything')).toBe(1);
    expect(() => dead.set('x', 1)).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    expect(() => dead.createKey('y', 1)).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    expect(() => dead.createChild('z')).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    expect(() => dead.dispose()).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    expect(dead).not.toBe(scope);
    scope.dispose();
  });
});

describe('round 2: owner-bound command cancellation', () => {
  it('C14: a never-ending plugin command ends as cancelled when its plugin deactivates, and its signal aborts', async () => {
    const never = new DeferredPromise<void>();
    let signal: AbortSignal | undefined;
    const { app } = await boot({
      source: 'builtin',
      activate: (c) =>
        c.api.commands.registerHandler('fixture.one.run', {
          run: (_args: unknown, command: CommandContext) => {
            signal = command.signal;
            return never.promise;
          },
        }),
    });
    const running = app.commands.execute('fixture.one.run').then(() => 'resolved', (e: unknown) => (e as { code?: string }).code);
    await app.settle();
    expect(signal?.aborted).toBe(false);
    await app.plugins.deactivate('fixture.one');
    expect(signal?.aborted).toBe(true);
    expect(await running).toBe('cancelled');
    never.resolve();
  });
});

describe('round 2: plugin guards have a default ceiling', () => {
  const guardManifest = (interactive: boolean) => [{ id: 'slow', kinds: ['command'], match: 'fixture.one.run', mode: 'guard', ...(interactive ? { interactive: true } : {}) }];

  it('C18: a guard that never decides fails the command after 30 s (interceptor.guardTimeout) and is reported as slow at 5 s', async () => {
    const { app } = await boot({
      source: 'builtin',
      capabilities: ['interceptors.guard'],
      interceptors: guardManifest(false),
      activate: (c) => c.interceptors.register('slow', () => new Promise<never>(() => undefined)),
    });
    const errors = captureErrors();
    const running = app.commands.execute('fixture.one.run').then(() => 'ran', (e: unknown) => (e as { code?: string; message?: string }).code);
    await app.settle();
    app.scheduler.advance(5000);
    await app.settle();
    expect(errors.drain().map((r) => (r.error as { code?: string }).code)).toEqual(['interceptor.slowGuard']);
    app.scheduler.advance(25_000);
    expect(await running).toBe('interceptor.guardTimeout');
    errors.drain();
    errors.dispose();
  });

  it('C18: an interactive guard (a confirm dialog) waits as long as the user does', async () => {
    const answer = new DeferredPromise<boolean>();
    const { app } = await boot({
      source: 'builtin',
      capabilities: ['interceptors.guard'],
      interceptors: guardManifest(true),
      activate: (c) => c.interceptors.register('slow', async (_ictx, next) => ((await answer.promise) ? next() : false)),
    });
    let done = false;
    const running = app.commands.execute('fixture.one.run').then(() => (done = true));
    app.scheduler.advance(120_000);
    await app.settle();
    expect(done).toBe(false);
    answer.resolve(true);
    await running;
    expect(done).toBe(true);
  });
});

describe('round 2: a status bar contribution with a bad `when`', () => {
  it('C17: the entry is dropped with a plugin problem; the other entries of the plugin are applied', async () => {
    const errors = captureErrors();
    const { app } = await boot({
      source: 'builtin',
      extra: {
        statusBar: [
          { id: 'fixture.one.good', alignment: 'left', text: 'good' },
          { id: 'fixture.one.bad', alignment: 'left', text: 'bad', when: 'a &&' },
        ],
      },
    });
    const status = app.plugins.status('fixture.one');
    expect(status?.problems.join(' ')).toContain('plugin.invalidContribution');
    const items = app.get(StatusBarService).items(app.workItems.root.context).peek();
    expect(items.left.map((i) => i.id)).toEqual(['fixture.one.good']);
    errors.drain();
    errors.dispose();
  });
});

describe('round 2: registrations that a plugin disposes leave its store', () => {
  it('B15: 10,000 subscribe and dispose cycles through the context leave the plugin store and the live report empty', async () => {
    const { app, ctx } = await boot({ source: 'builtin' });
    const before = ctx.subscriptions.size;
    for (let i = 0; i < 10_000; i++) ctx.api.events.subscribe(note, () => undefined).dispose();
    expect(ctx.subscriptions.size).toBe(before);
    expect((app.plugins as unknown as { liveDisposables(id: string): readonly string[] }).liveDisposables('fixture.one').filter((entry) => entry.startsWith('subscription:'))).toEqual([]);
  });
});

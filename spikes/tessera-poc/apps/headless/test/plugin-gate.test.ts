import { describe, expect, it } from 'vitest';
import { token, inject, injectScope } from '@tessera/di';
import {
  CommandService,
  ConfigurationService,
  ContextKeyService,
  EventBus,
  InterceptorRegistry,
  NotificationService,
  PublicTokens,
  StatusBarService,
  StorageService,
  UndoService,
  ViewRegistry,
  ViewServicesPolicy,
  WorkItemService,
  WorkbenchService,
  WorkspaceKind,
  defineTopic,
  type CommandContext,
  type PluginContext,
  type PluginWorkItem,
  type ViewProvider,
} from '@tessera/contracts';
import { reactiveDebug, state } from '@tessera/reactive';
import { captureErrors, describePlugin, manifest, type TestApp } from '@tessera/testing';
import { REGISTERING_MEMBERS, type DefaultPluginManager } from '@tessera/plugins';
import { createViewContext } from '@tessera/dom';
import { createDemoApp } from '@tessera-poc/headless';

// Tokens compare by id: a plugin can rebuild any token from its string id. The gate must not care.
const RebuiltInterceptors = token<unknown>(InterceptorRegistry.id);
const Thing = token<{ readonly n: number }>('fixture.gate/Thing');
const denied = expect.objectContaining({ code: 'plugin.capabilityDenied' });

interface Probe {
  ctx?: PluginContext;
  command?: CommandContext;
}

/** A fixture plugin with a command, a view type and a provided service. `extra` adjusts the manifest, `setup` runs in activate(). */
async function fixture(options: { readonly capabilities?: readonly string[]; readonly setup?: (ctx: PluginContext, probe: Probe) => void }) {
  const probe: Probe = {};
  const description = describePlugin(
    manifest('fixture.gate', {
      provides: ['fixture.gate/Thing'],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      contributes: {
        commands: [
          { id: 'fixture.gate.probe', title: 'Probe' },
          { id: 'fixture.gate.off', title: 'Off', enablement: 'never' },
        ],
        views: [{ id: 'fixture.gate.view', title: 'Gate', workspace: 'workbench.editorArea', visibleByDefault: false }],
        configuration: [{ key: 'fixture.gate.setting', type: 'boolean', default: false }],
      },
    }),
    'builtin',
  );
  const app = await createDemoApp({
    only: [],
    extraPlugins: [description],
    extraModules: {
      [description.location]: {
        activate(ctx: PluginContext) {
          probe.ctx = ctx;
          ctx.api.commands.registerHandler('fixture.gate.probe', { run: (_a: unknown, command: CommandContext) => void (probe.command = command) });
          ctx.api.commands.registerHandler('fixture.gate.off', { run: () => 'ran' });
          options.setup?.(ctx, probe);
        },
      },
    },
  });
  await app.plugins.activate('fixture.gate');
  return { app, probe, ctx: probe.ctx as PluginContext };
}

describe('C29: a plugin cannot reach an undeclared service by the four doors (ctx.services, inject in factories, CommandContext.services, CommandContext.execute)', () => {
  it('C29: ctx.services has no scope, and a token rebuilt from an id is refused like the original', async () => {
    const { ctx } = await fixture({});
    expect('scope' in ctx.services).toBe(false);
    expect(() => ctx.services.get(RebuiltInterceptors)).toThrowError(denied);
    expect(() => ctx.services.getOptional(token(StorageService.id))).toThrowError(denied);
  });

  it('C29: inject() in createViewModel and createPresenter follows the manifest; injectScope() is refused', async () => {
    const results: Record<string, unknown> = {};
    const attempt = (name: string, fn: () => unknown): void => {
      try {
        results[name] = fn();
      } catch (error) {
        results[name] = error;
      }
    };
    const { app } = await fixture({
      setup(ctx) {
        const provider: ViewProvider = {
          viewType: 'fixture.gate.view',
          createViewModel: () => {
            attempt('vm.undeclared', () => inject(StorageService));
            attempt('vm.rebuilt', () => inject(RebuiltInterceptors));
            attempt('vm.scope', () => injectScope());
            attempt('vm.public', () => inject(CommandService));
            attempt('vm.provided', () => inject(Thing, { optional: true }));
            return {};
          },
          createPresenter: () => {
            attempt('presenter.undeclared', () => inject(StorageService));
            return { viewState: { get: () => 0 } as never, intents: {}, dispose: () => undefined } as never;
          },
        };
        ctx.views.registerProvider(provider);
      },
    });
    const registered = app.get(ViewRegistry).provider('fixture.gate.view') as ViewProvider;
    app.window.run(() => registered.createViewModel?.({} as never));
    expect(results['vm.undeclared']).toMatchObject({ code: 'plugin.capabilityDenied' });
    expect(results['vm.rebuilt']).toMatchObject({ code: 'plugin.capabilityDenied' });
    expect(results['vm.scope']).toMatchObject({ code: 'di.filtered' });
    expect(results['vm.public']).toBeDefined(); // a public token needs no declaration
    expect(results['vm.provided']).toBeUndefined(); // declared in provides: allowed (optional, nobody provides it yet)
    app.window.run(() => registered.createPresenter({} as never));
    expect(results['presenter.undeclared']).toMatchObject({ code: 'plugin.capabilityDenied' });
    // outside the plugin's factory the same inject() works for core code: the filter ends with the factory
    expect(app.window.run(() => inject(StorageService))).toBeDefined();
  });

  it('C29: a factory of a provided service obeys the same rule when the container runs it', async () => {
    const { app, ctx } = await fixture({});
    ctx.services.provide(Thing, () => {
      inject(StorageService);
      return { n: 1 };
    });
    expect(() => app.window.get(Thing)).toThrowError(denied);
    await app.dispose(); // one live Application per realm (shell.secondApplication)
    const good = await fixture({ setup: () => undefined });
    good.ctx.services.provide(Thing, () => ({ n: inject(CommandService) ? 2 : 0 }));
    expect(good.app.window.get(Thing).n).toBe(2);
  });

  it('C29: CommandContext.services is a gated reader without container methods', async () => {
    const { app, probe } = await fixture({});
    await app.commands.execute('fixture.gate.probe');
    const services = (probe.command as CommandContext).services;
    expect(() => services.get(RebuiltInterceptors)).toThrowError(denied);
    expect(() => services.get(StorageService, { optional: true })).toThrowError(denied);
    expect(services.get(CommandService)).toBeDefined();
    expect(services.has(RebuiltInterceptors)).toBe(false); // has() does not throw and does not reveal an undeclared token
    expect(services.has(CommandService)).toBe(true);
    expect('provide' in services).toBe(false);
    expect('createChild' in services).toBe(false);
  });
});

describe('C29: commands.force needs the capability commands.force', () => {
  const forced = { force: true, source: 'api' } as const;

  it('C29: without the capability, force is refused through the service, a factory, and a nested execute', async () => {
    let injected: CommandService | undefined;
    const { app, ctx, probe } = await fixture({
      setup(c) {
        c.views.registerProvider({
          viewType: 'fixture.gate.view',
          createViewModel: () => {
            injected = inject(CommandService);
            return {};
          },
          createPresenter: () => ({}) as never,
        });
      },
    });
    const errors = captureErrors();
    await expect(ctx.services.get(CommandService).execute('fixture.gate.off', undefined, forced)).rejects.toMatchObject({ code: 'plugin.capabilityDenied' });
    app.window.run(() => (app.get(ViewRegistry).provider('fixture.gate.view') as ViewProvider).createViewModel?.({} as never));
    await expect(injected?.execute('fixture.gate.off', undefined, forced)).rejects.toMatchObject({ code: 'plugin.capabilityDenied' });
    await app.commands.execute('fixture.gate.probe');
    await expect((probe.command as CommandContext).execute('fixture.gate.off', undefined, { force: true })).rejects.toMatchObject({ code: 'plugin.capabilityDenied' });
    await expect(ctx.services.get(CommandService).execute('fixture.gate.off')).rejects.toMatchObject({ code: 'command.disabled' }); // a plain call is still disabled
    errors.drain();
    errors.dispose();
  });

  it('C29: with the capability, force skips enablement; the audit is a log record, not an error report', async () => {
    const { app, ctx, probe } = await fixture({ capabilities: ['commands.force'] });
    const errors = captureErrors();
    await expect(ctx.services.get(CommandService).execute('fixture.gate.off', undefined, forced)).resolves.toBe('ran');
    await app.commands.execute('fixture.gate.probe');
    await expect((probe.command as CommandContext).execute('fixture.gate.off', undefined, { force: true })).resolves.toBe('ran');
    expect(errors.drain()).toEqual([]);
    errors.dispose();
    expect(app.logs.filter((r) => r.message.includes('executed with force') && r.message.includes('fixture.gate.off')).length).toBeGreaterThanOrEqual(2);
  });

  it('C29: core code keeps force (the host, tests and the RPC layer are not plugins)', async () => {
    const { app } = await fixture({});
    await expect(app.commands.execute('fixture.gate.off', undefined, forced)).resolves.toBe('ran');
  });
});

const fakeUndo = (resource: string, ran: string[]) => ({ label: 'x', code: 'x', resource, undo: () => void ran.push('undo'), redo: () => undefined });

describe('C29: no WorkItem, placement or view instance carries a DI scope to a plugin', () => {
  it('C29: ctx.workItems.root and its children have no scope; a raw scope.get() door does not exist', async () => {
    const { ctx } = await fixture({});
    const root = ctx.workItems.root;
    expect('scope' in root).toBe(false);
    expect((root as unknown as { scope?: unknown }).scope).toBeUndefined();
    const child = root.createChild('gate-child');
    expect('scope' in child).toBe(false);
    expect(child.parent).toBe(root); // the same facade object for the same WorkItem
    expect((child.parent as unknown as { scope?: unknown }).scope).toBeUndefined();
    expect(root.children.peek().every((c) => !('scope' in c))).toBe(true);
  });

  it('C29: WorkItemService and WorkbenchService hand out WorkItems, placements and instances without scope', async () => {
    const { app, ctx } = await fixture({
      setup(c) {
        c.views.registerProvider({
          viewType: 'fixture.gate.view',
          createViewModel: () => ({}),
          createPresenter: () => ({ viewState: { get: () => 0, peek: () => 0, subscribe: () => ({ dispose() {} }) } as never, intents: {}, dispose: () => undefined }),
        });
      },
    });
    const items = ctx.services.get(WorkItemService);
    expect('scope' in items.root).toBe(false);
    expect(items.find('root')).toBe(items.root);
    expect('scope' in (items.active.peek() as object)).toBe(false);
    let seen: object | undefined;
    items.onDidCreate((w) => void (seen = w));
    ctx.workItems.create('gate-seen');
    expect(seen).toBeDefined();
    expect('scope' in (seen as object)).toBe(false);

    const ref = await app.workbench.showView('fixture.gate.view');
    const workbench = ctx.services.get(WorkbenchService);
    const placement = workbench.placement(ref.id);
    const instance = workbench.instance(ref.instanceId);
    expect(placement).toBeDefined();
    expect(instance).toBeDefined();
    expect(placement?.scope).toBeUndefined();
    expect(instance?.scope).toBeUndefined();
    expect('scope' in (placement as object)).toBe(false);
    expect((placement as unknown as { ownerOverride?: unknown }).ownerOverride).toBeUndefined(); // no implementation internals either
    expect(placement?.status.peek()).toBeDefined(); // the public members still work
    expect(instance?.refCount).toBeGreaterThan(0);
    expect(app.workbench.placement(ref.id)?.scope).toBeDefined(); // core code keeps it
  });

  it('C29: ViewModelContext.workItem and PresenterContext.workItem are facades without scope', async () => {
    const seen: Record<string, object | undefined> = {};
    const { app } = await fixture({
      setup(ctx) {
        ctx.views.registerProvider({
          viewType: 'fixture.gate.view',
          createViewModel: (vm) => {
            seen['vm'] = vm.workItem;
            return {};
          },
          createPresenter: (p) => {
            seen['presenter'] = p.workItem;
            return { viewState: { get: () => 0 } as never, intents: {}, dispose: () => undefined } as never;
          },
        });
      },
    });
    const registered = app.get(ViewRegistry).provider('fixture.gate.view') as ViewProvider;
    app.window.run(() => registered.createViewModel?.({ workItem: app.workItems.root } as never));
    app.window.run(() => registered.createPresenter({ workItem: app.workItems.root } as never));
    for (const name of ['vm', 'presenter']) {
      expect(seen[name]).toBeDefined();
      expect('scope' in (seen[name] as object)).toBe(false);
    }
    // core code keeps the real one
    expect('scope' in app.workItems.root).toBe(true);
  });

  it('C29: the services callback of createChild gets a registrar: only manifest provides, no get(), no scope', async () => {
    const { app, ctx } = await fixture({});
    const registrars: unknown[] = [];
    expect(() =>
      ctx.workItems.create('gate-reg', {
        services: (registrar) => {
          registrars.push(registrar);
          registrar.provide(Thing, () => ({ n: 3 })); // declared in provides: fine
          registrar.provideValue(token<unknown>(InterceptorRegistry.id), {}); // not declared
        },
      }),
    ).toThrowError(denied);
    expect(app.workItems.find('root/gate-reg')).toBeUndefined(); // nothing leaks when the callback throws
    const registrar = registrars[0] as object;
    expect('get' in registrar).toBe(false);
    expect('createChild' in registrar).toBe(false);
    const ok = ctx.workItems.create('gate-reg2', {
      services: (r) => void r.provide(Thing, () => ({ n: inject(CommandService) ? 4 : 0 })),
    });
    expect(app.workItems.find('root/gate-reg2')?.scope.get(Thing).n).toBe(4);
    expect(ok.owner).toBe('fixture.gate');
    // a factory provided this way obeys the manifest too
    const bad = ctx.workItems.create('gate-reg3', { services: (r) => void r.provide(Thing, () => ({ n: inject(StorageService) ? 1 : 0 })) });
    expect(bad).toBeDefined();
    expect(() => app.workItems.find('root/gate-reg3')?.scope.get(Thing)).toThrowError(denied);
  });

  it('C29: a controller runs under the injection filter and gets a facade', async () => {
    const { app, ctx } = await fixture({});
    const outcome: Record<string, unknown> = {};
    ctx.workItems.create('gate-ctl', {
      controller: {
        start(workItem: PluginWorkItem) {
          outcome['facade'] = 'scope' in workItem;
          try {
            inject(StorageService);
            outcome['inject'] = 'allowed';
          } catch (error) {
            outcome['inject'] = (error as { code?: string }).code;
          }
        },
      },
    });
    expect(outcome).toEqual({ facade: false, inject: 'plugin.capabilityDenied' });
    expect(app.workItems.find('root/gate-ctl')).toBeDefined();
  });

  it('C29: a plugin can show a view under its own WorkItem facade (ShowViewOptions.workItem resolves by path)', async () => {
    const { app, ctx } = await fixture({
      setup(c) {
        c.views.registerProvider({
          viewType: 'fixture.gate.view',
          createViewModel: () => ({}),
          createPresenter: () => ({ viewState: { get: () => 0, peek: () => 0, subscribe: () => ({ dispose() {} }) } as never, intents: {}, dispose: () => undefined }),
        });
      },
    });
    const item = ctx.workItems.create('gate-host');
    const ref = await ctx.services.get(WorkbenchService).showView('fixture.gate.view', { workItem: item, key: 'k' });
    expect(app.workbench.instance(ref.instanceId)?.workItemPath).toBe('root/gate-host');
    expect(app.workbench.instance(ref.instanceId)?.scope.parent).toBe(app.workItems.find('root/gate-host')?.scope);
  });

  it('C29: the plugin cannot forge the owner, terminate the root or a WorkItem of another owner, or invalidate foreign undo entries', async () => {
    const { app, ctx } = await fixture({});
    const forged = ctx.workItems.root.createChild('gate-forged', { owner: 'someone.else' } as never);
    expect(forged.owner).toBe('fixture.gate');
    await expect(ctx.workItems.root.terminate()).rejects.toMatchObject({ code: 'plugin.capabilityDenied' });
    const foreign = app.workItems.root.createChild('foreign', { owner: 'other.plugin' });
    await expect(ctx.services.get(WorkItemService).find('root/foreign')?.terminate()).rejects.toMatchObject({ code: 'plugin.capabilityDenied' });
    expect(foreign.status.peek()).not.toBe('terminated');
    expect(() => ctx.services.get(UndoService).invalidateOwner('other.plugin')).toThrowError(denied);
  });

  it('C29: the guard and force capabilities cannot be bypassed through a WorkItem (the round 2 door)', async () => {
    const { ctx } = await fixture({});
    // the old attack: root.scope.get(InterceptorRegistry).register({ mode: 'guard' }) and scope.get(CommandService).execute(..., { force: true })
    const scope = (ctx.workItems.root as unknown as { scope?: { get(t: unknown): unknown } }).scope;
    expect(scope).toBeUndefined();
    const viaToken = ctx.services.get(WorkItemService).root as unknown as { scope?: unknown };
    expect(viaToken.scope).toBeUndefined();
  });

  it('C30: an undo entry pushed through the UndoService token carries the owner and ends with the plugin', async () => {
    const { app, ctx } = await fixture({});
    const ran: string[] = [];
    ctx.services.get(UndoService).push(fakeUndo('gate-resource', ran), { owner: 'someone.else' });
    const undo = app.get(UndoService);
    expect(undo.canUndo('gate-resource').peek()).toBe(true);
    const held = ctx.services.get(UndoService);
    await app.plugins.deactivate('fixture.gate');
    expect(await undo.undo('gate-resource')).toBe(false);
    expect(ran).toEqual([]); // the closure over the dead plugin never runs
    expect(() => held.push(fakeUndo('gate-resource', ran))).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
  });

  it('C30: WorkItems made through root.createChild, the WorkItemService end with the plugin, and the plugin can come back', async () => {
    const { app, ctx, probe } = await fixture({});
    const held = ctx.workItems.root;
    ctx.workItems.root.createChild('own-a');
    ctx.services.get(WorkItemService).root.createChild('own-b').createChild('nested');
    expect(app.workItems.find('root/own-b/nested')).toBeDefined();
    await app.plugins.deactivate('fixture.gate');
    for (const path of ['root/own-a', 'root/own-b', 'root/own-b/nested']) expect(app.workItems.find(path)).toBeUndefined();
    expect(() => held.createChild('own-a')).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    await app.plugins.activate('fixture.gate');
    (probe.ctx as PluginContext).workItems.root.createChild('own-a'); // a fresh activation: no workItem.duplicate
    expect(app.workItems.find('root/own-a')).toBeDefined();
  });
});

describe('C29: an optional token is readable only when a plugin provides it (review round 3)', () => {
  it('C29: a plugin with optional [tessera.interceptors] cannot read the raw registry, by any door', async () => {
    const probe: Probe = {};
    const description = describePlugin(manifest('fixture.optcore', { optional: ['tessera.interceptors', 'tessera.eventBus', 'tessera.storage'], contributes: { commands: [{ id: 'fixture.optcore.probe', title: 'Probe' }] } }));
    const app = await createDemoApp({
      only: [],
      extraPlugins: [description],
      extraModules: {
        [description.location]: {
          activate(ctx: PluginContext) {
            probe.ctx = ctx;
            ctx.api.commands.registerHandler('fixture.optcore.probe', { run: (_a: unknown, command: CommandContext) => void (probe.command = command) });
          },
        },
      },
    });
    await app.plugins.activate('fixture.optcore');
    const ctx = probe.ctx as PluginContext;
    expect(() => ctx.services.get(RebuiltInterceptors)).toThrowError(denied);
    expect(() => ctx.services.getOptional(RebuiltInterceptors)).toThrowError(denied);
    expect(() => ctx.services.get(token(EventBus.id))).toThrowError(denied);
    await app.commands.execute('fixture.optcore.probe');
    const services = (probe.command as CommandContext).services;
    expect(() => services.get(RebuiltInterceptors)).toThrowError(denied);
    expect(services.has(RebuiltInterceptors)).toBe(false);
  });

  it('C29: a plugin-provided optional token is readable', async () => {
    const probe: Probe = {};
    const description = describePlugin(manifest('fixture.optplug', { optional: ['fixture.gate/Thing'] }));
    const provider = describePlugin(manifest('fixture.provider'));
    const app = await createDemoApp({ only: [], extraPlugins: [description, provider], extraModules: { [description.location]: { activate: (ctx: PluginContext) => void (probe.ctx = ctx) } } });
    app.window.provideValue(Thing, { n: 7 }, { owner: 'fixture.provider' });
    await app.plugins.activate('fixture.optplug');
    expect((probe.ctx as PluginContext).services.get(Thing).n).toBe(7);
  });
});

const topic = defineTopic<number>('fixture.gate.topic');
const rule = { id: 'fixture.gate.item', alignment: 'left', text: 'gate' } as const;

interface Registration {
  /** Member of a public service, as `token.member`. */
  readonly name: string;
  /** Registers through the service the plugin got. Returns a check of the effect. */
  readonly register: (ctx: PluginContext, hits: string[], app: TestApp) => { readonly alive: () => boolean };
}

/** One entry per registering member of a public token, plus the WorkItem doors. The walk below fails for a member that is missing here. */
const REGISTRATIONS: readonly Registration[] = [
  {
    name: `${StatusBarService.id}.add`,
    register: (ctx, _hits, app) => {
      ctx.services.get(StatusBarService).add(rule);
      return { alive: () => statusTexts(app).includes('gate') };
    },
  },
  {
    name: `${NotificationService.id}.notify`,
    register: (ctx, _hits, app) => {
      ctx.services.get(NotificationService).notify({ severity: 'info', message: 'gate-note' });
      return { alive: () => app.get(NotificationService).active.peek().some((n) => n.message === 'gate-note') };
    },
  },
  {
    name: `${WorkbenchService.id}.createWorkspace`,
    register: (ctx, _hits, app) => {
      ctx.services.get(WorkbenchService).createWorkspace({ id: 'fixture.gate.ws', kind: WorkspaceKind.Tabs, title: 'Gate', owner: 'someone.else' });
      return { alive: () => app.workbench.workspace('fixture.gate.ws') !== undefined };
    },
  },
  {
    name: `${CommandService.id}.onDidExecute`,
    register: (ctx, hits) => {
      ctx.services.get(CommandService).onDidExecute(() => void hits.push('command'));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: `${ConfigurationService.id}.onDidChange`,
    register: (ctx, hits) => {
      ctx.services.get(ConfigurationService).onDidChange(() => void hits.push('configuration'));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: `${WorkItemService.id}.onDidCreate`,
    register: (ctx, hits) => {
      ctx.services.get(WorkItemService).onDidCreate((w) => void hits.push(`created:${w.id}`));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: `${WorkItemService.id}.onDidTerminate`,
    register: (ctx, hits) => {
      ctx.services.get(WorkItemService).onDidTerminate((w) => void hits.push(`terminated:${w.id}`));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: `${ContextKeyService.id}.root.onDidChange`,
    register: (ctx, hits) => {
      ctx.services.get(ContextKeyService).root.onDidChange(() => void hits.push('context'));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: `${ContextKeyService.id}.root.set`,
    register: (ctx, _hits, app) => {
      ctx.services.get(ContextKeyService).root.set('fixture.gate.key', 1);
      return { alive: () => app.workItems.root.context.getValue('fixture.gate.key') === 1 };
    },
  },
  {
    name: 'PluginWorkItem.events.subscribe',
    register: (ctx, hits) => {
      ctx.workItems.root.events.subscribe(topic, () => void hits.push('subscribe'));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: 'PluginWorkItem.events.on',
    register: (ctx, hits) => {
      ctx.workItems.root.events.on(topic)(() => void hits.push('on'));
      return { alive: () => hits.length > 0 };
    },
  },
  {
    name: 'PluginWorkItem.context.set',
    register: (ctx, _hits, app) => {
      ctx.workItems.root.context.set('fixture.gate.rootkey', 'x');
      return { alive: () => app.workItems.root.context.getValue('fixture.gate.rootkey') === 'x' };
    },
  },
  {
    name: 'PluginWorkItem.context.createKey',
    register: (ctx, _hits, app) => {
      ctx.workItems.root.context.createKey('fixture.gate.created', true);
      return { alive: () => app.workItems.root.context.getValue('fixture.gate.created') === true };
    },
  },
  {
    name: 'PluginWorkItem.context.onDidChange',
    register: (ctx, hits) => {
      ctx.workItems.root.context.onDidChange(() => void hits.push('item-context'));
      return { alive: () => hits.length > 0 };
    },
  },
];

function statusTexts(app: TestApp): string[] {
  // the window root scope is the context the status bar evaluates against
  return app.get(StatusBarService).items(app.workItems.root.context).peek().left.map((i) => i.text);
}

/** Makes the registered effect fire: a command runs, a WorkItem is created and terminated, a key changes, a topic is published, a setting changes. */
async function fire(app: TestApp, suffix: string): Promise<void> {
  // a command would activate the plugin again, so only the first round runs one
  if (suffix === 'a') await app.commands.execute('fixture.gate.probe');
  app.contextKeys.root.set(`core.fire.app.${suffix}`, true);
  const item = app.workItems.root.createChild(`fire-${suffix}`, { owner: 'core.test' });
  await item.terminate();
  app.workItems.root.context.set(`core.fire.${suffix}`, true);
  app.get(EventBus).root.publish(topic, 1, { scope: 'global' });
  app.configuration.update('fixture.gate.setting', suffix === 'a');
}

describe('C30: registrations through public tokens and PluginWorkItem end with the plugin, whichever API made them (review round 3, ADR-010 rule 6, I22)', () => {
  it.each(REGISTRATIONS.map((r) => [r.name, r] as const))('C30: %s is disposed on deactivation and refused after it', async (_name, registration) => {
    const hits: string[] = [];
    const { app, ctx } = await fixture({});
    const manager = app.plugins as DefaultPluginManager;
    // what an abandoned activate() still holds after the cleanup: the service objects and the root facade it fetched earlier
    const services = new Map(PublicTokens.map((t) => [t.id, ctx.services.get(t)] as const));
    const root = ctx.workItems.root;
    const held = {
      services: { get: (t: { readonly id: string }) => services.get(t.id) },
      workItems: { root },
    } as unknown as PluginContext;
    const { alive } = registration.register(ctx, hits, app);
    expect(manager.liveDisposables('fixture.gate').length).toBeGreaterThan(0);
    await fire(app, 'a');
    expect(alive()).toBe(true);
    await app.plugins.deactivate('fixture.gate');
    expect(manager.liveDisposables('fixture.gate')).toEqual([]);
    hits.length = 0;
    await fire(app, 'b');
    expect(alive()).toBe(false); // the effect is gone: no handler runs, no item, notification, workspace or key is left
    // a late call of an abandoned activate() registers nothing and says why
    const late = hits.length;
    expect(() => registration.register(held, hits, app)).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    await fire(app, 'c');
    expect(hits.length).toBe(late);
    expect(manager.liveDisposables('fixture.gate')).toEqual([]);
  });

  it('C30: the registrations of a late call throw plugin.deactivated (services held from before)', async () => {
    const { app, ctx } = await fixture({});
    const bar = ctx.services.get(StatusBarService);
    const events = ctx.workItems.root.events;
    const scope = ctx.workItems.root.context;
    const config = ctx.services.get(ConfigurationService);
    await app.plugins.deactivate('fixture.gate');
    const late = expect.objectContaining({ code: 'plugin.deactivated' });
    expect(() => bar.add(rule)).toThrowError(late);
    expect(() => events.subscribe(topic, () => undefined)).toThrowError(late);
    expect(() => events.on(topic)(() => undefined)).toThrowError(late);
    expect(() => scope.set('fixture.gate.late', 1)).toThrowError(late);
    expect(() => scope.createKey('fixture.gate.late2', 1)).toThrowError(late);
    expect(() => config.onDidChange(() => undefined)).toThrowError(late);
    expect(() => ctx.workItems.root).toThrowError(late);
    expect(() => ctx.services.get(CommandService)).toThrowError(late);
    expect(app.workItems.root.context.getValue('fixture.gate.late')).toBeUndefined();
    expect((app.plugins as DefaultPluginManager).liveDisposables('fixture.gate')).toEqual([]);
    expect(statusTexts(app)).not.toContain('gate');
  });

  it('C30: keys set on a scope the plugin does not own follow the prefix rule and the context.global capability', async () => {
    const plain = await fixture({});
    const root = plain.ctx.workItems.root.context;
    root.set('fixture.gate.ok', 1);
    expect(() => root.set('other.key', 1)).toThrowError(denied);
    expect(() => root.createKey('other.key2', 1)).toThrowError(denied);
    expect(() => plain.ctx.services.get(ContextKeyService).root.set('other.key3', 1)).toThrowError(denied);
    const own = plain.ctx.workItems.create('gate-own');
    own.context.set('anything', 1); // the plugin owns this WorkItem: its scope ends with it
    expect(own.context.getValue('anything')).toBe(1);
    await plain.app.dispose(); // one live Application per realm (shell.secondApplication)
    const global = await fixture({ capabilities: ['context.global'] });
    global.ctx.workItems.root.context.set('other.key', 1);
    expect(global.app.workItems.root.context.getValue('other.key')).toBe(1);
    await global.app.plugins.deactivate('fixture.gate');
    expect(global.app.workItems.root.context.getValue('other.key')).toBeUndefined(); // reset with the plugin
  });

  it('C30: the walk over PublicTokens finds no registering member without an entry', async () => {
    const { app } = await fixture({});
    const registered = new Set(REGISTRATIONS.map((r) => r.name));
    // Members of the implementations that are no part of the contract (internal events and registrations of core code).
    const internal = new Set(['tessera.workbench.onDidActivateIn', 'tessera.workbench.addWorkspaceDef', 'tessera.workbench.registerCommands']);
    const candidate = /^(on[A-Z]|add|notify|create|register|subscribe)/;
    const missing: string[] = [];
    for (const t of PublicTokens) {
      const real = app.get(t as never) as object;
      const names = new Set<string>();
      for (let o: object | null = real; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
        for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor' && candidate.test(n)) names.add(n);
      }
      for (const n of names) {
        const name = `${t.id}.${n}`;
        if (!registered.has(name) && !internal.has(name)) missing.push(name);
      }
      // the table that the wrapper reads covers every member the test registers
      for (const n of REGISTERING_MEMBERS[t.id] ?? []) expect(names.has(n), `${t.id}.${n} exists`).toBe(true);
    }
    expect(missing).toEqual([]);
  });
});

describe('C29: PluginWorkItem.events and .context are facades without dispose or internals (review round 3)', () => {
  it('C29: no dispose, no bus, no createChild; activate and deactivate are limited to owned WorkItems', async () => {
    const { app, ctx } = await fixture({});
    const root = ctx.workItems.root;
    const events = root.events as unknown as Record<string, unknown>;
    const context = root.context as unknown as Record<string, unknown>;
    expect(events['dispose']).toBeUndefined();
    expect(events['bus']).toBeUndefined();
    expect(events['subscriptions']).toBeUndefined();
    expect(Object.keys(events).sort()).toEqual(['id', 'on', 'parent', 'publish', 'subscribe']);
    expect(context['dispose']).toBeUndefined();
    expect(context['createChild']).toBeUndefined();
    expect((root.context.parent as unknown as Record<string, unknown> | undefined)?.['dispose']).toBeUndefined(); // the parent scope is a facade too
    expect(root.events.id).toBe(app.workItems.root.events.id);
    expect(() => root.activate()).toThrowError(denied);
    expect(() => root.deactivate()).toThrowError(denied);
    const own = root.createChild('gate-act');
    expect(() => own.activate()).not.toThrow();
    expect(() => own.deactivate()).not.toThrow();
    // the real window nodes are untouched
    expect(app.workItems.root.status.peek()).not.toBe('terminated');
    expect(root.events).toBe(root.events); // stable identity
    // ContextKeyService: root and focused are facades; setFocused is the workbench's
    const service = ctx.services.get(ContextKeyService);
    expect((service.root as unknown as Record<string, unknown>)['dispose']).toBeUndefined();
    expect((service.focused.peek() as unknown as Record<string, unknown>)['dispose']).toBeUndefined();
    expect(() => service.setFocused(undefined)).toThrowError(denied);
  });

  it('C29: a placement from WorkbenchService.placement() hands out a context facade', async () => {
    const { app, ctx } = await fixture({
      setup(c) {
        c.views.registerProvider({
          viewType: 'fixture.gate.view',
          createViewModel: () => ({}),
          createPresenter: () => ({ viewState: { get: () => 0, peek: () => 0, subscribe: () => ({ dispose() {} }) } as never, intents: {}, dispose: () => undefined }),
        });
      },
    });
    const ref = await app.workbench.showView('fixture.gate.view');
    const placement = ctx.services.get(WorkbenchService).placement(ref.id);
    const context = placement?.context as unknown as Record<string, unknown>;
    expect(context).toBeDefined();
    expect(context['dispose']).toBeUndefined();
    expect(context['createChild']).toBeUndefined();
  });
});

describe('C29: the view door is gated (plugin-ui-bypasses-gate)', () => {
  async function viewFixture() {
    const provider = { viewType: 'fixture.gate.view', createPresenter: () => ({ viewState: state({ n: 1 }).asReadonly(), intents: {}, dispose: () => undefined }) } as unknown as ViewProvider;
    const f = await fixture({ setup: (ctx) => void ctx.views.registerProvider(provider) });
    const ref = await f.app.workbench.showView('fixture.gate.view');
    const placement = f.app.workbench.placement(ref.id)!;
    return { ...f, placement, view: createViewContext(f.app.window, placement) };
  }

  it('C29: ViewContext.services of a plugin view is the gated reader: an undeclared token throws plugin.capabilityDenied', async () => {
    const { view, placement } = await viewFixture();
    expect(view.services).not.toBe(placement.scope);
    expect(() => view.services.get(InterceptorRegistry)).toThrowError(denied);
    expect(() => view.services.get(RebuiltInterceptors)).toThrowError(denied);
    expect(() => view.services.get(StorageService, { optional: true })).toThrowError(denied);
    expect(view.services.has(RebuiltInterceptors)).toBe(false);
  });

  it('C29: a declared or public token resolves through the view door', async () => {
    const { view } = await viewFixture();
    expect(view.services.get(CommandService)).toBeDefined();
    expect(view.services.get(WorkbenchService)).toBeDefined();
    expect('provide' in view.services).toBe(false);
  });

  it('C29: ViewContext.contextKeys is the facade: keys of the plugin id prefix are fine, a foreign key is denied', async () => {
    const { view } = await viewFixture();
    expect(() => view.contextKeys.set('fixture.gate.selected', true)).not.toThrow();
    expect(() => view.contextKeys.set('someone.else.key', true)).toThrowError(denied);
    expect('createChild' in view.contextKeys).toBe(false);
    expect('dispose' in view.contextKeys).toBe(false);
  });

  it('C29: framework chrome (no plugin owner) keeps the raw reader and the raw context', async () => {
    const { app, placement } = await viewFixture();
    const policy = app.window.get(ViewServicesPolicy);
    expect(policy.readerFor('core.chrome', app.window)).toBe(app.window); // not a plugin: raw
    const chrome = createViewContext(app.window, { ...placement, viewType: 'chrome.unknown' } as never);
    expect(chrome.services).toBe(placement.scope);
    expect(chrome.contextKeys).toBe(placement.context);
  });

  it('C29: after the plugin ended, its view reader throws plugin.deactivated', async () => {
    const { app, view } = await viewFixture();
    const policy = app.window.get(ViewServicesPolicy);
    await app.plugins.deactivate('fixture.gate');
    expect(() => policy.readerFor('fixture.gate', app.window).get(CommandService)).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
    void view;
  });
});

describe('C29: a plugin cannot shadow a core service (plugin-provides-shadows-core-token)', () => {
  it('C29: a manifest that provides tessera.storage (or any id with the tessera. prefix) is invalid with plugin.duplicateProvider', async () => {
    const app = await createDemoApp({ only: [], extraPlugins: [describePlugin(manifest('fixture.shadow', { provides: ['tessera.storage'] })), describePlugin(manifest('fixture.shadow2', { provides: ['tessera.somethingNew'] }))] });
    expect(app.plugins.status('fixture.shadow')).toMatchObject({ state: 'invalid' });
    expect(app.plugins.status('fixture.shadow')?.problems.join(' ')).toContain('plugin.duplicateProvider');
    expect(app.plugins.status('fixture.shadow2')).toMatchObject({ state: 'invalid' });
  });

  it('C29: a plugin cannot require a non-public core token either (requires stays limited to public tokens)', async () => {
    const app = await createDemoApp({ only: [], extraPlugins: [describePlugin(manifest('fixture.reqcore', { requires: ['tessera.storage'] }))] });
    expect(app.plugins.status('fixture.reqcore')).toMatchObject({ state: 'unresolved' });
  });

  it('C29: ctx.services.provide refuses an id that a non-plugin owner registers, even if the manifest lists it', async () => {
    const HostThing = token<{ readonly n: number }>('host.product/Thing');
    const description = describePlugin(manifest('fixture.shadow3', { provides: ['host.product/Thing'] }));
    const probe: Probe = {};
    const app = await createDemoApp({ only: [], extraPlugins: [description], extraModules: { [description.location]: { activate: (ctx: PluginContext) => void (probe.ctx = ctx) } } });
    app.window.provideValue(HostThing, { n: 1 }, { owner: 'shell' });
    await app.plugins.activate('fixture.shadow3');
    expect(() => (probe.ctx as PluginContext).services.provide(HostThing, () => ({ n: 2 }))).toThrowError(denied);
    expect(app.window.get(HostThing).n).toBe(1);
  });
});

describe('C29: WorkItem.memento() works only on WorkItems the plugin owns (workitem-memento-cross-plugin)', () => {
  it('C29: a plugin cannot open a memento of the root WorkItem or of a foreign WorkItem', async () => {
    const schema = { version: 1, schema: { safeParse: (d: unknown) => ({ success: true as const, data: d as number }) }, initial: () => 0 };
    const { ctx } = await fixture({});
    const own = ctx.workItems.create('gate-own');
    expect(own.memento('k', schema).get()).toBe(0);
    expect(() => ctx.workItems.root.memento('k', schema)).toThrowError(denied);
  });
});

describe('C29: Observable subscriptions end with the plugin (plugin-registrations-outlive-plugin)', () => {
  it('C29: subscribe() on an Observable from a public token is tracked: it ends on deactivation and is refused afterwards', async () => {
    const before = reactiveDebug.liveSubscriptions();
    const { app, ctx } = await fixture({});
    const seen: unknown[] = [];
    const workbench = ctx.services.get(WorkbenchService);
    workbench.state.subscribe((v) => void seen.push(v));
    ctx.services.get(UndoService).canUndo('doc:x').subscribe(() => undefined);
    ctx.services.get(WorkItemService).active.subscribe(() => undefined);
    ctx.services.get(ContextKeyService).root.observe('fixture.gate.x').subscribe(() => undefined);
    ctx.workItems.create('obs-own').status.subscribe(() => undefined);
    expect(reactiveDebug.liveSubscriptions()).toBeGreaterThan(before);
    const stale = workbench.state;
    await app.plugins.deactivate('fixture.gate');
    expect(reactiveDebug.liveSubscriptions()).toBe(before);
    expect(() => stale.subscribe(() => undefined)).toThrowError(expect.objectContaining({ code: 'plugin.deactivated' }));
  });
});

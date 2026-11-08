import { describe, expect, it } from 'vitest';
import { CommandService, InterceptorRegistry, type PluginModule, type ViewProvider } from '@tessera/contracts';
import { state } from '@tessera/reactive';
import { captureErrors, createTestApp, describePlugin, manifest } from '@tessera/testing';
import { createViewContext, resolveMountTarget } from '../src/index.ts';

// The mount target is what every DOM renderer needs to mount a placement: the placement, its presenter and a ViewContext.
const description = describePlugin(
  manifest('test.mt', {
    contributes: {
      commands: [{ id: 'mt.ping', title: 'Ping' }],
      views: [{ id: 'mt.view', title: 'MT', workspace: 'workbench.editorArea', visibleByDefault: false }],
    },
  }),
);

const seen: Array<{ source: string; placement: string | undefined }> = [];
const plugin: PluginModule = {
  activate(ctx) {
    ctx.api.commands.registerHandler('mt.ping', { run: (_a, c) => void seen.push({ source: c.source, placement: c.placement?.id }) });
    const provider: ViewProvider = { viewType: 'mt.view', createPresenter: () => ({ viewState: state({ n: 1 }).asReadonly(), intents: {}, dispose: () => undefined }) };
    ctx.views.registerProvider(provider);
  },
};

describe('@tessera/dom: mount targets and the ViewContext', () => {
  it('resolves placement, presenter and context; the context runs commands as source view in the placement', async () => {
    seen.length = 0;
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: plugin } });
    const ref = await app.workbench.showView('mt.view');
    const target = await resolveMountTarget(app.window, ref.id);
    expect(target?.placement.id).toBe(ref.id);
    expect(target?.presenter).toBe(app.workbench.placement(ref.id)?.presenter);
    await target!.context.executeCommand('mt.ping');
    expect(seen).toEqual([{ source: 'view', placement: ref.id }]);
    // The view of a plugin gets the plugin's gated reader over the placement scope (not the raw scope), and a context-key facade.
    expect(target!.context.services).not.toBe(app.workbench.placement(ref.id)!.scope);
    expect(target!.context.services.get(CommandService)).toBeDefined(); // a public token
    expect(() => target!.context.services.get(InterceptorRegistry)).toThrowError(expect.objectContaining({ code: 'plugin.capabilityDenied' }));
    expect(target!.context.contextKeys.id).toBe(app.workbench.placement(ref.id)!.context.id);
  });

  it('reportError sends source view with the view type and the plugin that owns it', async () => {
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: plugin } });
    const ref = await app.workbench.showView('mt.view');
    const errors = captureErrors();
    const context = createViewContext(app.window, app.workbench.placement(ref.id)!);
    context.reportError(new Error('render failed'));
    expect(errors.drain().map((e) => e.context)).toEqual([{ source: 'view', target: 'mt.view', pluginId: 'test.mt' }]);
    errors.dispose();
  });

  it('a closed placement has no target', async () => {
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: plugin } });
    const ref = await app.workbench.showView('mt.view');
    await app.workbench.close(ref.id);
    expect(await resolveMountTarget(app.window, ref.id)).toBeUndefined();
  });
});

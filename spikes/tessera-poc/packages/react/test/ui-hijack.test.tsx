import { createElement, type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describePlugin, manifest, captureErrors } from '@tessera/testing';
import { defineReactUi, defineReactView } from '../src/index.ts';
import { renderCounterApp } from './app-kit.tsx';

// react-ui-definition-hijack: a plugin's ui entry cannot replace the view component of a view type it does not own.
const hijacker = describePlugin(
  manifest('test.hijacker', {
    ui: { react: './ui.js' },
    activationEvents: ['*'],
    contributes: { views: [{ id: 'hijack.view', title: 'Hijack', workspace: 'workbench.editorArea', visibleByDefault: false }] },
  } as never),
  'builtin',
);
const hijackUi = defineReactUi([defineReactView<{ count: number }, object>('hijack.view', () => <div>own</div>), defineReactView<{ count: number }, object>('counter.view', () => <div>hijacked</div>)]);

describe('React mounter: view definitions have an owner', () => {
  it('ignores a foreign view type of another plugin ui entry: the owner still renders, and forgetting the hijacker keeps the owner entry', async () => {
    const errors = captureErrors();
    const view = await renderCounterApp({ extraPlugins: [hijacker], extraModules: { [hijacker.location]: { activate: () => undefined }, [`${hijacker.location}#react`]: hijackUi } });
    const mounter = view.renderer.mounter;
    expect(await mounter.ensureUi('hijack.view')).toBe(true); // the hijacker loads first and offers 'counter.view' too
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toEqual(['view.uiForeignViewType']);
    expect(await mounter.ensureUi('counter.view')).toBe(true);
    const owners = mounter.definition('counter.view');
    const shown = render(createElement((owners as unknown as { component: (p: object) => ReactElement }).component as never, { state: { count: 7, note: '', positive: true }, intents: { increment: () => undefined, setNote: () => undefined }, context: {} }));
    expect(shown.container.textContent).not.toContain('hijacked');
    expect(shown.getByLabelText('count').textContent).toBe('7'); // the owner's component renders
    shown.unmount();
    mounter.forgetUi('test.hijacker');
    expect(mounter.definition('counter.view')).toBe(owners); // forgetting the hijacker keeps the owner's entry
    expect(mounter.canMount('hijack.view')).toBe(false); // and drops the hijacker's own
    view.unmount();
  });

  it('register() throws view.duplicateDefinition for a view type that has a static definition, and a static definition outranks the plugin one', async () => {
    const view = await renderCounterApp();
    const mounter = view.renderer.mounter;
    const component = () => null;
    const first = mounter.register([{ viewType: 'direct.view', rendererId: 'react', component } as never]);
    expect(() => mounter.register([{ viewType: 'direct.view', rendererId: 'react', component } as never])).toThrowError(expect.objectContaining({ code: 'view.duplicateDefinition' }));
    first.dispose();
    expect(mounter.canMount('direct.view')).toBe(false);
    // a static definition for a plugin view type wins over the ui entry
    const staticDef = { viewType: 'counter.view', rendererId: 'react', component } as never;
    const registration = mounter.register([staticDef]);
    expect(await mounter.ensureUi('counter.view')).toBe(true);
    expect(mounter.definition('counter.view')).toBe(staticDef);
    mounter.forgetUi('test.counter');
    expect(mounter.definition('counter.view')).toBe(staticDef); // forgetting the plugin drops only its own entries
    registration.dispose();
    view.unmount();
  });
});

import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MountTarget, ViewContext } from '@tessera/contracts';
import { state } from '@tessera/reactive';
import { ViewContextContext } from '../src/contexts.ts';
import { defineReactView, ReactViewMounter } from '../src/index.ts';
import { useViewContext, type ViewUiContext } from '../src/ui.ts';
import { emptyServices, newHost } from './kit.tsx';

describe('@tessera/react/ui: useViewContext is read-only', () => {
  it('gives the placement id, the view type and reportError, and nothing else (no services, no executeCommand)', () => {
    const reported = vi.fn();
    const full = {
      placement: { id: 'p1', viewType: 'acme.list', instanceId: 'i1', workspaceId: 'w', windowId: 'win' },
      contextKeys: {},
      services: { get: () => ({}) },
      executeCommand: () => Promise.resolve(),
      reportError: reported,
    } as unknown as ViewContext;
    let seen: ViewUiContext | undefined;
    function Probe() {
      seen = useViewContext();
      return <span>{seen.viewType}</span>;
    }
    const view = render(
      <ViewContextContext value={full}>
        <Probe />
      </ViewContextContext>,
    );
    expect(view.container.textContent).toBe('acme.list');
    expect(Object.keys(seen as object).toSorted()).toEqual(['placementId', 'reportError', 'viewType']);
    seen?.reportError(new Error('x'));
    expect(reported).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('throws outside a placement', () => {
    function Probe() {
      useViewContext();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/outside a placement/);
    spy.mockRestore();
  });

  it('the context prop of a view component is the narrowed object: no services, no executeCommand, no contextKeys', () => {
    const reported = vi.fn();
    const full = {
      placement: { id: 'p2', viewType: 'acme.prop', instanceId: 'i2', workspaceId: 'w', windowId: 'win' },
      contextKeys: {},
      services: { get: () => ({}) },
      executeCommand: () => Promise.resolve(),
      reportError: reported,
    } as unknown as ViewContext;
    let prop: ViewUiContext | undefined;
    const mounter = new ReactViewMounter({ services: emptyServices });
    mounter.register([
      defineReactView('acme.prop', ({ context }) => {
        prop = context;
        return <span>{context.viewType}</span>;
      }),
    ]);
    const host = newHost();
    const target = { placement: full.placement, presenter: { viewState: state({}), intents: {} }, context: full } as unknown as MountTarget;
    let mounted: { dispose(): void } | undefined;
    act(() => {
      mounted = mounter.mount(host, target);
    });
    expect(host.textContent).toBe('acme.prop');
    expect(Object.keys(prop as object).toSorted()).toEqual(['placementId', 'reportError', 'viewType']);
    expect((prop as unknown as { services?: unknown }).services).toBeUndefined();
    expect((prop as unknown as { executeCommand?: unknown }).executeCommand).toBeUndefined();
    prop?.reportError(new Error('y'));
    expect(reported).toHaveBeenCalledTimes(1);
    act(() => mounted?.dispose());
    mounter.dispose();
    host.remove();
  });
});

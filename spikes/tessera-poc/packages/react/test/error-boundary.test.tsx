import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EDITOR_AREA_WORKSPACE, PlacementStatus, type PluginModule } from '@tessera/contracts';
import { captureErrors, describePlugin, manifest } from '@tessera/testing';
import { renderCounterApp } from './app-kit.tsx';

const pane = (id: string): HTMLElement => document.querySelector(`[data-placement="${id}"]`) as HTMLElement;

describe('C24: per-placement error boundaries', () => {
  it('C24: a view that throws shows the fallback in its own placement and is reported with source view; other placements keep working', async () => {
    const errors = captureErrors();
    const r = await renderCounterApp();
    let good!: { id: string };
    let bad!: { id: string };
    await act(async () => {
      good = await r.app.workbench.showView('counter.view');
      bad = await r.app.workbench.showView('counter.crash', { workspace: EDITOR_AREA_WORKSPACE });
      await r.app.settle();
    });
    const alert = within(pane(bad.id)).getByRole('alert');
    expect(alert.textContent).toContain('crash in render');
    // the good placement is unaffected: it renders and reacts
    expect(within(pane(good.id)).getByLabelText('count').textContent).toBe('0');
    fireEvent.click(within(pane(good.id)).getByRole('button', { name: 'plus' }));
    expect(within(pane(good.id)).getByLabelText('count').textContent).toBe('1');
    // the error was reported once per render pass, with the view source and the owner plugin
    const reported = errors.drain().filter((e) => e.context.source === 'view');
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]?.context).toMatchObject({ source: 'view', target: 'counter.crash', pluginId: 'test.counter' });
    // the placement stays attached (the boundary caught the error, the model did not change)
    expect(r.app.workbench.placement(bad.id as never)?.status.peek()).toBe(PlacementStatus.Attached);
    errors.dispose();
    r.unmount();
  });

  it('C24: "Reload view" renders the failed view again (and shows the fallback again while it still throws)', async () => {
    const errors = captureErrors();
    const r = await renderCounterApp();
    let bad!: { id: string };
    await act(async () => {
      bad = await r.app.workbench.showView('counter.crash', { workspace: EDITOR_AREA_WORKSPACE });
      await r.app.settle();
    });
    const before = errors.drain().length;
    await act(async () => {
      fireEvent.click(within(pane(bad.id)).getByRole('button', { name: 'Reload view' }));
    });
    expect(within(pane(bad.id)).getByRole('alert')).toBeTruthy();
    expect(errors.drain().length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    errors.dispose();
    r.unmount();
  });

  it('C24: a view type whose plugin failed to activate renders a placeholder with the problem, not a crash', async () => {
    const errors = captureErrors();
    const ghost = describePlugin(
      manifest('test.ghost', {
        contributes: { views: [{ id: 'ghost.view', title: 'Ghost', workspace: EDITOR_AREA_WORKSPACE, visibleByDefault: false }] },
      }),
    );
    const failing: PluginModule = {
      activate() {
        throw new Error('ghost cannot start');
      },
    };
    const r = await renderCounterApp({ extraPlugins: [ghost], extraModules: { [ghost.location]: failing } });
    let ref!: { id: string };
    await act(async () => {
      ref = await r.app.workbench.showView('ghost.view');
      await r.app.settle();
    });
    const placeholder = within(pane(ref.id)).getByRole('note');
    expect(placeholder.textContent).toContain('ghost.view');
    expect(placeholder.textContent).toMatch(/failed|not available/i);
    expect(screen.getByText('Test App')).toBeTruthy(); // the app is still there
    expect(errors.drain().some((e) => e.context.pluginId === 'test.ghost' || String(e.error).includes('ghost cannot start'))).toBe(true);
    errors.dispose();
    r.unmount();
  });
});

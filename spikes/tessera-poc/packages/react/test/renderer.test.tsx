import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandService, EDITOR_AREA_WORKSPACE, NotificationService, QuickInputService, StatusBarService, type PlacementRef } from '@tessera/contracts';
import { reactiveDebug } from '@tessera/reactive';
import { captureErrors } from '@tessera/testing';
import { renderCounterApp, type RenderedApp } from './app-kit.tsx';

async function settle(r: RenderedApp): Promise<void> {
  await act(async () => {
    await r.app.settle();
    await Promise.resolve();
  });
}

async function openTwice(r: RenderedApp): Promise<{ side: PlacementRef; dock: PlacementRef }> {
  let side!: PlacementRef;
  let dock!: PlacementRef;
  await act(async () => {
    side = await r.app.workbench.showView('counter.view');
    dock = await r.app.workbench.showView('counter.view', { workspace: EDITOR_AREA_WORKSPACE });
  });
  await settle(r);
  return { side, dock };
}

const pane = (id: string): HTMLElement => document.querySelector(`[data-placement="${id}"]`) as HTMLElement;

describe('C24: WorkbenchRenderer: one shared state in two placements (React level)', () => {
  it('C24: a view in the side bar and a view in the editor area render one shared counter and keep their notes apart', async () => {
    const r = await renderCounterApp();
    const { side, dock } = await openTwice(r);
    const a = pane(side.id);
    const b = pane(dock.id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(within(a).getByLabelText('count').textContent).toBe('0');
    expect(within(b).getByLabelText('count').textContent).toBe('0');

    fireEvent.click(within(a).getByRole('button', { name: 'plus' }));
    expect(within(a).getByLabelText('count').textContent).toBe('1');
    expect(within(b).getByLabelText('count').textContent).toBe('1'); // shared state: both placements, same frame

    fireEvent.change(within(a).getByLabelText('note'), { target: { value: 'left only' } });
    expect((within(a).getByLabelText('note') as HTMLInputElement).value).toBe('left only');
    expect((within(b).getByLabelText('note') as HTMLInputElement).value).toBe(''); // local state: per placement
    r.unmount();
  });

  it('C24: the view/title menu shows the plugin command; enablement follows the placement context key', async () => {
    const r = await renderCounterApp();
    const { side } = await openTwice(r);
    const toolbar = within(pane(side.id)).getByRole('toolbar', { name: 'View actions' });
    const reset = within(toolbar).getByRole('button', { name: 'Reset Counter' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true); // counter.positive is false
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Increment Counter' }));
    await settle(r);
    expect((within(toolbar).getByRole('button', { name: 'Reset Counter' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Reset Counter' }));
    await settle(r);
    expect(within(pane(side.id)).getByLabelText('count').textContent).toBe('0');
    r.unmount();
  });

  it('C24: the status bar shows the contributed item', async () => {
    const r = await renderCounterApp();
    expect(screen.getByText('Counter ready')).toBeTruthy();
    // a service-added item appears too
    let added: { dispose(): void } | undefined;
    act(() => {
      added = r.app.get(StatusBarService).add({ id: 'test.live', alignment: 'right', text: 'live' });
    });
    expect(screen.getByText('live')).toBeTruthy();
    act(() => added?.dispose());
    expect(screen.queryByText('live')).toBeNull();
    r.unmount();
  });

  it('C24: the command palette lists commands, filters, runs the chosen one and closes; disabled commands are not listed', async () => {
    const r = await renderCounterApp();
    const { side } = await openTwice(r);
    let done!: Promise<void>;
    act(() => {
      done = r.app.get(QuickInputService).showCommandPalette();
    });
    const dialog = await screen.findByRole('dialog');
    const names = within(dialog).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('Increment Counter'))).toBe(true);
    expect(names.some((n) => n.includes('Reset Counter'))).toBe(false); // disabled: hidden in the palette
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'incr' } });
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      await done;
    });
    await settle(r);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(pane(side.id)).getByLabelText('count').textContent).toBe('1');
    r.unmount();
  });

  it('C24: Escape closes the palette without running a command', async () => {
    const r = await renderCounterApp();
    let done!: Promise<void>;
    act(() => {
      done = r.app.get(QuickInputService).showCommandPalette();
    });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    await act(async () => {
      await done;
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(r.plugin.count.peek()).toBe(0);
    r.unmount();
  });

  it('C24: a notification is shown with its action, the action runs a command, and dismiss hides it', async () => {
    const r = await renderCounterApp();
    act(() => {
      r.app.get(NotificationService).notify({ severity: 'error', message: 'Something broke', detail: 'details here', source: 'test.counter', actions: [{ title: 'Count it', command: 'counter.increment' }] });
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something broke');
    expect(alert.textContent).toContain('details here');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Count it' }));
      await r.app.settle();
    });
    expect(r.plugin.count.peek()).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull(); // running the action dismisses it
    act(() => {
      r.app.get(NotificationService).notify({ severity: 'info', message: 'FYI' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('FYI')).toBeNull();
    r.unmount();
  });

  it('C24: clicking a tab activates its placement; closing a tab goes through the close pipeline (requestClose)', async () => {
    const r = await renderCounterApp();
    const { dock } = await openTwice(r);
    const second = await act(async () => r.app.workbench.showView('counter.view', { workspace: EDITOR_AREA_WORKSPACE, reuse: 'new' }));
    await settle(r);
    const tabs = within(document.querySelector('[data-workspace="workbench.editorArea"]') as HTMLElement).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    fireEvent.click(tabs[0] as HTMLElement);
    await settle(r);
    expect(r.app.workbench.state.peek().workspaces[EDITOR_AREA_WORKSPACE]?.active).toBe(dock.id);
    const close = within(document.querySelector('[data-workspace="workbench.editorArea"]') as HTMLElement).getAllByRole('button', { name: 'Close' });
    fireEvent.click(close[1] as HTMLElement);
    await settle(r);
    expect(r.app.workbench.placement(second.id)).toBeUndefined();
    r.unmount();
  });

  it('C24: renders under StrictMode and leaves zero live reactive subscriptions after unmount and app disposal', async () => {
    const baseline = reactiveDebug.liveSubscriptions();
    const r = await renderCounterApp({ strictMode: true });
    await openTwice(r);
    expect(reactiveDebug.liveSubscriptions()).toBeGreaterThan(baseline);
    r.unmount();
    await act(async () => {
      await r.app.dispose();
    });
    expect(reactiveDebug.liveSubscriptions()).toBe(baseline);
  });

  it('C24: commands that fail in a view-triggered menu run do not crash the renderer', async () => {
    const r = await renderCounterApp();
    const errors = captureErrors();
    await openTwice(r);
    await act(async () => {
      await r.app.get(CommandService).execute('counter.reset', undefined, { force: true }).catch(() => undefined);
    });
    expect(screen.getByText('Test App')).toBeTruthy();
    errors.drain();
    errors.dispose();
    r.unmount();
  });
});

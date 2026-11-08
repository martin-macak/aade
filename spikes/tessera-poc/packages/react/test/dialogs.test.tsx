import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DialogService, NotificationService } from '@tessera/contracts';
import { renderCounterApp } from './app-kit.tsx';

describe('React chrome: dialogs and progress', () => {
  it('draws a confirm and resolves it from the buttons; draws an input with its validation error', async () => {
    const view = await renderCounterApp();
    const dialogs = view.app.get(DialogService);
    let confirmed: Promise<boolean> | undefined;
    act(() => {
      confirmed = dialogs.confirm({ message: 'Delete the branch?', confirmLabel: 'Delete' });
    });
    expect(screen.getByRole('alertdialog').textContent).toContain('Delete the branch?');
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    expect(await confirmed).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    let entered: Promise<string | undefined> | undefined;
    act(() => {
      entered = dialogs.input({ prompt: 'Name', validate: (v) => (v === '' ? 'Required' : undefined) });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('OK'));
    });
    expect(screen.getByRole('alert').textContent).toBe('Required');
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } });
      fireEvent.click(screen.getByText('OK'));
    });
    expect(await entered).toBe('abc');
    view.unmount();
  });

  it('draws a progress notification with its message and a Cancel button for a cancellable task', async () => {
    const view = await renderCounterApp();
    const notifications = view.app.get(NotificationService);
    let outcome: Promise<string> | undefined;
    act(() => {
      outcome = notifications.withProgress({ title: 'Fetching', cancellable: true }, (progress) => {
        progress.report({ message: '12 of 40', fraction: 0.3 });
        return new Promise<string>((resolve) => progress.signal.addEventListener('abort', () => resolve('cancelled')));
      });
    });
    expect(screen.getByText('Fetching')).toBeDefined();
    expect(screen.getByText('12 of 40')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });
    expect(await outcome).toBe('cancelled');
    view.unmount();
  });
});

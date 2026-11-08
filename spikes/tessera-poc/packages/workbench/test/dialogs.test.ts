import { describe, expect, it } from 'vitest';
import { createTestScope } from '@tessera/testing';
import { DefaultDialogService, DefaultNotificationService } from '@tessera/workbench';

describe('DialogService: confirm and input queue as requests, one dialog at a time', () => {
  it('confirm resolves true on accept and false on cancel; requests queue in order', async () => {
    createTestScope({ flat: true });
    const dialogs = new DefaultDialogService();
    const first = dialogs.confirm({ message: 'Delete?' });
    const second = dialogs.confirm({ message: 'Really?', confirmLabel: 'Yes' });
    expect(dialogs.pending.peek().map((r) => r.message)).toEqual(['Delete?', 'Really?']);
    expect(dialogs.pending.peek()[1]?.confirmLabel).toBe('Yes');
    dialogs.pending.peek()[0]?.accept();
    expect(await first).toBe(true);
    dialogs.pending.peek()[0]?.cancel();
    expect(await second).toBe(false);
    expect(dialogs.pending.peek()).toEqual([]);
  });

  it('input returns the entered text, refuses a value that validate rejects (the dialog stays), and resolves undefined on cancel', async () => {
    createTestScope({ flat: true });
    const dialogs = new DefaultDialogService();
    const answer = dialogs.input({ prompt: 'Branch name', value: 'main', validate: (v) => (v.includes(' ') ? 'No spaces' : undefined) });
    const request = dialogs.pending.peek()[0];
    expect(request?.initialValue).toBe('main');
    expect(request?.accept('bad name')).toBe('No spaces');
    expect(dialogs.pending.peek()).toHaveLength(1); // still open
    expect(request?.accept('feature-x')).toBeUndefined();
    expect(await answer).toBe('feature-x');
    const cancelled = dialogs.input({ prompt: 'Again' });
    dialogs.pending.peek()[0]?.cancel();
    expect(await cancelled).toBeUndefined();
  });

  it('an aborted signal closes the dialog as declined, and an already aborted signal never opens one', async () => {
    createTestScope({ flat: true });
    const dialogs = new DefaultDialogService();
    const controller = new AbortController();
    const answer = dialogs.confirm({ message: 'x', signal: controller.signal });
    controller.abort();
    expect(await answer).toBe(false);
    expect(dialogs.pending.peek()).toEqual([]);
    expect(await dialogs.confirm({ message: 'y', signal: controller.signal })).toBe(false);
    expect(dialogs.pending.peek()).toEqual([]);
  });
});

describe('NotificationService.withProgress', () => {
  it('shows a progress notification while the task runs, takes reports, returns the result and removes the notification', async () => {
    createTestScope({ flat: true });
    const notifications = new DefaultNotificationService();
    let release: (() => void) | undefined;
    const running = notifications.withProgress({ title: 'Cloning' }, (progress) => {
      progress.report({ message: 'objects', fraction: 0.4 });
      return new Promise<string>((resolve) => void (release = () => resolve('done')));
    });
    const shown = notifications.active.peek()[0];
    expect(shown).toMatchObject({ message: 'Cloning', progress: { message: 'objects', fraction: 0.4, cancellable: false } });
    release?.();
    expect(await running).toBe('done');
    expect(notifications.active.peek()).toEqual([]);
  });

  it('a cancellable task gets an aborted signal when the user cancels, and an error of the task still removes the notification', async () => {
    createTestScope({ flat: true });
    const notifications = new DefaultNotificationService();
    const outcome = notifications.withProgress({ title: 'Long', cancellable: true }, (progress) => new Promise<never>((_resolve, reject) => progress.signal.addEventListener('abort', () => reject(new Error('cancelled')))));
    notifications.active.peek()[0]?.progress?.cancel?.();
    await expect(outcome).rejects.toThrow('cancelled');
    expect(notifications.active.peek()).toEqual([]);
  });
});

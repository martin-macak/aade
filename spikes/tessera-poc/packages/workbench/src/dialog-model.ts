import { generateId, type IDisposable } from '@tessera/base';
import type { ConfirmOptions, DialogRequest, DialogService, InputOptions } from '@tessera/contracts';
import { state, type Observable, type State } from '@tessera/reactive';

/**
 * The model of modal questions (confirm, input). A request waits in a queue; the renderer draws the first and calls accept or cancel.
 * One collaborator of its own, not part of the workbench service: it needs no placements, no layout and no DOM. Window DI scope.
 */
export class DefaultDialogService implements DialogService, IDisposable {
  readonly pending: Observable<readonly DialogRequest[]>;
  readonly #queue: State<readonly DialogRequest[]> = state<readonly DialogRequest[]>([], { name: 'dialogs.pending' });

  constructor() {
    this.pending = this.#queue.asReadonly();
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    return this.#ask<boolean>(
      {
        kind: 'confirm',
        title: options.title,
        message: options.message,
        detail: options.detail,
        severity: options.severity ?? 'info',
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        placeholder: undefined,
        initialValue: '',
      },
      options.signal,
      false,
      () => true,
    );
  }

  input(options: InputOptions): Promise<string | undefined> {
    return this.#ask<string | undefined>(
      {
        kind: 'input',
        title: options.title,
        message: options.prompt,
        detail: undefined,
        severity: 'info',
        confirmLabel: 'OK',
        cancelLabel: 'Cancel',
        placeholder: options.placeholder,
        initialValue: options.value ?? '',
      },
      options.signal,
      undefined,
      (value) => value,
      options.validate,
    );
  }

  #ask<T>(
    shape: Omit<DialogRequest, 'id' | 'accept' | 'cancel'>,
    signal: AbortSignal | undefined,
    declined: T,
    accepted: (value: string) => T,
    validate?: (value: string) => string | undefined,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(declined);
    return new Promise<T>((resolve) => {
      let done = false;
      const finish = (value: T): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        this.#queue.update((q) => q.filter((r) => r !== request));
        resolve(value);
      };
      const onAbort = (): void => finish(declined);
      const request: DialogRequest = {
        ...shape,
        id: generateId('dlg'),
        accept: (value) => {
          const error = shape.kind === 'input' ? validate?.(value ?? '') : undefined;
          if (error !== undefined) return error;
          finish(accepted(value ?? ''));
          return undefined;
        },
        cancel: () => finish(declined),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.update((q) => [...q, request]);
    });
  }

  dispose(): void {
    // Open dialogs end as declined: nobody is left to answer them.
    for (const request of this.#queue.peek()) request.cancel();
  }
}

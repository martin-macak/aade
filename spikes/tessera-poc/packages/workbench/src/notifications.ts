import { generateId, toDisposable, type IDisposable } from '@tessera/base';
import type { NotificationInit, NotificationService, ProgressOptions, ProgressReporter } from '@tessera/contracts';
import { state, type Observable, type State } from '@tessera/reactive';

type Active = NotificationInit & { readonly id: string };

/** The model of notifications. A renderer draws `active`. Window DI scope. */
export class DefaultNotificationService implements NotificationService, IDisposable {
  readonly active: Observable<readonly Active[]>;
  readonly #list: State<readonly Active[]> = state<readonly Active[]>([], { name: 'notifications.active' });

  constructor() {
    this.active = this.#list.asReadonly();
  }

  notify(notification: NotificationInit): IDisposable {
    const entry: Active = Object.freeze({ ...notification, id: generateId('n') });
    this.#list.update((l) => [...l, entry]);
    return toDisposable(() => this.#list.update((l) => l.filter((n) => n !== entry)));
  }

  async withProgress<T>(options: ProgressOptions, task: (progress: ProgressReporter) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const id = generateId('n');
    let message: string | undefined;
    let fraction: number | undefined;
    const build = (): Active =>
      Object.freeze({
        id,
        severity: 'info',
        message: options.title,
        progress: Object.freeze({
          ...(message !== undefined ? { message } : {}),
          ...(fraction !== undefined ? { fraction } : {}),
          cancellable: options.cancellable === true,
          ...(options.cancellable === true ? { cancel: () => controller.abort() } : {}),
        }),
      });
    const replace = (): void => this.#list.update((l) => l.map((n) => (n.id === id ? build() : n)));
    this.#list.update((l) => [...l, build()]);
    const reporter: ProgressReporter = {
      signal: controller.signal,
      report: (update) => {
        if (update.message !== undefined) message = update.message;
        if (update.fraction !== undefined) fraction = Math.min(1, Math.max(0, update.fraction));
        replace();
      },
    };
    try {
      return await task(reporter);
    } finally {
      this.#list.update((l) => l.filter((n) => n.id !== id));
    }
  }

  dispose(): void {
    this.#list.set([]);
  }
}

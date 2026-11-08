// Shared test helpers.
import { MessageLoop } from '@lumino/messaging';
import { act } from 'react';
import { createWindow, type DemoWindow } from '../src/app.ts';
import { type StorageLike } from '../src/cap5-persistence.ts';
import { auditPlugin } from '../src/plugins/audit.ts';
import { faultyPlugin } from '../src/plugins/faulty.ts';
import { tasksPlugin } from '../src/plugins/tasks.ts';

export class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Let Lumino's message loop, React and the lazy imports settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      MessageLoop.flush();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

export interface Harness {
  win: DemoWindow;
  host: HTMLElement;
  storage: MemoryStorage;
  errors: unknown[];
  stop(): void;
}

let counter = 0;
export async function boot(options: { plugins?: Array<typeof tasksPlugin | typeof auditPlugin | typeof faultyPlugin>; storage?: MemoryStorage; start?: boolean } = {}): Promise<Harness> {
  const host = document.createElement('div');
  host.id = `host-${++counter}`;
  document.body.append(host);
  const storage = options.storage ?? new MemoryStorage();
  const errors: unknown[] = [];
  const win = createWindow({ storage, onError: (e) => errors.push(e) });
  for (const plugin of options.plugins ?? [auditPlugin, tasksPlugin]) win.plugins.register(plugin);
  if (options.start ?? true) {
    await act(async () => {
      await win.start(host.id);
    });
  }
  await settle();
  return {
    win,
    host,
    storage,
    errors,
    stop() {
      win.dispose();
      host.remove();
    },
  };
}

import { act } from '@testing-library/react';
import { CommandService, type PlacementRef } from '@tessera/contracts';
import { bootDemo, type DemoHandle, type DemoOptions } from '../src/boot.tsx';

export const EDITOR = 'workbench.editorArea';

export interface TestDemo {
  readonly demo: DemoHandle;
  readonly root: HTMLElement;
  readonly controls: HTMLElement;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Boots the demo into fresh elements. `inAct` wraps async work in React act() (jsdom). */
export async function startDemo(options: Partial<DemoOptions> & { readonly inAct?: boolean } = {}): Promise<TestDemo> {
  const root = document.createElement('div');
  root.id = 'app';
  root.style.cssText = 'position:relative;width:1100px;height:700px;';
  const controls = document.createElement('div');
  document.body.append(controls, root);
  const { inAct, ...rest } = options;
  const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!inAct) return fn();
    let result!: T;
    await act(async () => {
      result = await fn();
    });
    return result;
  };
  const demo = await wrap(() => bootDemo({ root, controls, ...rest }));
  const settle = async (): Promise<void> => {
    await wrap(async () => {
      for (let i = 0; i < 4; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 10));
      }
    });
  };
  await settle();
  return {
    demo,
    root,
    controls,
    settle,
    async dispose() {
      await wrap(() => demo.dispose());
      root.remove();
      controls.remove();
    },
  };
}

export const views = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="tasks-view"]')];
export const taskTitles = (view: HTMLElement): string[] => [...view.querySelectorAll('li[role="option"] > span')].map((e) => e.textContent ?? '');
export const selectedIds = (view: HTMLElement): string[] => [...view.querySelectorAll<HTMLElement>('li[aria-selected="true"]')].map((e) => e.dataset['taskId'] ?? '');

export async function execute(demo: DemoHandle, id: string, args?: unknown): Promise<unknown> {
  return demo.web.services.get(CommandService).execute(id, args, { source: 'palette' });
}

export type { PlacementRef };

import { act } from '@testing-library/react';
import { toDisposable, type IDisposable } from '@tessera/base';
import type { MountTarget, ViewMounter } from '@tessera/contracts';
import type { ReactViewMounter, ReactViewMounterOptions } from '../src/index.ts';

/** A ScopeReader that knows nothing: enough for a mounter that only mounts registered views. */
export const emptyServices: ReactViewMounterOptions['services'] = { get: () => undefined as never, getAll: () => [], has: () => false };

/** Wraps a mounter so that React work from mount and dispose runs inside act(). */
export function inAct(mounter: ReactViewMounter): ViewMounter<HTMLElement> {
  return {
    rendererId: mounter.rendererId,
    ensureUi: (viewType) => mounter.ensureUi(viewType),
    canMount: (viewType) => mounter.canMount(viewType),
    mount(host: HTMLElement, target: MountTarget): IDisposable {
      let mounted: IDisposable = toDisposable(() => undefined);
      act(() => {
        mounted = mounter.mount(host, target);
      });
      return toDisposable(() => act(() => mounted.dispose()));
    },
  };
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function newHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

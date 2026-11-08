import { act } from '@testing-library/react';
import { CONFORMANCE_BROKEN_VIEW, CONFORMANCE_COUNTER_VIEW, viewMounterConformance } from '@tessera/testing';
import { defineReactView, ReactViewMounter } from '../src/index.ts';
import { emptyServices, flush, inAct, newHost } from './kit.tsx';

// C27: @tessera/react passes the shared ViewMounter conformance suite (in StrictMode, the strictest setting).
interface Counter {
  readonly count: number;
}
viewMounterConformance<HTMLElement>('React mounter', () => {
  const mounter = new ReactViewMounter({ services: emptyServices, strictMode: true });
  const hosts: HTMLElement[] = [];
  return {
    mounter: inAct(mounter),
    createHost: () => {
      const host = newHost();
      hosts.push(host);
      return host;
    },
    install() {
      mounter.register([
        defineReactView<Counter, { increment(): void }>(CONFORMANCE_COUNTER_VIEW, ({ state, intents }) => (
          <button type="button" onClick={() => intents.increment()}>
            count={state.count}
          </button>
        )),
        defineReactView(CONFORMANCE_BROKEN_VIEW, () => {
          throw new Error('broken on purpose');
        }),
      ]);
    },
    text: (host) => host.textContent ?? '',
    press: (host) => {
      act(() => host.querySelector('button')?.click());
    },
    flush,
    async dispose() {
      await flush();
      mounter.dispose();
      await flush();
      for (const host of hosts) host.remove();
    },
  };
});

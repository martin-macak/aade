import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { reactiveDebug, state } from '@tessera/reactive';
import { CounterPresenter, stubTarget } from '@tessera/testing';
import { defineReactView, ReactViewMounter, useObservable } from '../src/index.ts';
import { emptyServices, flush, newHost } from './kit.tsx';

describe('C24: StrictMode leaves zero live subscriptions', () => {
  it('C24: mount and dispose cycles of the mounter under StrictMode end with the baseline subscription count', async () => {
    const mounter = new ReactViewMounter({ services: emptyServices, strictMode: true });
    mounter.register([defineReactView<{ count: number }, { increment(): void }>('conformance.counter', ({ state: s }) => <p>{s.count}</p>)]);
    const baseline = reactiveDebug.liveSubscriptions();
    const presenter = new CounterPresenter();
    for (let cycle = 0; cycle < 5; cycle++) {
      const hosts = [newHost(), newHost(), newHost()];
      const mounted = hosts.map((host) => {
        let d!: { dispose(): void };
        act(() => {
          d = mounter.mount(host, stubTarget('conformance.counter', presenter));
        });
        return d;
      });
      await flush();
      expect(reactiveDebug.liveSubscriptions() - baseline).toBe(3); // one per placement, even though StrictMode double-mounts effects
      act(() => presenter.intents.increment());
      for (const d of mounted) act(() => d.dispose());
      await flush();
      expect(reactiveDebug.liveSubscriptions()).toBe(baseline);
      for (const host of hosts) host.remove();
    }
    expect(mounter.hub.size).toBe(0);
    mounter.dispose();
    await flush();
  });

  it('C24: unmounting a StrictMode root that uses useObservable releases the subscription', () => {
    const source = state(1, { name: 'test.source' });
    const baseline = reactiveDebug.liveSubscriptions();
    function Probe() {
      return <span>{useObservable(source)}</span>;
    }
    const host = newHost();
    const root = createRoot(host);
    act(() => root.render(<StrictMode><Probe /></StrictMode>));
    expect(reactiveDebug.liveSubscriptions() - baseline).toBe(1);
    act(() => root.unmount());
    expect(reactiveDebug.liveSubscriptions()).toBe(baseline);
    host.remove();
  });
});

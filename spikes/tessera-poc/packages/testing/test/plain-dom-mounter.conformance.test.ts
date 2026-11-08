import { viewMounterConformance, CONFORMANCE_BROKEN_VIEW, CONFORMANCE_COUNTER_VIEW, plainDomMounter, type TextHost } from '../src/index.ts';

// C27: the test-only plain DOM mounter passes the same ViewMounter conformance suite as the React mounter.
// The host is a bare object with textContent, so this runs in Node without a DOM.
viewMounterConformance<TextHost>('plain DOM mounter (test only)', () => {
  const mounter = plainDomMounter();
  return {
    mounter,
    createHost: () => ({ textContent: '' }),
    install() {
      mounter.register(CONFORMANCE_COUNTER_VIEW, {
        render: (state) => `count=${(state as { count: number }).count}`,
        actions: { increment: (intents) => (intents as { increment(): void }).increment() },
      });
      mounter.register(CONFORMANCE_BROKEN_VIEW, () => {
        throw new Error('broken on purpose');
      });
    },
    text: (host) => host.textContent ?? '',
    press: (host) => void mounter.press(host, 'increment'),
    flush: async () => {
      await Promise.resolve();
    },
  };
});

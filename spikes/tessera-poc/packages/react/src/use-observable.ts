import { useCallback, useSyncExternalStore } from 'react';
import type { Observable } from '@tessera/reactive';

/**
 * One useSyncExternalStore subscription. `subscribe` is stable per source and `getSnapshot` is `source.peek()`, whose
 * identity is stable while nothing changed (contracts.md 18.2, rule 1). The server snapshot is the same function: no SSR here.
 */
export function useObservable<T>(source: Observable<T>): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = source.subscribe(onChange);
      return () => subscription.dispose();
    },
    [source],
  );
  const getSnapshot = useCallback(() => source.peek(), [source]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

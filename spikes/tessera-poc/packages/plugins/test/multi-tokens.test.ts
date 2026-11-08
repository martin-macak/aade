import { describe, expect, it } from 'vitest';
import { multiToken } from '@tessera/di';
import type { Observable } from '@tessera/reactive';
import { manifest } from '@tessera/testing';
import { kit } from './kit.ts';

const Greeters = multiToken<{ readonly name: string }>('fixture/Greeters');

describe('round 2: plugins extend each other in code (multi tokens)', () => {
  function setup() {
    const k = kit();
    const seen: string[][] = [];
    const order: string[] = [];
    k.provideModule('fixture.a', {
      activate(ctx) {
        order.push('a');
        ctx.services.provideMany(Greeters, () => ({ name: 'a' }));
      },
    });
    k.provideModule('fixture.b', {
      activate(ctx) {
        order.push('b');
        ctx.services.provideMany(Greeters, () => ({ name: 'b' }));
      },
    });
    k.provideModule('fixture.reader', {
      activate(ctx) {
        order.push('reader');
        seen.push(ctx.services.getAll(Greeters).map((g) => g.name));
      },
    });
    return { k, seen, order };
  }

  it('C19: two plugins contribute to one multi token; the reader that declares it in optional activates after both and sees both', async () => {
    const { k, seen, order } = setup();
    await k.add(
      manifest('fixture.reader', { optional: [Greeters.id] }),
      manifest('fixture.a', { contributesTo: [Greeters.id] }),
      manifest('fixture.b', { contributesTo: [Greeters.id] }),
    );
    expect(k.manager.status('fixture.a')?.state).toBe('resolved'); // many contributors are no duplicate provider
    expect(k.manager.status('fixture.b')?.state).toBe('resolved');
    await k.manager.activate('fixture.reader');
    expect(order.at(-1)).toBe('reader');
    expect(order.toSorted()).toEqual(['a', 'b', 'reader']);
    expect(seen).toEqual([['a', 'b']]);
  });

  it('C19: disabling one contributor removes its contribution; the reader is not failed by it', async () => {
    const { k } = setup();
    await k.add(
      manifest('fixture.reader', { requires: [Greeters.id] }),
      manifest('fixture.a', { contributesTo: [Greeters.id] }),
      manifest('fixture.b', { contributesTo: [Greeters.id] }),
    );
    await k.manager.activate('fixture.reader');
    expect(k.t.window.getAll(Greeters).map((g) => g.name).toSorted()).toEqual(['a', 'b']);
    await k.manager.disable('fixture.a');
    expect(k.t.window.getAll(Greeters).map((g) => g.name)).toEqual(['b']);
    expect(k.manager.status('fixture.reader')?.state).toBe('resolved'); // its dependents end with a contributor, as with any dependency (it is not failed)
  });

  it('C19: provideMany needs the manifest entry, and a reader without requires or optional is refused', async () => {
    const k = kit();
    let provideError: unknown;
    let readError: unknown;
    k.provideModule('fixture.rogue', {
      activate(ctx) {
        try {
          ctx.services.provideMany(Greeters, () => ({ name: 'x' }));
        } catch (error) {
          provideError = error;
        }
        try {
          ctx.services.getAll(Greeters);
        } catch (error) {
          readError = error;
        }
      },
    });
    await k.add(manifest('fixture.rogue'));
    await k.manager.activate('fixture.rogue');
    expect(provideError).toMatchObject({ code: 'plugin.capabilityDenied' });
    expect(readError).toMatchObject({ code: 'plugin.capabilityDenied' });
  });

  it('multi-token-getall-is-a-snapshot: observeAll follows the contributors (a later one appears, a disabled one disappears) and ends with the reader', async () => {
    const k = kit();
    const live: Array<Observable<readonly { readonly name: string }[]>> = [];
    k.provideModule('fixture.reader', {
      activate(ctx) {
        live.push(ctx.services.observeAll(Greeters));
      },
    });
    for (const id of ['a', 'b']) {
      k.provideModule(`fixture.${id}`, {
        activate(ctx) {
          ctx.services.provideMany(Greeters, () => ({ name: id }));
        },
      });
    }
    await k.add(manifest('fixture.reader', { optional: [Greeters.id] }), manifest('fixture.a', { contributesTo: [Greeters.id] }), manifest('fixture.b', { contributesTo: [Greeters.id] }));
    await k.manager.activate('fixture.reader'); // the contributors a and b activate before the reader
    const names = (): string[] => (live[0]?.get() ?? []).map((g) => g.name).toSorted();
    const snapshot = k.t.window.getAll(Greeters);
    expect(names()).toEqual(['a', 'b']);
    const seen: number[] = [];
    const sub = live[0]?.subscribe((value) => void seen.push(value.length));
    // a contributor that is installed and activated while the reader runs appears in the observable, not in the earlier snapshot
    let withdraw: { dispose(): void } | undefined;
    k.provideModule('fixture.c', { activate: (ctx) => void (withdraw = ctx.services.provideMany(Greeters, () => ({ name: 'late' }))) });
    await k.add(manifest('fixture.c', { contributesTo: [Greeters.id] }));
    await k.manager.activate('fixture.c');
    expect(names()).toEqual(['a', 'b', 'late']);
    withdraw?.dispose(); // and disappears again
    expect(names()).toEqual(['a', 'b']);
    expect(seen).toEqual([3, 2]);
    expect(snapshot.map((g) => g.name).toSorted()).toEqual(['a', 'b']); // getAll is a snapshot: it never changed
    sub?.dispose();
    await k.manager.deactivate('fixture.reader');
    expect(k.manager.liveDisposables('fixture.reader')).toEqual([]); // the observeAll subscription ended with the plugin
  });
});

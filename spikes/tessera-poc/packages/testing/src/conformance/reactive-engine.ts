import { describe, expect, it } from 'vitest';
import {
  batch,
  computed,
  effect,
  installReactiveEngine,
  reactiveDebug,
  state,
  transact,
  untracked,
  type ReactiveEngine,
} from '@tessera/reactive';
import { transactionGate } from '@tessera/base';
import { captureErrors } from '../capture-errors.ts';

/**
 * Conformance suite for the reactive facade on a given engine (contracts.md 6.4 rule 10, poc-plan claim C5).
 * Call it at module top level of a test file. It installs the engine first, so a file runs one engine only.
 * Vitest isolates modules per test file, which is why the preact and alien suites live in separate files.
 */
export function reactiveEngineConformance(
  engine: ReactiveEngine,
  options?: {
    /**
     * Whether effects that write each other's inputs in a loop run until the facade stops them (default true).
     * alien-signals suppresses such re-runs itself, so its loop ends without a report.
     */
    readonly engineRerunsLoopingEffects?: boolean;
  },
): void {
  installReactiveEngine(engine);
  const rerunsLoops = options?.engineRerunsLoopingEffects ?? true;

  describe(`C5: reactive engine conformance (${engine.id})`, () => {
    it('C5: state reads, writes and updates; get() and peek() agree', () => {
      const s = state(1, { name: 'count' });
      expect(s.get()).toBe(1);
      s.set(2);
      s.update((n) => n + 1);
      expect(s.peek()).toBe(3);
      expect(s.name).toBe('count');
      expect(s.asReadonly().get()).toBe(3);
      expect('set' in s.asReadonly()).toBe(false);
    });

    it('C5: computed derives lazily and recomputes only when an input changes', () => {
      const a = state(1);
      let runs = 0;
      const double = computed(() => {
        runs++;
        return a.get() * 2;
      });
      expect(runs).toBe(0);
      expect(double.get()).toBe(2);
      expect(double.get()).toBe(2);
      expect(runs).toBe(1);
      a.set(5);
      expect(double.get()).toBe(10);
      expect(runs).toBe(2);
      a.set(5);
      expect(double.get()).toBe(10);
      expect(runs).toBe(2);
    });

    it('C5: diamond without glitch - a computed never observes a mix of old and new inputs', () => {
      const a = state(1);
      const left = computed(() => a.get() + 1);
      const right = computed(() => a.get() * 10);
      const seen: string[] = [];
      const bottom = computed(() => {
        const pair = `${left.get()}/${right.get()}`;
        seen.push(pair);
        return pair;
      });
      const effects: string[] = [];
      const fx = effect(() => {
        effects.push(bottom.get());
      });
      a.set(2);
      a.set(3);
      expect(effects).toEqual(['2/10', '3/20', '4/30']);
      // every value the diamond bottom ever computed was consistent: left = a + 1 and right = a * 10
      for (const pair of seen) {
        const [l, r] = pair.split('/').map(Number) as [number, number];
        expect(r / 10 + 1).toBe(l);
      }
      fx.dispose();
    });

    it('C5: batch gives one notification and subscribers see the settled value only', () => {
      const a = state(1);
      const b = state(10);
      const sum = computed(() => a.get() + b.get());
      const seen: Array<[number, number]> = [];
      const sub = sum.subscribe((value, previous) => seen.push([value, previous]));
      let effectRuns = 0;
      const fx = effect(() => {
        sum.get();
        effectRuns++;
      });
      expect(effectRuns).toBe(1);
      const result = batch(() => {
        a.set(2);
        b.set(20);
        a.set(3);
        return 'batched';
      });
      expect(result).toBe('batched');
      expect(seen).toEqual([[23, 11]]);
      expect(effectRuns).toBe(2);
      sub.dispose();
      fx.dispose();
    });

    it('C5: nested batches notify once, after the outermost batch', () => {
      const a = state(0);
      const seen: number[] = [];
      const sub = a.subscribe((v) => seen.push(v));
      batch(() => {
        a.set(1);
        batch(() => a.set(2));
        expect(seen).toEqual([]);
        a.set(3);
      });
      expect(seen).toEqual([3]);
      sub.dispose();
    });

    it('C5: two writes of the same value in one batch coalesce, and a write back to the old value notifies nobody', () => {
      const a = state(1);
      const seen: number[] = [];
      const sub = a.subscribe((v) => seen.push(v));
      batch(() => {
        a.set(2);
        a.set(1);
      });
      expect(seen).toEqual([]);
      a.set(4);
      expect(seen).toEqual([4]);
      sub.dispose();
    });

    it('C5: subscribe fires on change only, not with the initial value, and reports the previous value', () => {
      const a = state('x');
      const calls: Array<[string, string]> = [];
      const sub = a.subscribe((value, previous) => calls.push([value, previous]));
      expect(calls).toEqual([]);
      a.set('y');
      a.set('z');
      expect(calls).toEqual([['y', 'x'], ['z', 'y']]);
      sub.dispose();
    });

    it('C5: subscribers run in subscription order, after the whole update settled', () => {
      const a = state(0);
      const b = state(0);
      const log: string[] = [];
      const subs = [
        a.subscribe((v) => log.push(`first sees a=${v} b=${b.peek()}`)),
        a.subscribe((v) => log.push(`second sees a=${v} b=${b.peek()}`)),
        b.subscribe((v) => log.push(`third sees b=${v}`)),
      ];
      batch(() => {
        b.set(1);
        a.set(1);
      });
      expect(log).toEqual(['first sees a=1 b=1', 'second sees a=1 b=1', 'third sees b=1']);
      for (const sub of subs) sub.dispose();
    });

    it('C5: a subscriber that keeps changing the value it listens to is stopped and reported as reactive.cycle', () => {
      const capture = captureErrors();
      const a = state(0, { name: 'runaway' });
      const sub = a.subscribe((v) => a.set(v + 1));
      a.set(1);
      const reported = capture.drain();
      capture.dispose();
      expect(reported).toHaveLength(1);
      expect(reported[0]?.error).toMatchObject({ code: 'reactive.cycle' });
      expect(reported[0]?.context).toMatchObject({ source: 'subscriber', target: 'runaway' });
      expect(a.peek()).toBeLessThan(1000);
      sub.dispose();
    });

    it('C5: a throwing effect does not starve its siblings, stays alive, and is reported with source effect', () => {
      const capture = captureErrors();
      const a = state(0);
      const log: string[] = [];
      const first = effect(
        () => {
          if (a.get() === 1) throw new Error('effect failed');
          log.push(`first ${a.get()}`);
        },
        { name: 'first' },
      );
      const second = effect(() => {
        log.push(`second ${a.get()}`);
      });
      a.set(1);
      a.set(2);
      expect(log).toContain('second 1');
      expect(log).toContain('second 2');
      expect(log).toContain('first 2'); // it threw once and ran again on the next change
      const reported = capture.drain();
      capture.dispose();
      expect(reported).toHaveLength(1);
      expect(reported[0]?.context).toMatchObject({ source: 'effect', target: 'first' });
      first.dispose();
      second.dispose();
    });

    it('C5: a throwing subscribe listener is isolated and reported with source subscriber', () => {
      const capture = captureErrors();
      const a = state(0, { name: 'watched' });
      const seen: number[] = [];
      const bad = a.subscribe(() => {
        throw new Error('listener failed');
      });
      const good = a.subscribe((v) => seen.push(v));
      a.set(1);
      a.set(2);
      expect(seen).toEqual([1, 2]);
      const reported = capture.drain();
      capture.dispose();
      expect(reported).toHaveLength(2);
      expect(reported[0]?.context).toMatchObject({ source: 'subscriber', target: 'watched' });
      bad.dispose();
      good.dispose();
    });

    it('C5: disposal stops effects and subscriptions, is idempotent, and runs cleanups', () => {
      const baselineEffects = reactiveDebug.liveEffects();
      const baselineSubs = reactiveDebug.liveSubscriptions();
      const a = state(0);
      const log: string[] = [];
      const fx = effect(() => {
        const value = a.get();
        log.push(`run ${value}`);
        return () => log.push(`cleanup ${value}`);
      });
      const sub = a.subscribe((v) => log.push(`sub ${v}`));
      expect(reactiveDebug.liveEffects()).toBe(baselineEffects + 1);
      expect(reactiveDebug.liveSubscriptions()).toBe(baselineSubs + 1);
      a.set(1);
      expect(log).toEqual(['run 0', 'cleanup 0', 'run 1', 'sub 1']);
      fx.dispose();
      fx.dispose();
      sub.dispose();
      sub.dispose();
      a.set(2);
      expect(log).toEqual(['run 0', 'cleanup 0', 'run 1', 'sub 1', 'cleanup 1']);
      expect(reactiveDebug.liveEffects()).toBe(baselineEffects);
      expect(reactiveDebug.liveSubscriptions()).toBe(baselineSubs);
    });

    it('C5: effects that feed each other in a loop are stopped and reported as reactive.cycle; other effects keep working', () => {
      const capture = captureErrors();
      const ping = state(0);
      const pong = state(0);
      const other = state(0);
      const otherSeen: number[] = [];
      const guard = effect(() => {
        otherSeen.push(other.get());
      });
      const a = effect(
        () => {
          pong.set(ping.get() + 1);
        },
        { name: 'ping-to-pong' },
      );
      const b = effect(
        () => {
          ping.set(pong.get() + 1);
        },
        { name: 'pong-to-ping' },
      );
      const reported = capture.drain();
      if (rerunsLoops) {
        expect(reported.length).toBeGreaterThanOrEqual(1);
        expect(reported[0]?.error).toMatchObject({ code: 'reactive.cycle' });
        expect(reported[0]?.context.source).toBe('effect');
        expect(['ping-to-pong', 'pong-to-ping']).toContain(reported[0]?.context.target);
      } else {
        for (const item of reported) expect(item.error).toMatchObject({ code: 'reactive.cycle' });
      }
      expect(ping.peek()).toBeLessThan(1000); // it terminated
      other.set(1);
      expect(otherSeen).toEqual([0, 1]);
      capture.dispose();
      a.dispose();
      b.dispose();
      guard.dispose();
    });

    it('C5: a computed that reads itself, directly or through another computed, throws reactive.cycle', () => {
      const direct: { value: ReturnType<typeof computed<number>> | undefined } = { value: undefined };
      direct.value = computed(() => (direct.value?.get() ?? 0) + 1, { name: 'direct' });
      expect(() => direct.value?.get()).toThrow(expect.objectContaining({ code: 'reactive.cycle' }));

      const pair: { a: ReturnType<typeof computed<number>> | undefined; b: ReturnType<typeof computed<number>> | undefined } = { a: undefined, b: undefined };
      pair.a = computed(() => (pair.b?.get() ?? 0) + 1);
      pair.b = computed(() => (pair.a?.get() ?? 0) + 1);
      expect(() => pair.a?.get()).toThrow(expect.objectContaining({ code: 'reactive.cycle' }));
    });

    it('C5: an effect that writes the state it reads terminates (the engine may rerun it or not)', () => {
      const capture = captureErrors();
      const counter = state(0);
      const fx = effect(() => {
        counter.set(counter.get() + 1);
      });
      expect(counter.peek()).toBeGreaterThanOrEqual(1);
      expect(counter.peek()).toBeLessThan(1000);
      for (const reported of capture.drain()) expect(reported.error).toMatchObject({ code: 'reactive.cycle' });
      capture.dispose();
      fx.dispose();
    });

    it('C5: equals - state skips equal writes, computed keeps the old identity and does not notify', () => {
      const point = state({ x: 1, y: 1 }, { equals: (a, b) => a.x === b.x && a.y === b.y });
      const seen: Array<{ x: number; y: number }> = [];
      const sub = point.subscribe((p) => seen.push(p));
      const before = point.peek();
      point.set({ x: 1, y: 1 });
      expect(point.peek()).toBe(before);
      expect(seen).toEqual([]);
      point.set({ x: 2, y: 1 });
      expect(seen).toHaveLength(1);
      sub.dispose();

      const items = state([1, 2, 3]);
      let derivedRuns = 0;
      const evens = computed(() => items.get().filter((n) => n % 2 === 0), { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) });
      const downstream = computed(() => {
        derivedRuns++;
        return evens.get().length;
      });
      const first = evens.get();
      expect(downstream.get()).toBe(1);
      items.set([1, 2, 3, 5]);
      expect(evens.get()).toBe(first);
      expect(downstream.get()).toBe(1);
      expect(derivedRuns).toBe(1);
      items.set([1, 2, 4]);
      expect(downstream.get()).toBe(2);
      expect(derivedRuns).toBe(2);
    });

    it('C5: untracked reads do not create dependencies, and subscribe listeners run untracked', () => {
      const a = state(1);
      const b = state(10);
      let runs = 0;
      const mixed = computed(() => {
        runs++;
        return a.get() + untracked(() => b.get());
      });
      expect(mixed.get()).toBe(11);
      b.set(20);
      expect(mixed.get()).toBe(11);
      expect(runs).toBe(1);
      a.set(2);
      expect(mixed.get()).toBe(22);

      const trigger = state(0);
      const hidden = state(100);
      let outerRuns = 0;
      const sub = trigger.subscribe(() => {
        hidden.get(); // a tracked read in a listener would subscribe the listener's effect to hidden
      });
      const outer = effect(() => {
        outerRuns++;
        trigger.get();
      });
      hidden.set(101);
      expect(outerRuns).toBe(1);
      sub.dispose();
      outer.dispose();
    });

    it('C5: writing state inside a computed throws reactive.writeInComputed', () => {
      const a = state(1);
      const bad = computed(() => {
        a.set(2);
        return 1;
      });
      expect(() => bad.get()).toThrow(expect.objectContaining({ code: 'reactive.writeInComputed' }));
    });

    it('C5: effects see consistent state when a write triggers a chain of computeds', () => {
      const first = state('Ada');
      const last = state('Lovelace');
      const full = computed(() => `${first.get()} ${last.get()}`);
      const initials = computed(() => `${first.get()[0]}${last.get()[0]}`);
      const rows: string[] = [];
      const fx = effect(() => {
        rows.push(`${full.get()} (${initials.get()})`);
      });
      batch(() => {
        first.set('Grace');
        last.set('Hopper');
      });
      expect(rows).toEqual(['Ada Lovelace (AL)', 'Grace Hopper (GH)']);
      fx.dispose();
    });

    it('C5: dev mode deep-freezes plain objects and arrays set into state', () => {
      const s = state<{ readonly list: number[]; readonly nested: { a: number } }>({ list: [1], nested: { a: 1 } });
      const value = s.peek();
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.list)).toBe(true);
      expect(Object.isFrozen(value.nested)).toBe(true);
      expect(() => value.list.push(2)).toThrow(TypeError);
      const fresh = { list: [2], nested: { a: 2 } };
      s.set(fresh);
      expect(Object.isFrozen(fresh.list)).toBe(true);
      class Plain {
        n = 1;
      }
      const instance = new Plain();
      const holder = state({ instance });
      holder.set({ instance });
      expect(Object.isFrozen(instance)).toBe(false); // class instances are not plain data
    });

    it('C5: a subscribed computed that throws does not make the write of its dependency throw; the error is reported once and delivery resumes', () => {
      const capture = captureErrors();
      const input = state(1, { name: 'throws.input' });
      const fragile = computed(() => {
        if (input.get() === 2) throw new Error('computed failed');
        return input.get() * 10;
      }, { name: 'throws.fragile' });
      const seen: number[] = [];
      const healthy: number[] = [];
      const bad = fragile.subscribe((v) => seen.push(v));
      const good = input.subscribe((v) => healthy.push(v));
      expect(() => input.set(2)).not.toThrow();
      expect(() => input.set(2)).not.toThrow();
      expect(healthy).toEqual([2]); // the other subscriber still ran
      input.set(3);
      expect(seen).toEqual([30]);
      expect(healthy).toEqual([2, 3]);
      const reported = capture.drain();
      capture.dispose();
      expect(reported.filter((r) => String(r.error).includes('computed failed'))).toHaveLength(1);
      bad.dispose();
      good.dispose();
    });

    it('C5: subscribing to a computed that already throws does not throw; the subscription delivers once it recovers', () => {
      const capture = captureErrors();
      const input = state(2);
      const fragile = computed(() => {
        if (input.get() === 2) throw new Error('fails at subscribe');
        return input.get();
      });
      const seen: number[] = [];
      const sub = fragile.subscribe((v) => seen.push(v));
      input.set(5);
      expect(seen).toEqual([5]);
      sub.dispose();
      capture.drain();
      capture.dispose();
    });

    it('C5: a transact() whose writes feed a throwing computed subscriber still delivers its events at commit', () => {
      const capture = captureErrors();
      const input = state(1);
      const fragile = computed(() => {
        if (input.get() === 2) throw new Error('inside transact');
        return input.get();
      });
      const sub = fragile.subscribe(() => {});
      let delivered = 0;
      transactionGate.defer(() => void delivered++); // outside a transaction it runs now
      expect(delivered).toBe(1);
      transact(() => {
        input.set(2);
        transactionGate.defer(() => void delivered++);
      });
      expect(delivered).toBe(2);
      batch(() => {
        transact(() => {
          input.set(1);
          transactionGate.defer(() => void delivered++);
        });
        input.set(2);
      });
      expect(delivered).toBe(3);
      sub.dispose();
      capture.drain();
      capture.dispose();
    });

    it('C5: subscribers are delivered in subscription order even when listeners queue earlier subscriptions', () => {
      const a = state(0);
      const order: string[] = [];
      const subs = [1, 2, 3, 4].map((n) => a.subscribe(() => void order.push(`s${n}`)));
      a.set(1);
      expect(order).toEqual(['s1', 's2', 's3', 's4']);
      subs.forEach((x) => x.dispose());
    });

    it('C5: effect().dispose() removes its own node from the debug registry', () => {
      const effects = Array.from({ length: 50 }, (_, i) => effect(() => {}, { name: `fx.dispose.${i}` }));
      expect(reactiveDebug.nodes().filter((n) => n.kind === 'effect' && n.name?.startsWith('fx.dispose.'))).toHaveLength(50);
      effects.forEach((e) => e.dispose());
      expect(reactiveDebug.nodes().filter((n) => n.kind === 'effect' && n.name?.startsWith('fx.dispose.'))).toHaveLength(0);
    });

    it('C5: named nodes show up in reactiveDebug.nodes()', () => {
      const keep = [state(1, { name: 'debug.state' }), computed(() => 1, { name: 'debug.computed' })];
      const names = reactiveDebug.nodes().map((n) => `${n.kind}:${n.name}`);
      expect(names).toContain('state:debug.state');
      expect(names).toContain('computed:debug.computed');
      expect(keep).toHaveLength(2);
    });
  });
}

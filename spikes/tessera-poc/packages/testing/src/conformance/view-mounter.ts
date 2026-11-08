import { afterEach, describe, expect, it } from 'vitest';
import { computed, reactiveDebug, state, type Observable, type State } from '@tessera/reactive';
import type { ContextKeyScope, MountTarget, Placement, PlacementId, PlacementStatus, Presenter, ViewInstanceId, ViewMounter, WindowId } from '@tessera/contracts';
import { toDisposable, type IDisposable } from '@tessera/base';
import { captureErrors } from '../capture-errors.ts';

/** The view types the suite mounts. The harness registers them in its renderer with `install()`. */
export const CONFORMANCE_COUNTER_VIEW = 'conformance.counter';
export const CONFORMANCE_BROKEN_VIEW = 'conformance.broken';

export interface ViewMounterHarness<E> {
  readonly mounter: ViewMounter<E>;
  createHost(): E;
  /**
   * Registers the two conformance views in the renderer:
   * - `conformance.counter` renders the text `count=<n>` from `viewState.count` and has one control that calls `intents.increment()`;
   * - `conformance.broken` throws while it renders.
   */
  install(): void | Promise<void>;
  /** The text a user would read in the host. */
  text(host: E): string;
  /** Activates the control of the counter view (a click, in a DOM). */
  press(host: E): void | Promise<void>;
  /** Lets the renderer finish pending work (React `act`, microtasks). */
  flush(): Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface CounterState {
  readonly count: number;
}
export interface CounterIntents {
  increment(): void;
}

/** A presenter with one shared counter. Two mounts of one presenter model two placements of one view instance. */
export class CounterPresenter implements Presenter<CounterState, CounterIntents> {
  readonly #count: State<number> = state(0, { name: 'conformance.count' });
  readonly viewState: Observable<CounterState> = computed(() => ({ count: this.#count.get() }), { name: 'conformance.viewState' });
  readonly intents: CounterIntents = { increment: () => this.#count.update((n) => n + 1) };
  get count(): number {
    return this.#count.peek();
  }
  dispose(): void {}
}

let seq = 0;

/** A Placement stand-in with the members a mounter reads. */
export function stubPlacement(viewType: string): Placement {
  const n = ++seq;
  const constant = <T>(value: T): Observable<T> => state(value).asReadonly();
  return {
    id: `p-conf-${n}` as PlacementId,
    viewType,
    instanceId: `i-conf-${n}` as ViewInstanceId,
    workspaceId: 'conformance',
    windowId: 'w-conf' as WindowId,
    status: constant<PlacementStatus>('attached'),
    visible: constant(true),
    focused: constant(false),
    title: constant(viewType),
    local: state<unknown>(undefined),
    context: { id: 'conformance', parent: undefined } as unknown as ContextKeyScope,
    presenter: undefined,
    scope: undefined,
    problem: undefined,
  };
}

export function stubTarget(viewType: string, presenter: Presenter, errors: unknown[] = []): MountTarget {
  const placement = stubPlacement(viewType);
  return {
    placement,
    presenter,
    context: {
      placement: { id: placement.id, viewType, instanceId: placement.instanceId, workspaceId: placement.workspaceId, windowId: placement.windowId },
      contextKeys: placement.context,
      services: { get: () => undefined, getAll: () => [], has: () => false } as never,
      executeCommand: async () => undefined as never,
      reportError: (error) => void errors.push(error),
    },
  };
}

/**
 * Conformance suite for the ViewMounter port (contracts.md 18.1). Run it against the React mounter and against any other
 * renderer: a new rendering adapter proves itself by passing it.
 */
export function viewMounterConformance<E>(name: string, create: () => ViewMounterHarness<E> | Promise<ViewMounterHarness<E>>): void {
  describe(`C27: ViewMounter conformance: ${name}`, () => {
    const live: ViewMounterHarness<E>[] = [];
    const mounts: IDisposable[] = [];
    afterEach(async () => {
      for (const m of mounts.splice(0).reverse()) m.dispose();
      for (const h of live.splice(0).reverse()) {
        await h.flush();
        await h.dispose?.();
      }
    });

    async function make(): Promise<ViewMounterHarness<E>> {
      const h = await create();
      live.push(h);
      await h.install();
      return h;
    }
    async function mountCounter(h: ViewMounterHarness<E>, presenter: Presenter, host: E = h.createHost()): Promise<E> {
      const mounted = h.mounter.mount(host, stubTarget(CONFORMANCE_COUNTER_VIEW, presenter));
      mounts.push(mounted);
      await h.flush();
      return host;
    }

    it('C27: the mounter has a renderer id, can mount the conformance views and refuses an unknown view type', async () => {
      const h = await make();
      expect(typeof h.mounter.rendererId).toBe('string');
      expect(await h.mounter.ensureUi(CONFORMANCE_COUNTER_VIEW)).toBe(true);
      expect(h.mounter.canMount(CONFORMANCE_COUNTER_VIEW)).toBe(true);
      expect(h.mounter.canMount('conformance.unknown')).toBe(false);
      expect(await h.mounter.ensureUi('conformance.unknown')).toBe(false);
    });

    it('C27: mount renders the initial viewState into the host', async () => {
      const h = await make();
      const host = await mountCounter(h, new CounterPresenter());
      expect(h.text(host)).toContain('count=0');
    });

    it('C27: a state change in the presenter reaches the host', async () => {
      const h = await make();
      const presenter = new CounterPresenter();
      const host = await mountCounter(h, presenter);
      presenter.intents.increment();
      await h.flush();
      expect(h.text(host)).toContain('count=1');
    });

    it('C27: an intent called by the view reaches the presenter, and the new state comes back to the host', async () => {
      const h = await make();
      const presenter = new CounterPresenter();
      const host = await mountCounter(h, presenter);
      await h.press(host);
      await h.flush();
      expect(presenter.count).toBe(1);
      expect(h.text(host)).toContain('count=1');
    });

    it('C27: two hosts of one presenter show one shared state (one view, two places)', async () => {
      const h = await make();
      const presenter = new CounterPresenter();
      const a = await mountCounter(h, presenter);
      const b = await mountCounter(h, presenter);
      await h.press(a);
      await h.flush();
      expect(h.text(a)).toContain('count=1');
      expect(h.text(b)).toContain('count=1');
      presenter.intents.increment();
      await h.flush();
      expect(h.text(a)).toContain('count=2');
      expect(h.text(b)).toContain('count=2');
    });

    it('C27: a mounted view holds at most one reactive subscription, and dispose releases it', async () => {
      const h = await make();
      const presenter = new CounterPresenter();
      // a warm-up mount first: a renderer may keep one shared subscription of its own (for example its root)
      await mountCounter(h, presenter);
      const before = reactiveDebug.liveSubscriptions();
      const host = h.createHost();
      const mounted = h.mounter.mount(host, stubTarget(CONFORMANCE_COUNTER_VIEW, presenter));
      await h.flush();
      expect(reactiveDebug.liveSubscriptions() - before).toBe(1);
      mounted.dispose();
      await h.flush();
      expect(reactiveDebug.liveSubscriptions()).toBe(before);
    });

    it('C27: dispose unmounts the view: the host is empty and later changes do not reach it', async () => {
      const h = await make();
      const presenter = new CounterPresenter();
      const host = h.createHost();
      const mounted = h.mounter.mount(host, stubTarget(CONFORMANCE_COUNTER_VIEW, presenter));
      await h.flush();
      expect(h.text(host)).toContain('count=0');
      mounted.dispose();
      await h.flush();
      expect(h.text(host).trim()).toBe('');
      presenter.intents.increment();
      await h.flush();
      expect(h.text(host).trim()).toBe('');
      mounted.dispose(); // idempotent
    });

    it('C27: a view that throws is contained and reported; its neighbour keeps working', async () => {
      const h = await make();
      const errors = captureErrors();
      const reported: unknown[] = [];
      const presenter = new CounterPresenter();
      const good = await mountCounter(h, presenter);
      const brokenHost = h.createHost();
      let mounted: IDisposable = toDisposable(() => undefined);
      expect(() => {
        mounted = h.mounter.mount(brokenHost, stubTarget(CONFORMANCE_BROKEN_VIEW, new CounterPresenter(), reported));
      }).not.toThrow();
      mounts.push(mounted);
      await h.flush();
      presenter.intents.increment();
      await h.flush();
      expect(h.text(good)).toContain('count=1');
      expect(reported.length + errors.errors.length).toBeGreaterThan(0);
      errors.drain();
      errors.dispose();
    });
  });
}

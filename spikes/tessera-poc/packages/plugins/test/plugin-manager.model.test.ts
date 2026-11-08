import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PluginState, type PluginModule } from '@tessera/contracts';
import { manifest } from '@tessera/testing';
import { PLUGIN_TRANSITIONS } from '@tessera/plugins';
import { captureErrors } from '@tessera/testing';
import { kit } from './kit.ts';

// Invariant I33 (model-based test of the plugin state machine, round 3). Three plugins: A provides a service, B requires it (so B depends
// on A), C stands alone. Random sequences of activate, deactivate, disable and enable run against the real manager; after every step the
// statuses equal a small model, no state change left the diagram of contracts 14.4 (the dev assertion reports plugin.invalidTransition, and
// the setup fails the test on any unexpected report), at most one activation of a plugin runs at a time, and a plugin that is not active
// owns no live registration.

const IDS = ['fixture.a', 'fixture.b', 'fixture.c'] as const;
type Id = (typeof IDS)[number];
type ModelState = 'resolved' | 'active' | 'disabled' | 'unresolved';

interface Op {
  readonly t: 'activate' | 'deactivate' | 'disable' | 'enable';
  readonly id: Id;
}
const opArb: fc.Arbitrary<Op> = fc.record({ t: fc.constantFrom('activate', 'deactivate', 'disable', 'enable'), id: fc.constantFrom(...IDS) });

/** The model: what the manager must show after each operation. B depends on A. */
class Model {
  readonly state: Record<Id, ModelState> = { 'fixture.a': 'resolved', 'fixture.b': 'resolved', 'fixture.c': 'resolved' };
  readonly captured = new Map<Id, Id[]>();

  #dependents(id: Id): Id[] {
    return id === 'fixture.a' ? ['fixture.b'] : [];
  }
  #settleUnresolved(): void {
    // B is unresolved while A is disabled, and resolved again when A is not (unless B is disabled itself)
    if (this.state['fixture.b'] !== 'disabled') {
      if (this.state['fixture.a'] === 'disabled') this.state['fixture.b'] = 'unresolved';
      else if (this.state['fixture.b'] === 'unresolved') this.state['fixture.b'] = 'resolved';
    }
  }

  apply(op: Op): void {
    const { id } = op;
    switch (op.t) {
      case 'activate':
        if (this.state[id] === 'disabled' || this.state[id] === 'unresolved') return;
        if (id === 'fixture.b') this.state['fixture.a'] = 'active';
        this.state[id] = 'active';
        return;
      case 'deactivate':
        for (const target of [id, ...this.#dependents(id)]) if (this.state[target] === 'active') this.state[target] = 'resolved';
        return;
      case 'disable': {
        if (this.state[id] === 'disabled') return;
        const live = [id, ...this.#dependents(id)].filter((t) => this.state[t] === 'active');
        this.captured.set(id, live);
        for (const t of live) this.state[t] = 'resolved';
        this.state[id] = 'disabled';
        this.#settleUnresolved();
        return;
      }
      case 'enable': {
        if (this.state[id] !== 'disabled') return;
        this.state[id] = 'resolved';
        this.#settleUnresolved();
        // contracts 14.12: what ran before the disable runs again, providers first
        for (const t of this.captured.get(id) ?? []) {
          if (this.state[t] !== 'resolved') continue;
          if (t === 'fixture.b') this.state['fixture.a'] = 'active'; // activating B activates its provider first
          this.state[t] = 'active';
        }
        this.captured.delete(id);
        return;
      }
    }
  }
}

async function run(ops: readonly Op[]): Promise<void> {
  const k = kit();
  const errors = captureErrors();
  const running = new Map<Id, number>();
  let overlap = false;
  const module = (id: Id): PluginModule => ({
    async activate(ctx) {
      running.set(id, (running.get(id) ?? 0) + 1);
      if ((running.get(id) ?? 0) > 1) overlap = true;
      ctx.api.commands.registerHandler(`${id}.run`, { run: () => id });
      await Promise.resolve();
      running.set(id, (running.get(id) ?? 1) - 1);
    },
  });
  for (const id of IDS) k.provideModule(id, module(id));
  await k.add(
    manifest('fixture.a', { provides: ['fixture/Svc'], contributes: { commands: [{ id: 'fixture.a.run', title: 'A' }] } }),
    manifest('fixture.b', { requires: ['fixture/Svc'], contributes: { commands: [{ id: 'fixture.b.run', title: 'B' }] } }),
    manifest('fixture.c', { contributes: { commands: [{ id: 'fixture.c.run', title: 'C' }] } }),
  );
  const model = new Model();
  const seen: Array<[string, string]> = [];
  const sub = k.manager.onDidChangeState((status) => void seen.push([status.id, status.state]));
  for (const op of ops) {
    model.apply(op);
    const call = op.t === 'activate' ? k.manager.activate(op.id) : op.t === 'deactivate' ? k.manager.deactivate(op.id) : op.t === 'disable' ? k.manager.disable(op.id) : k.manager.enable(op.id);
    await call.catch(() => undefined); // an activate of a disabled or unresolved plugin rejects: the model leaves it alone
    for (const id of IDS) {
      expect(k.manager.status(id)?.state, `${id} after ${JSON.stringify(op)}`).toBe(model.state[id]);
      if (model.state[id] !== 'active') expect(k.manager.liveDisposables(id), `${id} live registrations`).toEqual([]);
    }
  }
  expect(overlap).toBe(false);
  // every observed state is a state of the table (the dev assertion checks each edge as it happens)
  for (const [, state] of seen) expect(Object.keys(PLUGIN_TRANSITIONS)).toContain(state);
  expect(errors.drain().filter((e) => (e.error as { code?: string }).code === 'plugin.invalidTransition')).toEqual([]);
  errors.drain();
  errors.dispose();
  sub.dispose();
  await k.t.dispose();
  void PluginState;
}

describe('I33: the plugin state machine against a model (fast-check, ManualScheduler)', () => {
  it('random activate, deactivate, disable and enable sequences keep the statuses equal to the model and along the 14.4 diagram', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), run), { numRuns: 60 });
  }, 60_000);

  it('the transition table has no edge out of the diagram: nothing leaves Active except through Deactivating or Disabled', () => {
    expect([...PLUGIN_TRANSITIONS[PluginState.Active]].toSorted()).toEqual([PluginState.Deactivating, PluginState.Disabled].toSorted());
    expect([...PLUGIN_TRANSITIONS[PluginState.Activating]].toSorted()).toEqual([PluginState.Active, PluginState.Failed].toSorted());
  });
});

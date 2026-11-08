import { describe, expect, it } from 'vitest';
import { LifecyclePhase, LifecycleService, CoreTopics, EventNode } from '@tessera/contracts';
import { eventsModule } from '@tessera/events';
import { captureErrors, createTestScope } from '@tessera/testing';
import { lifecycleModule, type DefaultLifecycleService } from '@tessera/lifecycle';

function setup() {
  const t = createTestScope({ modules: [eventsModule, lifecycleModule] });
  return { t, lifecycle: t.application.get(LifecycleService) as DefaultLifecycleService };
}

describe('C13: lifecycle phases', () => {
  it('C13: starts in Starting and moves forward through Ready, Restored and Eventually', () => {
    const { lifecycle } = setup();
    const seen: LifecyclePhase[] = [lifecycle.phase.peek()];
    for (const phase of [LifecyclePhase.Ready, LifecyclePhase.Restored, LifecyclePhase.Eventually]) {
      lifecycle.setPhase(phase);
      seen.push(lifecycle.phase.peek());
    }
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('C13: phases never go backwards: a lower phase throws lifecycle.backwards and the phase stays', () => {
    const { lifecycle } = setup();
    lifecycle.setPhase(LifecyclePhase.Restored);
    expect(() => lifecycle.setPhase(LifecyclePhase.Ready)).toThrowError(expect.objectContaining({ code: 'lifecycle.backwards' }));
    expect(lifecycle.phase.peek()).toBe(LifecyclePhase.Restored);
    // the same phase again is a no-op, not an error
    lifecycle.setPhase(LifecyclePhase.Restored);
    expect(lifecycle.phase.peek()).toBe(LifecyclePhase.Restored);
  });

  it('C13: when(phase) resolves at once for a reached phase and only after setPhase for a later one', async () => {
    const { lifecycle } = setup();
    await lifecycle.when(LifecyclePhase.Starting);
    let ready = false;
    let restored = false;
    void lifecycle.when(LifecyclePhase.Ready).then(() => (ready = true));
    void lifecycle.when(LifecyclePhase.Restored).then(() => (restored = true));
    await Promise.resolve();
    expect([ready, restored]).toEqual([false, false]);
    lifecycle.setPhase(LifecyclePhase.Ready);
    await Promise.resolve();
    await Promise.resolve();
    expect([ready, restored]).toEqual([true, false]);
    // skipping a phase releases the barriers below it
    lifecycle.setPhase(LifecyclePhase.Eventually);
    await lifecycle.when(LifecyclePhase.Restored);
    expect(restored).toBe(true);
  });

  it('C13: each phase change is published as the sticky core topic', () => {
    const { t, lifecycle } = setup();
    const node = t.application.get(EventNode);
    const phases: number[] = [];
    node.subscribe(CoreTopics.lifecyclePhase, (e) => phases.push(e.phase));
    lifecycle.setPhase(LifecyclePhase.Ready);
    expect(phases).toEqual([LifecyclePhase.Ready]);
  });

  it('C13: a throwing event subscriber does not break setPhase', () => {
    const { t, lifecycle } = setup();
    const errors = captureErrors();
    t.application.get(EventNode).subscribe(CoreTopics.lifecyclePhase, () => {
      throw new Error('bad subscriber');
    });
    lifecycle.setPhase(LifecyclePhase.Ready);
    expect(lifecycle.phase.peek()).toBe(LifecyclePhase.Ready);
    expect(errors.drain().length).toBeGreaterThan(0);
    errors.dispose();
  });
});

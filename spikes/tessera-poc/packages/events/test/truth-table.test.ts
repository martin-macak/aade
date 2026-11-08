import { describe, expect, it } from 'vitest';
import { defineTopic, type EventNode, type PublishScope } from '@tessera/contracts';
import type { Delivery } from '@tessera/base';
import { tree, type Tree } from './kit.ts';

type Position = 'is N' | 'descendant of N' | 'ancestor of N' | 'elsewhere';

// Publication at N = root/tasks. Contracts 10.2: who receives it.
const subscriberAt: Record<Position, (t: Tree) => EventNode> = {
  'is N': (t) => t.tasks,
  'descendant of N': (t) => t.a,
  'ancestor of N': (t) => t.win,
  elsewhere: (t) => t.other,
};

const expected: Record<PublishScope, Record<Position, boolean>> = {
  global: { 'is N': true, 'descendant of N': true, 'ancestor of N': true, elsewhere: true },
  workItem: { 'is N': true, 'descendant of N': false, 'ancestor of N': false, elsewhere: false },
  descendants: { 'is N': true, 'descendant of N': true, 'ancestor of N': false, elsewhere: false },
};

const scopes: PublishScope[] = ['global', 'workItem', 'descendants'];
const positions: Position[] = ['is N', 'descendant of N', 'ancestor of N', 'elsewhere'];
const deliveries: Delivery[] = ['sync', 'microtask', 'idle'];

describe('C7: delivery truth table (contracts 10.2), generated matrix', () => {
  for (const scope of scopes) {
    for (const position of positions) {
      for (const delivery of deliveries) {
        it(`C7: publish scope ${scope}, subscriber ${position}, delivery ${delivery}: ${expected[scope][position] ? 'received' : 'not received'}`, () => {
          const t = tree();
          const topic = defineTopic<string>(`matrix.${scope}.${position}.${delivery}`);
          const received: string[] = [];
          t.tasks.subscribe(topic, () => {}, { delivery: 'sync' }).dispose();
          subscriberAt[position](t).subscribe(topic, (payload) => received.push(payload), { delivery });
          t.tasks.publish(topic, 'payload', { scope });
          if (delivery === 'sync') expect(received).toEqual(expected[scope][position] ? ['payload'] : []);
          else expect(received).toEqual([]); // queued: nothing before the scheduler runs
          t.t.scheduler.tick();
          expect(received).toEqual(expected[scope][position] ? ['payload'] : []);
        });
      }
    }
  }

  it('C7: the default publish scope is global', () => {
    const t = tree();
    const topic = defineTopic<number>('default.scope');
    const seen: string[] = [];
    for (const [name, node] of Object.entries({ app: t.app, win: t.win, tasks: t.tasks, a: t.a, b: t.b, other: t.other })) {
      node.subscribe(topic, () => seen.push(name));
    }
    t.a.publish(topic, 1);
    expect(seen).toEqual(['app', 'win', 'tasks', 'a', 'b', 'other']); // pre-order from the application root
  });

  it('C7: workItem scope on a sibling does not reach the other sibling, descendants reaches only below', () => {
    const t = tree();
    const topic = defineTopic<number>('siblings');
    const seen: string[] = [];
    t.a.subscribe(topic, () => seen.push('a'));
    t.b.subscribe(topic, () => seen.push('b'));
    t.tasks.subscribe(topic, () => seen.push('tasks'));
    t.a.publish(topic, 1, { scope: 'descendants' });
    expect(seen).toEqual(['a']);
    seen.length = 0;
    t.tasks.publish(topic, 1, { scope: 'descendants' });
    expect(seen).toEqual(['tasks', 'a', 'b']);
    seen.length = 0;
    t.tasks.publish(topic, 1, { scope: 'workItem' });
    expect(seen).toEqual(['tasks']);
  });

  it('C7: within a node, subscribers run in subscription order; nodes in pre-order', () => {
    const t = tree();
    const topic = defineTopic<number>('order');
    const seen: string[] = [];
    t.a.subscribe(topic, () => seen.push('a1'));
    t.tasks.subscribe(topic, () => seen.push('tasks1'));
    t.a.subscribe(topic, () => seen.push('a2'));
    t.tasks.subscribe(topic, () => seen.push('tasks2'));
    t.win.publish(topic, 1);
    expect(seen).toEqual(['tasks1', 'tasks2', 'a1', 'a2']);
  });

  it('C7: no subscriber on a topic means nothing happens; subscribers of other topics are not called', () => {
    const t = tree();
    const x = defineTopic<number>('x');
    const y = defineTopic<number>('y');
    const seen: string[] = [];
    t.tasks.subscribe(x, () => seen.push('x'));
    t.tasks.publish(y, 1);
    expect(seen).toEqual([]);
  });

  it('C7: a disposed node no longer receives, and publishing on it is ignored', () => {
    const t = tree();
    const topic = defineTopic<number>('disposed');
    const seen: string[] = [];
    t.a.subscribe(topic, () => seen.push('a'));
    (t.a as unknown as { dispose(): void }).dispose();
    t.tasks.publish(topic, 1, { scope: 'descendants' });
    t.a.publish(topic, 1);
    expect(seen).toEqual([]);
    expect(t.bus.node('root/tasks/project-a')).toBeUndefined();
    expect(t.bus.node('root/tasks')).toBe(t.tasks);
  });
});

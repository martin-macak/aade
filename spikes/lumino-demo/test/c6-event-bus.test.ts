import { Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventNode } from '../src/cap6-event-bus.ts';

const Ping = new Token<string>('ping');

/** root > tasks > (project-a, project-b), and a sibling branch root > other. */
function tree() {
  const root = new EventNode('root');
  const tasks = root.createChild('tasks');
  const a = tasks.createChild('project-a');
  const b = tasks.createChild('project-b');
  const other = root.createChild('other');
  const heard: Record<string, string[]> = {};
  for (const node of [root, tasks, a, b, other]) {
    heard[node.name] = [];
    node.subscribe(Ping, (payload) => heard[node.name]!.push(payload));
  }
  return { root, tasks, a, b, other, heard };
}

describe('C6 event bus scoped to WorkItems', () => {
  // Lumino's Signal logs a throwing slot through its exception handler; keep the output quiet and observable.
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('C6: a global publication reaches every node, from any publisher', () => {
    const { a, heard } = tree();
    a.publish(Ping, 'g', 'global');
    expect(heard).toEqual({ root: ['g'], tasks: ['g'], 'project-a': ['g'], 'project-b': ['g'], other: ['g'] });
  });

  it('C6: a workItem publication reaches only the publishing node', () => {
    const { tasks, heard } = tree();
    tasks.publish(Ping, 'w', 'workItem');
    expect(heard).toEqual({ root: [], tasks: ['w'], 'project-a': [], 'project-b': [], other: [] });
  });

  it('C6: a descendants publication reaches the publisher and everything below it, not siblings or ancestors', () => {
    const { tasks, heard } = tree();
    tasks.publish(Ping, 'd', 'descendants');
    expect(heard).toEqual({ root: [], tasks: ['d'], 'project-a': ['d'], 'project-b': ['d'], other: [] });
  });

  it('C6: the default scope is global', () => {
    const { b, heard } = tree();
    b.publish(Ping, 'x');
    expect(Object.values(heard).flat()).toHaveLength(5);
  });

  it('C6: a subscriber that throws does not stop the other subscribers (Lumino Signal isolates slots)', () => {
    const root = new EventNode('root');
    const seen: string[] = [];
    root.subscribe(Ping, () => {
      throw new Error('bad subscriber');
    });
    root.subscribe(Ping, (p) => seen.push(p));
    expect(() => root.publish(Ping, 'still-delivered')).not.toThrow();
    expect(seen).toEqual(['still-delivered']);
    expect(console.error).toHaveBeenCalled();
  });

  it('C6: unsubscribe works, and a disposed node leaves the tree and hears nothing', () => {
    const { root, tasks, a, heard } = tree();
    const sub = a.subscribe(Ping, () => void heard['project-a']!.push('extra'));
    sub.dispose();
    root.publish(Ping, '1');
    expect(heard['project-a']).toEqual(['1']);
    tasks.dispose(); // takes project-a and project-b with it
    expect(tasks.isDisposed && a.isDisposed).toBe(true);
    expect([...root.walk()].map((n) => n.name)).toEqual(['root', 'other']);
    root.publish(Ping, '2');
    expect(heard['project-a']).toEqual(['1']);
    a.publish(Ping, 'ignored'); // a disposed node does not publish
    expect(heard['root']).toEqual(['1', '2']);
    expect(Signal.getExceptionHandler()).toBeTypeOf('function');
  });
});

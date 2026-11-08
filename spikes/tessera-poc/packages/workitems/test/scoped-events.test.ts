import { describe, expect, it } from 'vitest';
import { defineTopic, EventNode, type EventNode as EventNodeType, type PublishScope } from '@tessera/contracts';
import { kit } from './kit.ts';

// Demo item 6: an event bus scoped to WorkItems. Tree: root/tasks with root/tasks/project-a and root/tasks/project-b, plus root/other.
function tree() {
  const k = kit();
  const tasks = k.service.root.createChild('tasks');
  const a = tasks.createChild('project-a');
  const b = tasks.createChild('project-b');
  const other = k.service.root.createChild('other');
  const nodes: Record<string, EventNodeType> = {
    app: k.bus.root,
    root: k.service.root.events,
    tasks: tasks.events,
    a: a.events,
    b: b.events,
    other: other.events,
  };
  return { k, tasks, a, b, other, nodes };
}

function receivers(nodes: Record<string, EventNodeType>, publishOn: string, scope: PublishScope | undefined): string[] {
  const topic = defineTopic<string>(`wi.scoped.${publishOn}.${scope ?? 'default'}`);
  const got: string[] = [];
  for (const [name, node] of Object.entries(nodes)) node.subscribe(topic, () => got.push(name));
  nodes[publishOn]!.publish(topic, 'x', scope === undefined ? undefined : { scope });
  return got.toSorted();
}

describe('C8: scoped events through WorkItem event nodes (global, workItem, descendants)', () => {
  it('C8: publish on root/tasks with scope workItem reaches only root/tasks', () => {
    const { nodes } = tree();
    expect(receivers(nodes, 'tasks', 'workItem')).toEqual(['tasks']);
  });

  it('C8: publish on root/tasks with scope descendants reaches root/tasks and both projects, not the parent or siblings', () => {
    const { nodes } = tree();
    expect(receivers(nodes, 'tasks', 'descendants')).toEqual(['a', 'b', 'tasks']);
  });

  it('C8: publish on root/tasks with scope global reaches every node, including ancestors and other branches', () => {
    const { nodes } = tree();
    expect(receivers(nodes, 'tasks', 'global')).toEqual(['a', 'app', 'b', 'other', 'root', 'tasks']);
    expect(receivers(nodes, 'tasks', undefined)).toEqual(['a', 'app', 'b', 'other', 'root', 'tasks']);
  });

  it('C8: publish on project-a with scope descendants does not reach project-b (sibling)', () => {
    const { nodes } = tree();
    expect(receivers(nodes, 'a', 'descendants')).toEqual(['a']);
    expect(receivers(nodes, 'a', 'workItem')).toEqual(['a']);
    expect(receivers(nodes, 'a', 'global')).toEqual(['a', 'app', 'b', 'other', 'root', 'tasks']);
  });

  it('C8: inject(EventNode) in a WorkItem scope is the node of that WorkItem, so plugin code needs no node plumbing', () => {
    const { tasks, a, k } = tree();
    const topic = defineTopic<number>('wi.inject');
    const seen: string[] = [];
    tasks.scope.run(() => {
      tasks.scope.get(EventNode).subscribe(topic, () => seen.push('tasks'));
    });
    a.scope.get(EventNode).subscribe(topic, () => seen.push('a'));
    a.scope.get(EventNode).publish(topic, 1, { scope: 'workItem' });
    expect(seen).toEqual(['a']);
    k.service.root.events.publish(topic, 2, { scope: 'descendants' });
    expect(seen).toEqual(['a', 'tasks', 'a']);
  });

  it('C8: a terminated WorkItem stops receiving; the others still do', async () => {
    const { nodes, a } = tree();
    const topic = defineTopic<number>('wi.after.terminate');
    const got: string[] = [];
    nodes['a']!.subscribe(topic, () => got.push('a'));
    nodes['b']!.subscribe(topic, () => got.push('b'));
    await a.terminate();
    nodes['tasks']!.publish(topic, 1, { scope: 'descendants' });
    expect(got).toEqual(['b']);
  });
});

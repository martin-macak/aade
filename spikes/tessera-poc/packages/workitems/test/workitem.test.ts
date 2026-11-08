import { describe, expect, it, vi } from 'vitest';
import { TesseraError, type StateSchema } from '@tessera/base';
import { inject, token } from '@tessera/di';
import { CurrentWorkItem, defineTopic, EventNode, StorageService, WorkItemService, type WorkItem } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { kit } from './kit.ts';

describe('C8: a WorkItem owns a DI scope, an event node and a context-key scope', () => {
  it('C8: the root WorkItem is the window: window DI scope, window event node, context-key scope "window"', () => {
    const k = kit();
    const root = k.service.root;
    expect(root.path).toBe('root');
    expect(root.parent).toBeUndefined();
    expect(root.scope).toBe(k.t.window);
    expect(root.events).toBe(k.t.window.get(EventNode));
    expect(root.context.id).toBe('window');
    expect(root.context.parent).toBe(k.keys.root);
    expect(root.status.peek()).toBe('active');
    expect(k.t.window.get(CurrentWorkItem)).toBe(root);
  });

  it('C8: a child has a workItem DI scope below its parent, an event node below the parent node and a context-key scope below the parent scope', () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('project-a');
    expect(a.path).toBe('root/tasks/project-a');
    expect(a.parent).toBe(tasks);
    expect(a.scope.kind).toBe('workItem');
    expect(a.scope.parent).toBe(tasks.scope);
    expect(a.events.parent).toBe(tasks.events);
    expect(a.events.id).toBe(a.scope.path);
    expect(k.bus.node(a.scope.path)).toBe(a.events);
    expect(a.context.parent).toBe(tasks.context);
    expect(tasks.child('project-a')).toBe(a);
    expect(tasks.children.peek()).toEqual([a]);
  });

  it('C8: CurrentWorkItem and EventNode resolve child first from the WorkItem scope', () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('project-a');
    expect(a.scope.get(CurrentWorkItem)).toBe(a);
    expect(tasks.scope.get(CurrentWorkItem)).toBe(tasks);
    expect(a.scope.get(EventNode)).toBe(a.events);
    expect(a.scope.get(WorkItemService)).toBe(k.service);
  });

  it('C8: services are registered in the new scope before the controller starts; start() runs once in the injection context', async () => {
    const k = kit();
    const Model = token<{ n: number }>('test.model');
    const order: string[] = [];
    const start = vi.fn(async (wi: WorkItem) => {
      order.push('start');
      expect(inject(Model).n).toBe(42);
      expect(inject(CurrentWorkItem)).toBe(wi);
    });
    const child = k.service.root.createChild('tasks', {
      services: (scope) => {
        order.push('services');
        scope.provideValue(Model, { n: 42 });
      },
      controller: { start },
    });
    expect(order).toEqual(['services', 'start']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(child.scope.get(Model).n).toBe(42);
    expect(k.t.window.has(Model)).toBe(false);
    await child.terminate();
  });

  it('C8: an id must match the pattern; a duplicate sibling id throws workItem.duplicate', () => {
    const k = kit();
    k.service.root.createChild('tasks');
    expect(() => k.service.root.createChild('tasks')).toThrow(expect.objectContaining({ code: 'workItem.duplicate' }));
    for (const bad of ['', 'Tasks', '-x', 'a b', 'a/b']) {
      expect(() => k.service.root.createChild(bad)).toThrow(expect.objectContaining({ code: 'validation' }));
    }
    expect(k.service.root.children.peek().map((c) => c.id)).toEqual(['tasks']);
  });

  it('C8: the service finds WorkItems by path and announces creation and termination', async () => {
    const k = kit();
    const created: string[] = [];
    const terminated: string[] = [];
    k.service.onDidCreate((w) => created.push(w.path));
    k.service.onDidTerminate((w) => terminated.push(w.path));
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    expect(k.service.find('root')).toBe(k.service.root);
    expect(k.service.find('root/tasks/a')).toBe(a);
    expect(k.service.find('root/nope')).toBeUndefined();
    await tasks.terminate();
    expect(created).toEqual(['root/tasks', 'root/tasks/a']);
    expect(terminated).toEqual(['root/tasks/a', 'root/tasks']);
    expect(k.service.find('root/tasks/a')).toBeUndefined();
  });
});

describe('C8: activation (CAB rule: one active child per parent)', () => {
  it('C8: a new WorkItem is inactive unless activate is true; the root is always active', () => {
    const k = kit();
    const a = k.service.root.createChild('a');
    const b = k.service.root.createChild('b', { activate: true });
    expect(a.status.peek()).toBe('inactive');
    expect(b.status.peek()).toBe('active');
    k.service.root.deactivate();
    expect(k.service.root.status.peek()).toBe('active');
  });

  it('C8: activate() deactivates the active sibling and activates the ancestors', () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    const b = tasks.createChild('b');
    const other = k.service.root.createChild('other', { activate: true });
    expect(other.status.peek()).toBe('active');
    a.activate();
    expect(a.status.peek()).toBe('active');
    expect(tasks.status.peek()).toBe('active');
    expect(other.status.peek()).toBe('inactive');
    b.activate();
    expect(a.status.peek()).toBe('inactive');
    expect(b.status.peek()).toBe('active');
    expect(tasks.status.peek()).toBe('active');
  });

  it('C8: deactivate() deactivates the WorkItem and its active descendants', () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    a.activate();
    tasks.deactivate();
    expect(tasks.status.peek()).toBe('inactive');
    expect(a.status.peek()).toBe('inactive');
  });

  it('C8: context keys: workItem.active in the WorkItem scope, activeWorkItem in the window scope', () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    expect(k.service.root.context.evaluate('activeWorkItem == root')).toBe(true);
    expect(a.context.evaluate('workItem.active')).toBe(false);
    a.activate();
    expect(a.context.evaluate('workItem.active')).toBe(true);
    expect(tasks.context.evaluate('workItem.active')).toBe(true);
    expect(k.service.root.context.getValue('activeWorkItem')).toBe('root/tasks/a');
    tasks.deactivate();
    expect(a.context.evaluate('workItem.active')).toBe(false);
    expect(k.service.root.context.getValue('activeWorkItem')).toBe('root');
  });

  it('C8: service.active is the deepest active WorkItem and reacts to changes', () => {
    const k = kit();
    const seen: Array<string | undefined> = [];
    expect(k.service.active.peek()).toBe(k.service.root);
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    a.activate();
    seen.push(k.service.active.peek()?.path);
    tasks.deactivate();
    seen.push(k.service.active.peek()?.path);
    expect(seen).toEqual(['root/tasks/a', 'root']);
  });

  it('C8: controller onActivate and onDeactivate run on real changes only; their errors are reported', () => {
    const k = kit();
    const errors = captureErrors();
    const calls: string[] = [];
    const wi = k.service.root.createChild('x', {
      controller: {
        start: () => {},
        onActivate: () => {
          calls.push('on');
          throw new Error('boom');
        },
        onDeactivate: () => calls.push('off'),
      },
    });
    wi.activate();
    wi.activate();
    wi.deactivate();
    wi.deactivate();
    expect(calls).toEqual(['on', 'off']);
    expect(errors.drain()).toHaveLength(1);
    errors.dispose();
  });
});

describe('C8: terminate()', () => {
  it('C8: terminates children first, then the event node, the context-key scope and the DI scope', async () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a');
    const log: string[] = [];
    // record real calls, keep real behaviour
    const wrap = (name: string, wi: WorkItem): void => {
      const node = wi.events as unknown as { dispose(): void };
      const nodeDispose = node.dispose.bind(node);
      node.dispose = () => {
        log.push(`node:${name}`);
        nodeDispose();
      };
      const ctxDispose = wi.context.dispose.bind(wi.context);
      wi.context.dispose = () => {
        log.push(`context:${name}`);
        ctxDispose();
      };
      wi.scope.onWillDispose(() => log.push(`di:${name}`));
    };
    wrap('tasks', tasks);
    wrap('a', a);
    k.service.onDidTerminate((w) => log.push(`status:${w.path}:${w.status.peek()}`));
    await tasks.terminate();
    expect(log).toEqual([
      'status:root/tasks/a:terminated',
      'node:a',
      'context:a',
      'di:a',
      'status:root/tasks:terminated',
      'node:tasks',
      'context:tasks',
      'di:tasks',
    ]);
    expect(a.scope.state).toBe('disposed');
    expect(tasks.scope.state).toBe('disposed');
    expect(k.bus.node(a.scope.path)).toBeUndefined();
  });

  it('C8: terminate is idempotent and final; a terminated WorkItem leaves the tree and refuses use', async () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks', { activate: true });
    const first = tasks.terminate();
    expect(tasks.terminate()).toBe(first);
    await first;
    await tasks.terminate();
    expect(tasks.status.peek()).toBe('terminated');
    expect(k.service.root.children.peek()).toEqual([]);
    expect(k.service.root.context.getValue('activeWorkItem')).toBe('root');
    expect(k.service.active.peek()).toBe(k.service.root);
    expect(() => tasks.activate()).toThrow(expect.objectContaining({ code: 'workItem.terminated' }));
    expect(() => tasks.createChild('x')).toThrow(expect.objectContaining({ code: 'workItem.terminated' }));
    // the id can be reused after termination
    expect(k.service.root.createChild('tasks').status.peek()).toBe('inactive');
  });

  it('C8: terminating disposes what the WorkItem scope owns (reverse creation order) and drops its subscriptions', async () => {
    const k = kit();
    const log: string[] = [];
    const tasks = k.service.root.createChild('tasks', {
      services: (scope) => {
        for (const n of ['one', 'two']) {
          const T = token<{ dispose(): void }>(`test.owned.${n}`);
          scope.provide(T, () => ({ dispose: () => log.push(n) }));
        }
      },
    });
    const topic = defineTopic<number>('test.wi.terminate');
    const seen: number[] = [];
    tasks.events.subscribe(topic, (n) => seen.push(n));
    // resolve in order one, two
    for (const n of ['one', 'two']) tasks.scope.get(token<{ dispose(): void }>(`test.owned.${n}`));
    tasks.events.publish(topic, 1);
    await tasks.terminate();
    expect(log).toEqual(['two', 'one']);
    k.service.root.events.publish(topic, 2, { scope: 'descendants' });
    expect(seen).toEqual([1]);
  });

  it('C8: a failing services callback leaves nothing behind', () => {
    const k = kit();
    expect(() =>
      k.service.root.createChild('bad', {
        services: () => {
          throw new Error('no services');
        },
      }),
    ).toThrow('no services');
    expect(k.service.root.children.peek()).toEqual([]);
    expect(k.service.find('root/bad')).toBeUndefined();
    expect(k.bus.node(`${k.t.window.path}/workItem:bad`)).toBeUndefined();
    expect(k.t.window.has(CurrentWorkItem)).toBe(true);
  });

  it('C8: a controller that throws or rejects is reported; the WorkItem stays usable', async () => {
    const k = kit();
    const errors = captureErrors();
    const sync = k.service.root.createChild('sync', {
      controller: {
        start: () => {
          throw new Error('sync start');
        },
      },
    });
    const asyncItem = k.service.root.createChild('async', { controller: { start: () => Promise.reject(new Error('async start')) } });
    await Promise.resolve();
    await Promise.resolve();
    const reported = errors.drain();
    expect(reported.map((r) => (r.error as Error).message).toSorted()).toEqual(['async start', 'sync start']);
    expect(sync.status.peek()).toBe('inactive');
    expect(asyncItem.status.peek()).toBe('inactive');
    errors.dispose();
  });

  it('C8: disposing the window DI scope terminates the whole tree (nothing leaks: leakCheck runs after the test)', async () => {
    const k = kit();
    const tasks = k.service.root.createChild('tasks');
    const a = tasks.createChild('a', { activate: true });
    await k.t.dispose();
    expect(a.status.peek()).toBe('terminated');
    expect(tasks.status.peek()).toBe('terminated');
    expect(k.service.root.status.peek()).toBe('terminated');
  });
});

describe('C8: mementos', () => {
  it("C8: memento() uses the project storage scope and the key 'workItem:<path>:<key>'", () => {
    const k = kit();
    const calls: Array<{ scope: string; key: string }> = [];
    k.t.window.provideValue(StorageService, {
      memento: (scope: string, key: string) => {
        calls.push({ scope, key });
        return {} as never;
      },
    } as never);
    const schema = { version: 1 } as unknown as StateSchema<{ filter: string }>;
    const tasks = k.service.root.createChild('tasks');
    tasks.createChild('a').memento('filter', schema);
    k.service.root.memento('layout', schema);
    expect(calls).toEqual([
      { scope: 'project', key: 'workItem:root/tasks/a:filter' },
      { scope: 'project', key: 'workItem:root:layout' },
    ]);
  });

  it('C8: TesseraError type is used for WorkItem failures', () => {
    const k = kit();
    k.service.root.createChild('x');
    try {
      k.service.root.createChild('x');
    } catch (error) {
      expect(error).toBeInstanceOf(TesseraError);
    }
  });
});

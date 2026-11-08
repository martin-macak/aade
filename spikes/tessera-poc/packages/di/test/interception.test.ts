import { afterEach, describe, expect, it } from 'vitest';
import { createRootScope, token, type Scope, type ServiceCall, type ServiceInterceptionHook } from '@tessera/di';

class TaskApi {
  #secret = 'private state';
  readonly #calls: string[] = [];
  readonly label = 'task api';

  async load(id: string): Promise<string> {
    this.#calls.push(`load ${id}`);
    return `${this.#secret}:${id}`;
  }

  async save(title: string, done: boolean): Promise<{ title: string; done: boolean }> {
    this.#calls.push(`save ${title}`);
    return { title, done };
  }

  peek(): string {
    return `${this.#secret} peeked`; // not listed: runs untouched, but still sees #private members
  }

  get calls(): readonly string[] {
    return this.#calls;
  }

  broken(): number {
    return 42; // listed by mistake: not async
  }
}
const Api = token<TaskApi>('test.api');

describe('C4: DI interception is opt-in and limited to listed async methods', () => {
  const roots: Scope[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await r.dispose();
  });
  const rootWith = (hook: ServiceInterceptionHook | undefined): Scope => {
    const root = createRootScope(hook ? { interception: hook } : {});
    roots.push(root);
    return root;
  };

  it('C4: only listed methods go through the hook; the rest pass through', async () => {
    const calls: ServiceCall[] = [];
    const root = rootWith(async (call, invoke) => {
      calls.push(call);
      return invoke(call.args);
    });
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['load'] } });
    const api = root.get(Api);
    await expect(api.load('t1')).resolves.toBe('private state:t1');
    await expect(api.save('write', true)).resolves.toEqual({ title: 'write', done: true });
    expect(api.peek()).toBe('private state peeked');
    expect(api.label).toBe('task api');
    expect(calls.map((c) => c.method)).toEqual(['load']);
    expect(calls[0]).toMatchObject({ tokenId: 'test.api', args: ['t1'], scopePath: root.path });
  });

  it('C4: #private members still work for listed and unlisted methods and getters, because calls run on the target', async () => {
    const root = rootWith(async (call, invoke) => invoke(call.args));
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['load', 'save'] } });
    const api = root.get(Api);
    await api.load('x');
    await api.save('y', false);
    expect(api.peek()).toBe('private state peeked');
    expect(api.calls).toEqual(['load x', 'save y']);
  });

  it('C4: the hook can replace the arguments, answer by itself, or wrap the result', async () => {
    let mode: 'rewrite' | 'skip' | 'wrap' = 'rewrite';
    const root = rootWith(async (call, invoke) => {
      if (mode === 'rewrite') return invoke(['rewritten']);
      if (mode === 'skip') return 'answered by the hook';
      return `wrapped(${String(await invoke(call.args))})`;
    });
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['load'] } });
    const api = root.get(Api);
    await expect(api.load('original')).resolves.toBe('private state:rewritten');
    mode = 'skip';
    await expect(api.load('original')).resolves.toBe('answered by the hook');
    expect(api.calls).toEqual(['load rewritten']);
    mode = 'wrap';
    await expect(api.load('a')).resolves.toBe('wrapped(private state:a)');
  });

  it('C4: a listed method that returns a non-promise fails with di.interceptSync', async () => {
    const root = rootWith(async (call, invoke) => invoke(call.args));
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['broken'] } });
    const api = root.get(Api);
    await expect(Promise.resolve().then(() => (api.broken as unknown as () => Promise<number>)())).rejects.toMatchObject({ code: 'di.interceptSync' });
  });

  it('C4: a registration without intercept.methods is never wrapped, even when a hook is installed', () => {
    const calls: string[] = [];
    const root = rootWith(async (call, invoke) => {
      calls.push(call.method);
      return invoke(call.args);
    });
    const instance = new TaskApi();
    root.provide(Api, () => instance);
    expect(root.get(Api)).toBe(instance);
    expect(calls).toEqual([]);
  });

  it('C4: without a hook the listed methods are not wrapped either', () => {
    const root = rootWith(undefined);
    const instance = new TaskApi();
    root.provide(Api, () => instance, { intercept: { methods: ['load'] } });
    expect(root.get(Api)).toBe(instance);
  });

  it('C4: the hook of the root applies in child scopes, and the call reports the scope path of the instance home', async () => {
    const calls: ServiceCall[] = [];
    const root = rootWith(async (call, invoke) => {
      calls.push(call);
      return invoke(call.args);
    });
    const window = root.createChild('window', 'w');
    window.provide(Api, () => new TaskApi(), { intercept: { methods: ['load'] } });
    const child = window.createChild('workItem', 'tasks');
    await child.get(Api).load('z');
    expect(calls[0]?.scopePath).toBe(window.path);
  });

  it('C4: consumers see a stable proxy; methods keep their identity between reads', () => {
    const root = rootWith(async (call, invoke) => invoke(call.args));
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['load'] } });
    const api = root.get(Api);
    expect(root.get(Api)).toBe(api);
    expect(api.load).toBe(api.load);
    expect(api.peek).toBe(api.peek);
  });

  it('a hook that rejects rejects the caller', async () => {
    const root = rootWith(async () => {
      throw new Error('denied by hook');
    });
    root.provide(Api, () => new TaskApi(), { intercept: { methods: ['load'] } });
    await expect(root.get(Api).load('a')).rejects.toThrow('denied by hook');
  });
});

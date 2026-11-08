import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Schema } from '@tessera/base';
import { declare, kit } from './kit.ts';

describe('C11: arguments are validated with the handler\'s Schema<T>', () => {
  const addArgs: Schema<{ title: string; count: number }> = {
    safeParse: (input) => {
      const value = input as { title?: unknown; count?: unknown } | undefined;
      const issues = [];
      if (typeof value?.title !== 'string') issues.push({ path: ['title'], message: 'title must be a string' });
      if (typeof value?.count !== 'number') issues.push({ path: ['count'], message: 'count must be a number' });
      return issues.length > 0 ? { success: false, error: { issues } } : { success: true, data: { title: value?.title as string, count: value?.count as number } };
    },
  };

  it('C11: invalid args reject with command.invalidArgs and the issues; the handler does not run', async () => {
    const k = kit();
    let ran = false;
    declare(k, 'tasks.add');
    k.registry.registerHandler('tasks.add', { args: addArgs, run: () => (ran = true) });
    const error = (await k.commands.execute('tasks.add', { title: 3 }).catch((e: unknown) => e)) as { code: string; message: string; details: { issues: Array<{ path: string[] }> } };
    expect(error.code).toBe('command.invalidArgs');
    expect(error.message).toContain('title: title must be a string');
    expect(error.message).toContain('count: count must be a number');
    expect(error.details.issues.map((i) => i.path)).toEqual([['title'], ['count']]);
    expect(ran).toBe(false);
  });

  it('C11: valid args are passed on, as parsed by the schema', async () => {
    const k = kit();
    declare(k, 'tasks.add');
    k.registry.registerHandler('tasks.add', { args: addArgs, run: (args: { title: string; count: number }) => `${args.title} x${args.count}` });
    await expect(k.commands.execute('tasks.add', { title: 'a', count: 2, extra: 'dropped by the schema' })).resolves.toBe('a x2');
  });

  it('C11: a zod 4 schema satisfies Schema<T> as it is, including transforms and defaults', async () => {
    const k = kit();
    const schema = z.object({ title: z.string().min(1), tags: z.array(z.string()).default([]), count: z.coerce.number() });
    const typed: Schema<z.infer<typeof schema>> = schema;
    declare(k, 'tasks.add');
    k.registry.registerHandler('tasks.add', { args: typed, run: (args: z.infer<typeof schema>) => args });
    await expect(k.commands.execute('tasks.add', { title: 'x', count: '4' })).resolves.toEqual({ title: 'x', tags: [], count: 4 });
    await expect(k.commands.execute('tasks.add', { title: '', count: 1 })).rejects.toMatchObject({ code: 'command.invalidArgs' });
  });

  it('C11: validation runs before the enablement check', async () => {
    const k = kit();
    declare(k, 'tasks.add', { enablement: 'never' });
    k.registry.registerHandler('tasks.add', { args: addArgs, run: () => 1 });
    await expect(k.commands.execute('tasks.add', {})).rejects.toMatchObject({ code: 'command.invalidArgs' });
    await expect(k.commands.execute('tasks.add', { title: 'a', count: 1 })).rejects.toMatchObject({ code: 'command.disabled' });
  });

  it('C11: handlers without a schema receive the args untouched', async () => {
    const k = kit();
    const payload = { anything: [1, 2, 3] };
    k.registry.registerHandler('x', { run: (args: unknown) => args });
    await expect(k.commands.execute('x', payload)).resolves.toBe(payload);
  });
});

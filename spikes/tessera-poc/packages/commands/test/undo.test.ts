import { describe, expect, it } from 'vitest';
import type { UndoEntry } from '@tessera/contracts';
import { DefaultUndoService } from '@tessera/commands';
import { DeferredPromise } from '@tessera/base';
import { effect } from '@tessera/reactive';
import { captureErrors } from '@tessera/testing';
import { declare, kit } from './kit.ts';

function entry(log: string[], name: string, resource = 'doc:1', extra?: Partial<UndoEntry>): UndoEntry {
  return {
    label: name,
    code: `test.${name}`,
    resource,
    undo: () => void log.push(`undo ${name}`),
    redo: () => void log.push(`redo ${name}`),
    ...extra,
  };
}

describe('C11: undo and redo', () => {
  it('C11: an undo entry pushed by a command handler can be undone and redone', async () => {
    const k = kit();
    const log: string[] = [];
    declare(k, 'tasks.complete', { owner: 'sample.tasks' });
    k.registry.registerHandler('tasks.complete', { run: (_a, ctx) => ctx.pushUndo(entry(log, 'complete', 'view:tasks')) }, 'sample.tasks');
    const canUndo = k.undo.canUndo('view:tasks');
    const canRedo = k.undo.canRedo('view:tasks');
    expect(canUndo.peek()).toBe(false);
    await k.commands.execute('tasks.complete');
    expect(canUndo.peek()).toBe(true);
    await expect(k.undo.undo('view:tasks')).resolves.toBe(true);
    expect(log).toEqual(['undo complete']);
    expect(canUndo.peek()).toBe(false);
    expect(canRedo.peek()).toBe(true);
    await expect(k.undo.redo('view:tasks')).resolves.toBe(true);
    expect(log).toEqual(['undo complete', 'redo complete']);
    expect(canRedo.peek()).toBe(false);
  });

  it('C11: invalidateOwner drops the entries of a deactivated plugin; they are skipped and never run', async () => {
    const k = kit();
    const log: string[] = [];
    declare(k, 'tasks.complete', { owner: 'sample.tasks' });
    k.registry.registerHandler('tasks.complete', { run: (_a, ctx) => ctx.pushUndo(entry(log, 'complete', 'view:tasks')) }, 'sample.tasks');
    k.registry.registerHandler('other', { run: (_a, ctx) => ctx.pushUndo(entry(log, 'other', 'view:tasks')) }, 'sample.other');
    await k.commands.execute('other');
    await k.commands.execute('tasks.complete');
    const canUndo = k.undo.canUndo('view:tasks');
    const seen: boolean[] = [];
    const fx = effect(() => void seen.push(canUndo.get()));
    k.undo.invalidateOwner('sample.tasks');
    await expect(k.undo.undo('view:tasks')).resolves.toBe(true); // skips the invalid entry and undoes the other plugin's
    expect(log).toEqual(['undo other']);
    await expect(k.undo.undo('view:tasks')).resolves.toBe(false);
    expect(seen).toEqual([true, false]); // still undoable after the owner's entry became invalid, then empty
    fx.dispose();
  });

  it('C11: a new push clears the redo stack of the resource', async () => {
    const k = kit();
    const log: string[] = [];
    k.undo.push(entry(log, 'one'));
    await k.undo.undo('doc:1');
    expect(k.undo.canRedo('doc:1').peek()).toBe(true);
    k.undo.push(entry(log, 'two'));
    expect(k.undo.canRedo('doc:1').peek()).toBe(false);
    await expect(k.undo.redo('doc:1')).resolves.toBe(false);
  });

  it('undo and redo return false when there is nothing to do; stacks are per resource', async () => {
    const k = kit();
    const log: string[] = [];
    k.undo.push(entry(log, 'a', 'doc:a'));
    await expect(k.undo.undo('doc:b')).resolves.toBe(false);
    await expect(k.undo.redo('doc:a')).resolves.toBe(false);
    await expect(k.undo.undo('doc:a')).resolves.toBe(true);
  });

  it('entries undo in reverse order of pushing', async () => {
    const k = kit();
    const log: string[] = [];
    for (const name of ['a', 'b', 'c']) k.undo.push(entry(log, name));
    while (await k.undo.undo('doc:1')) {
      // keep undoing
    }
    expect(log).toEqual(['undo c', 'undo b', 'undo a']);
    while (await k.undo.redo('doc:1')) {
      // keep redoing
    }
    expect(log.slice(3)).toEqual(['redo a', 'redo b', 'redo c']);
  });

  it('group() merges the pushes inside into one entry that undoes in reverse and redoes in order', async () => {
    const k = kit();
    const log: string[] = [];
    await k.undo.group('rename everywhere', async () => {
      k.undo.push(entry(log, 'one'));
      await Promise.resolve();
      k.undo.push(entry(log, 'two'));
      k.undo.push(entry(log, 'three'));
    });
    await k.undo.undo('doc:1');
    expect(log).toEqual(['undo three', 'undo two', 'undo one']);
    await expect(k.undo.undo('doc:1')).resolves.toBe(false); // one entry for the whole group
    await k.undo.redo('doc:1');
    expect(log.slice(3)).toEqual(['redo one', 'redo two', 'redo three']);
  });

  it('a group with one push is that push; an empty group pushes nothing; the group returns fn\'s value', async () => {
    const k = kit();
    const log: string[] = [];
    await expect(k.undo.group('empty', async () => 'value')).resolves.toBe('value');
    expect(k.undo.canUndo('doc:1').peek()).toBe(false);
    await k.undo.group('single', async () => k.undo.push(entry(log, 'only')));
    await k.undo.undo('doc:1');
    expect(log).toEqual(['undo only']);
  });

  it('group() pushes what was collected even when fn throws', async () => {
    const k = kit();
    const log: string[] = [];
    await expect(
      k.undo.group('g', async () => {
        k.undo.push(entry(log, 'done before the error'));
        throw new Error('then it failed');
      }),
    ).rejects.toThrow('then it failed');
    expect(k.undo.canUndo('doc:1').peek()).toBe(true);
  });

  it('a multi-resource entry needs all its resources on top', async () => {
    const k = kit();
    const log: string[] = [];
    k.undo.push(entry(log, 'both', 'doc:a', { extraResources: ['doc:b'] }));
    k.undo.push(entry(log, 'only b', 'doc:b'));
    await expect(k.undo.undo('doc:a')).resolves.toBe(false); // doc:b has a newer entry on top
    await expect(k.undo.undo('doc:b')).resolves.toBe(true);
    await expect(k.undo.undo('doc:a')).resolves.toBe(true);
    expect(log).toEqual(['undo only b', 'undo both']);
    expect(k.undo.canRedo('doc:a').peek()).toBe(true);
    expect(k.undo.canRedo('doc:b').peek()).toBe(true);
  });

  it('confirmBeforeUndo asks first; a declined confirmation keeps the entry', async () => {
    const asked: string[] = [];
    let answer = false;
    const service = new DefaultUndoService({
      confirm: async (e) => {
        asked.push(e.label);
        return answer;
      },
    });
    const log: string[] = [];
    service.push(entry(log, 'risky', 'doc:1', { confirmBeforeUndo: true }));
    service.push(entry(log, 'harmless', 'doc:1'));
    await service.undo('doc:1');
    expect(asked).toEqual([]);
    await expect(service.undo('doc:1')).resolves.toBe(false);
    expect(log).toEqual(['undo harmless']);
    answer = true;
    await expect(service.undo('doc:1')).resolves.toBe(true);
    expect(asked).toEqual(['risky', 'risky']);
    expect(log).toEqual(['undo harmless', 'undo risky']);
  });

  it('clear(resource) drops both stacks', async () => {
    const k = kit();
    k.undo.push(entry([], 'x'));
    k.undo.clear('doc:1');
    expect(k.undo.canUndo('doc:1').peek()).toBe(false);
  });

  it('an entry whose undo throws is reported (undo.failed), stays on its stack, and the error reaches the caller', async () => {
    const k = kit();
    const capture = captureErrors();
    k.undo.push({ ...entry([], 'bad'), code: 'test.bad', undo: () => { throw new Error('undo failed'); } }, { owner: 'sample.tasks' });
    await expect(k.undo.undo('doc:1')).rejects.toThrow('undo failed');
    expect(k.undo.canUndo('doc:1').peek()).toBe(true); // a failed step does not delete the user's history (round 2)
    expect(k.undo.canRedo('doc:1').peek()).toBe(false);
    const reported = capture.drain()[0];
    expect(reported?.context).toMatchObject({ target: 'test.bad', pluginId: 'sample.tasks' });
    expect(reported?.error).toMatchObject({ code: 'undo.failed' });
    capture.dispose();
  });
});

describe('C11: steps are serialized per resource (undo-step-not-serialized)', () => {
  it('C11: two concurrent undo() calls on one resource run in order: the newest first, each entry once', async () => {
    const service = new DefaultUndoService();
    const log: string[] = [];
    const gate = new DeferredPromise<void>();
    service.push({ ...entry(log, 'A'), undo: async () => (await gate.promise, void log.push('undo A')) });
    service.push({ ...entry(log, 'B'), undo: async () => (log.push('start B'), await gate.promise, void log.push('undo B')) });
    const first = service.undo('doc:1');
    const second = service.undo('doc:1');
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['start B']); // A has not started: the second step waits for the first
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(log).toEqual(['start B', 'undo B', 'undo A']);
  });

  it('C11: a double undo with confirm asks once per entry and runs each entry once', async () => {
    const asked: string[] = [];
    const answer = new DeferredPromise<boolean>();
    const service = new DefaultUndoService({
      confirm: async (e) => {
        asked.push(e.label);
        return answer.promise;
      },
    });
    const log: string[] = [];
    service.push(entry(log, 'older'));
    service.push(entry(log, 'risky', 'doc:1', { confirmBeforeUndo: true }));
    const a = service.undo('doc:1');
    const b = service.undo('doc:1');
    await Promise.resolve();
    await Promise.resolve();
    answer.resolve(true);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(asked).toEqual(['risky']);
    expect(log).toEqual(['undo risky', 'undo older']);
  });

  it('C11: after the confirmation the entry must still be on top: a new edit during the dialog cancels the step', async () => {
    const answer = new DeferredPromise<boolean>();
    const service = new DefaultUndoService({ confirm: () => answer.promise });
    const log: string[] = [];
    service.push(entry(log, 'risky', 'doc:1', { confirmBeforeUndo: true }));
    const pending = service.undo('doc:1');
    await Promise.resolve();
    service.push(entry(log, 'newer')); // typed while the dialog is open
    answer.resolve(true);
    await expect(pending).resolves.toBe(false);
    expect(log).toEqual([]); // risky did not run
    await expect(service.undo('doc:1')).resolves.toBe(true);
    expect(log).toEqual(['undo newer']);
  });

  it('C11: undo steps on different resources do not wait for each other', async () => {
    const service = new DefaultUndoService();
    const log: string[] = [];
    const gate = new DeferredPromise<void>();
    service.push({ ...entry(log, 'slow', 'doc:a'), undo: async () => (await gate.promise, void log.push('undo slow')) });
    service.push(entry(log, 'quick', 'doc:b'));
    const slow = service.undo('doc:a');
    await expect(service.undo('doc:b')).resolves.toBe(true);
    expect(log).toEqual(['undo quick']);
    gate.resolve();
    await slow;
  });
});

describe('C11: history limit (unbounded-undo-and-audit-history)', () => {
  it('C11: the oldest entry is dropped beyond the limit and an emptied stack is deleted', async () => {
    const service = new DefaultUndoService({ limit: 3 });
    const log: string[] = [];
    for (let i = 1; i <= 5; i++) service.push(entry(log, `e${i}`));
    for (let i = 0; i < 5; i++) await service.undo('doc:1');
    expect(log).toEqual(['undo e5', 'undo e4', 'undo e3']);
    expect(service.canUndo('doc:1').peek()).toBe(false);
  });

  it('C11: a multi-resource entry dropped by the limit leaves no half entry behind', async () => {
    const service = new DefaultUndoService({ limit: 1 });
    const log: string[] = [];
    service.push(entry(log, 'both', 'doc:a', { extraResources: ['doc:b'] }));
    service.push(entry(log, 'newer a', 'doc:a'));
    expect(service.canUndo('doc:b').peek()).toBe(false); // 'both' is gone from doc:b as well
    await service.undo('doc:a');
    expect(log).toEqual(['undo newer a']);
  });

  it('C11: the default limit is 100', async () => {
    const service = new DefaultUndoService();
    const log: string[] = [];
    for (let i = 0; i < 150; i++) service.push(entry(log, `e${i}`));
    let count = 0;
    while (await service.undo('doc:1')) count++;
    expect(count).toBe(100);
  });
});

import { describe, expect, it } from 'vitest';
import { UndoOwnerCheck, type UndoEntry } from '@tessera/contracts';
import { DefaultUndoService } from '@tessera/commands';
import { DeferredPromise } from '@tessera/base';
import { captureErrors } from '@tessera/testing';
import { declare, kit } from './kit.ts';

function entry(log: string[], name: string, resource = 'doc:1', extra?: Partial<UndoEntry>): UndoEntry {
  return { label: name, code: `test.${name}`, resource, undo: () => void log.push(`undo ${name}`), redo: () => void log.push(`redo ${name}`), ...extra };
}

describe('round 2: undo steps', () => {
  it('C11: an undo that runs a command through its step context does not record itself', async () => {
    const k = kit();
    const log: string[] = [];
    declare(k, 'doc.restore', { owner: 'sample.doc' });
    k.registry.registerHandler(
      'doc.restore',
      {
        run: (_a, ctx) => {
          log.push('restore ran');
          ctx.pushUndo(entry(log, 'selfRecord', 'doc:1')); // an ordinary run records; a run from an undo step must not
        },
      },
      'sample.doc',
    );
    k.undo.push({ ...entry(log, 'edit'), undo: async (step) => void (await step?.execute('doc.restore')) });
    expect(await k.undo.undo('doc:1')).toBe(true);
    expect(log).toEqual(['restore ran']);
    expect(k.undo.canUndo('doc:1').peek()).toBe(false); // the command did not push a new entry
    expect(k.undo.canRedo('doc:1').peek()).toBe(true);
    await k.commands.execute('doc.restore'); // outside a step it records as usual
    expect(k.undo.canUndo('doc:1').peek()).toBe(true);
  });

  it('C11: a step that never settles times out after 10 s (undo.timeout), releases the lock and keeps the entry', async () => {
    const k = kit();
    const capture = captureErrors();
    const log: string[] = [];
    const never = new DeferredPromise<void>();
    let hang = true;
    k.undo.push({ ...entry(log, 'slow'), undo: () => (hang ? never.promise : void log.push('undo slow')) });
    const first = k.undo.undo('doc:1').then(() => 'resolved', (e: unknown) => (e as { code?: string }).code);
    await Promise.resolve();
    const second = k.undo.undo('doc:1'); // waits for the lock
    k.t.scheduler.advance(10_000);
    expect(await first).toBe('undo.timeout');
    hang = false;
    expect(await second).toBe(true); // the lock was released and the entry was still there
    expect(log).toEqual(['undo slow']);
    expect(capture.drain().map((r) => (r.error as { code?: string }).code)).toContain('undo.timeout');
    capture.dispose();
    never.resolve();
  });

  it('C11: a failed redo keeps the entry on the redo stack', async () => {
    const k = kit();
    const capture = captureErrors();
    let fail = true;
    k.undo.push({ ...entry([], 'r'), redo: () => { if (fail) throw new Error('redo broke'); } });
    await k.undo.undo('doc:1');
    await expect(k.undo.redo('doc:1')).rejects.toThrow('redo broke');
    expect(k.undo.canRedo('doc:1').peek()).toBe(true);
    fail = false;
    expect(await k.undo.redo('doc:1')).toBe(true);
    capture.drain();
    capture.dispose();
  });
});

describe('round 2: owners of undo entries', () => {
  it('C11: a merged group keeps every owner: invalidating the second owner invalidates the entry', async () => {
    const service = new DefaultUndoService();
    await service.group('both', async () => {
      service.push(entry([], 'a'), { owner: 'plugin.one' });
      service.push(entry([], 'b'), { owner: 'plugin.two' });
    });
    expect(service.canUndo('doc:1').peek()).toBe(true);
    service.invalidateOwner('plugin.two');
    expect(service.canUndo('doc:1').peek()).toBe(false);
  });

  it('C11: push refuses an owner that is not live (undo.ownerGone); the plugin manager provides the check', async () => {
    const service = new DefaultUndoService({ isOwnerLive: (owner) => owner !== 'plugin.gone' });
    expect(() => service.push(entry([], 'late'), { owner: 'plugin.gone' })).toThrowError(expect.objectContaining({ code: 'undo.ownerGone' }));
    service.push(entry([], 'ok'), { owner: 'plugin.alive' });
    service.push(entry([], 'core')); // no owner: always fine
    expect(service.canUndo('doc:1').peek()).toBe(true);
    void UndoOwnerCheck;
  });

  it('C11: clear(resource, { owner }) drops only that owner’s entries', async () => {
    const service = new DefaultUndoService();
    service.push(entry([], 'mine'), { owner: 'plugin.one' });
    service.push(entry([], 'theirs'), { owner: 'plugin.two' });
    service.clear('doc:1', { owner: 'plugin.one' });
    expect(service.canUndo('doc:1').peek()).toBe(true);
    expect(await service.undo('doc:1')).toBe(true);
    expect(service.canUndo('doc:1').peek()).toBe(false);
    service.push(entry([], 'again'), { owner: 'plugin.two' });
    service.clear('doc:1');
    expect(service.canUndo('doc:1').peek()).toBe(false);
  });
});

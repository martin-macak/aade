import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '@tessera/base';
import { captureErrors, createTestScope } from '@tessera/testing';
import { DefaultUndoService } from '@tessera/commands';
import type { UndoEntry } from '@tessera/contracts';

const entry = (code: string, order: string[], extra: Partial<UndoEntry> = {}): UndoEntry => ({
  label: code,
  code,
  resource: 'doc',
  undo: async () => void order.push(`undo ${code}`),
  redo: async () => void order.push(`redo ${code}`),
  ...extra,
});

describe('undo-step-failure-and-self-record: an edit during a running step is applied in order when the step ends', () => {
  it('failure path: B stays on top of A, the new edit C lands above B: the next undos run C, then B', async () => {
    createTestScope({ flat: true });
    const errors = captureErrors();
    const undo = new DefaultUndoService();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    undo.push(entry('A', order));
    undo.push(
      entry('B', order, {
        undo: async () => {
          order.push('undo B');
          await gate.promise;
          throw new Error('boom');
        },
      }),
    );
    const failing = undo.undo('doc'); // starts undo B
    await Promise.resolve();
    await Promise.resolve();
    undo.push(entry('C', order)); // the user edits while B's step runs
    expect(undo.canUndo('doc').peek()).toBe(true);
    gate.resolve();
    await failing.catch(() => undefined);
    order.length = 0;
    await undo.undo('doc').catch(() => undefined); // C first
    await undo.undo('doc').catch(() => undefined); // then B (fails again, stays)
    expect(order.slice(0, 2)).toEqual(['undo C', 'undo B']);
    errors.drain();
    errors.dispose();
  });

  it('success path: the undone entry moves to redo, the new edit clears redo, so canRedo is false afterwards', async () => {
    createTestScope({ flat: true });
    const undo = new DefaultUndoService();
    const order: string[] = [];
    const gate = new DeferredPromise<void>();
    undo.push(entry('B', order, { undo: async () => { order.push('undo B'); await gate.promise; } }));
    const running = undo.undo('doc');
    await Promise.resolve();
    await Promise.resolve();
    undo.push(entry('C', order));
    gate.resolve();
    expect(await running).toBe(true);
    expect(undo.canRedo('doc').peek()).toBe(false); // the new edit C cleared the redo stack that B's entry went to
    expect(undo.canUndo('doc').peek()).toBe(true);
    expect(await undo.undo('doc')).toBe(true);
    expect(order).toEqual(['undo B', 'undo C']);
  });
});

import { describe, expect, it } from 'vitest';
import { AuditLog, AuditPresenter, createAuditViewModel, type AuditViewIntents, type AuditViewState } from '../src/audit-log.ts';
import { manifest } from '../src/manifest.ts';

describe('C18: audit.log presenter', () => {
  it('C18: viewState counts commands, events and errors and keeps the last 200 entries', () => {
    const log = new AuditLog();
    const presenter = new AuditPresenter(createAuditViewModel(log));
    const state = (): AuditViewState => presenter.viewState.peek();
    expect(state()).toMatchObject({ commands: 0, events: 0, errors: 0, entries: [] });
    log.record({ kind: 'command', target: 'a', source: 'api', outcome: 'ok', durationMs: 1, detail: undefined });
    log.record({ kind: 'command', target: 'b', source: 'api', outcome: 'error', durationMs: 1, detail: 'boom' });
    log.record({ kind: 'event', target: 't', source: 'global', outcome: 'published', durationMs: 0, detail: 'app' });
    expect(state()).toMatchObject({ commands: 2, events: 1, errors: 1 });
    expect(state().entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (let i = 0; i < 250; i++) log.record({ kind: 'event', target: 't', source: 'global', outcome: 'published', durationMs: 0, detail: undefined });
    expect(state().entries).toHaveLength(200);
  });

  it('C18: intent clear empties the log; every intent is tested', () => {
    const log = new AuditLog();
    const presenter = new AuditPresenter(createAuditViewModel(log));
    log.record({ kind: 'command', target: 'a', source: 'api', outcome: 'ok', durationMs: 0, detail: undefined });
    (presenter.intents as AuditViewIntents).clear();
    expect(presenter.viewState.peek().entries).toEqual([]);
    expect(Object.keys(presenter.intents)).toEqual(['clear']);
  });

  it('C18: the manifest declares the guard interceptor and asks for the guard capability', () => {
    expect(manifest.capabilities).toEqual(['interceptors.guard']);
    const ids = ((manifest.contributes?.['interceptors'] ?? []) as Array<{ id: string; mode?: string }>).map((i) => `${i.id}:${i.mode ?? 'observer'}`);
    expect(ids).toEqual(['audit.commands:observer', 'audit.events:observer', 'audit.closeGuard:guard']);
  });
});

describe('C18: the audit log is a ring buffer (unbounded-undo-and-audit-history)', () => {
  it('C18: it keeps the last 1000 entries by default and the sequence keeps counting; clear empties it', () => {
    const log = new AuditLog();
    const entry = { kind: 'command', target: 't', source: 'api', outcome: 'ok', durationMs: 0, detail: undefined } as const;
    for (let i = 0; i < 1500; i++) log.record(entry);
    const all = log.entries.peek();
    expect(all).toHaveLength(1000);
    expect(all[0]?.seq).toBe(501);
    expect(all.at(-1)?.seq).toBe(1500);
    log.clear();
    expect(log.entries.peek()).toEqual([]);
    log.record(entry);
    expect(log.entries.peek()[0]?.seq).toBe(1501);
  });

  it('C18: a subscriber is told when the buffer changes, and a read between changes returns the same array', () => {
    const log = new AuditLog(3);
    const seen: number[] = [];
    const sub = log.entries.subscribe((list) => seen.push(list.length));
    const entry = { kind: 'event', target: 't', source: 'global', outcome: 'published', durationMs: 0, detail: undefined } as const;
    for (let i = 0; i < 5; i++) log.record(entry);
    expect(seen).toEqual([1, 2, 3, 3, 3]);
    expect(log.entries.peek()).toBe(log.entries.peek());
    sub.dispose();
  });
});

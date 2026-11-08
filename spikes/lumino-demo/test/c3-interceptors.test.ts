import { CommandRegistry } from '@lumino/commands';
import { Token } from '@lumino/coreutils';
import { Menu } from '@lumino/widgets';
import { describe, expect, it, vi } from 'vitest';
import { EventNode } from '../src/cap6-event-bus.ts';
import { GuardedCommandRegistry, Interceptors, observeCommands, VetoError, type CallRecord } from '../src/cap3-interceptors.ts';

const Ping = new Token<string>('ping');

describe('C3 interceptors', () => {
  it('C3: native observer: commandExecuted gives an audit record with timing for sync, async and failing commands', async () => {
    const commands = new CommandRegistry();
    const records: CallRecord[] = [];
    observeCommands(commands, (r) => records.push(r));
    commands.addCommand('ok', { execute: () => 1 });
    commands.addCommand('slow', { execute: () => new Promise((resolve) => setTimeout(resolve, 30)) });
    commands.addCommand('bad', { execute: () => { throw new Error('nope'); } });
    await commands.execute('ok');
    await commands.execute('slow');
    await expect(commands.execute('bad')).rejects.toThrow('nope');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(records.map((r) => [r.id, r.outcome])).toEqual([['ok', 'ok'], ['slow', 'ok'], ['bad', 'error']]);
    expect(records.find((r) => r.id === 'slow')!.durationMs).toBeGreaterThanOrEqual(25);
  });

  it('C3: native observer: an unregistered command is rejected and NEVER reaches commandExecuted (no audit record)', async () => {
    const commands = new CommandRegistry();
    const records: CallRecord[] = [];
    observeCommands(commands, (r) => records.push(r));
    await expect(commands.execute('missing')).rejects.toThrow(/not registered/);
    expect(records).toEqual([]);
  });

  it('C3: disposing the observer stops the records', async () => {
    const commands = new CommandRegistry();
    const records: CallRecord[] = [];
    const sub = observeCommands(commands, (r) => records.push(r));
    commands.addCommand('x', { execute: () => 1 });
    await commands.execute('x');
    sub.dispose();
    await commands.execute('x');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(records).toHaveLength(1);
  });

  it('C3: around advice on events (our bus): timing, and a guard can block delivery', () => {
    const interceptors = new Interceptors();
    const root = new EventNode('root', null, interceptors.eventHook);
    const seen: string[] = [];
    root.subscribe(Ping, (p) => seen.push(p));
    const timings: number[] = [];
    interceptors.add((call, next) => {
      const t0 = performance.now();
      try {
        return next();
      } finally {
        if (call.kind === 'event') timings.push(performance.now() - t0);
      }
    });
    const guard = interceptors.add((call, next) => {
      if (call.kind === 'event' && call.args === 'blocked') throw new VetoError('blocked by guard');
      return next();
    });
    root.publish(Ping, 'fine');
    expect(() => root.publish(Ping, 'blocked')).toThrow(VetoError);
    expect(seen).toEqual(['fine']);
    expect(timings).toHaveLength(2);
    guard.dispose(); // a disposed interceptor no longer applies
    root.publish(Ping, 'blocked');
    expect(seen).toEqual(['fine', 'blocked']);
  });

  it('C3: an interceptor that fails before calling next is skipped and reported; the call still happens', () => {
    const onError = vi.fn();
    const interceptors = new Interceptors(onError);
    const root = new EventNode('root', null, interceptors.eventHook);
    const seen: string[] = [];
    root.subscribe(Ping, (p) => seen.push(p));
    interceptors.add(() => {
      throw new Error('broken interceptor');
    });
    root.publish(Ping, 'delivered');
    expect(seen).toEqual(['delivered']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('C3: GAP: around advice / veto on commands needs a CommandRegistry subclass, and it only guards what is routed through it', async () => {
    const interceptors = new Interceptors();
    const guarded = new GuardedCommandRegistry(interceptors);
    const plain = new CommandRegistry(); // stands for `app.commands`, which Application creates itself and cannot be replaced
    const calls: string[] = [];
    for (const registry of [guarded, plain]) registry.addCommand('danger', { label: 'Danger', execute: () => void calls.push('ran') });
    interceptors.add((call, next) => {
      if (call.kind === 'command' && call.id === 'danger') throw new VetoError('vetoed');
      return next();
    });
    await expect(guarded.execute('danger')).rejects.toThrow(VetoError);
    expect(calls).toEqual([]);
    // A Menu given the guarded registry really routes its trigger through `execute`, so the guard applies to menus and palettes too.
    guarded.addCommand('fine', { label: 'Fine', execute: () => void calls.push('fine') });
    // Menu.triggerActiveItem calls `commands.execute(...)` and drops the returned promise, so a vetoed or failing command becomes an
    // unhandled rejection. The test keeps hold of the promises to assert on them (and to keep the run clean).
    const rejected: unknown[] = [];
    const execute = guarded.execute.bind(guarded);
    guarded.execute = (id, args) => {
      const promise = execute(id, args);
      promise.catch((error: unknown) => void rejected.push(error));
      return promise;
    };
    const menu = new Menu({ commands: guarded });
    menu.addItem({ type: 'command', command: 'danger' });
    menu.addItem({ type: 'command', command: 'fine' });
    menu.open(0, 0); // triggerActiveItem is a no-op unless the menu is attached
    const trigger = async (index: number): Promise<void> => {
      menu.open(0, 0);
      menu.activeIndex = index;
      menu.triggerActiveItem();
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    await trigger(1); // proves the menu path reaches the registry at all
    expect(calls).toEqual(['fine']);
    await trigger(0);
    expect(calls).toEqual(['fine']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(VetoError);
    // The same command on the other registry is not guarded at all.
    await plain.execute('danger');
    expect(calls).toEqual(['fine', 'ran']);
  });
});

// Capability 3: plugin-contributed interceptors for commands and events.
//
// Commands, OBSERVING (audit log, timing): native. `CommandRegistry.commandExecuted` emits `{ id, args, result }` right after the
// handler was invoked, and `result` is the promise of the command. The emit time is the start (to within the synchronous part of
// the handler) and `result.then` is the end. Nothing is needed from us except wiring the observer to a disposable.
//
// Commands, AROUND / VETO (a guard that can block, exact timing): not possible on `app.commands`. `Application` builds
// `this.commands = new CommandRegistry()` in its constructor, the field is readonly, and no option injects another registry.
// Without patching `execute` on the instance, the only route is a CommandRegistry subclass that we hand to `Menu`, `CommandPalette`
// and `ContextMenu` ourselves. `GuardedCommandRegistry` below proves that route works (the menu really calls
// `commands.execute`), but the app's own `app.commands` stays outside it, so anything that calls `app.commands.execute` bypasses
// the guard. That bypass is the gap.
//
// Events: the bus of capability 6 is ours, so it has one delivery hook; `Interceptors.eventHook` is that hook.
import { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import type { BusEvent, DeliveryHook } from './cap6-event-bus.ts';

export interface CallRecord {
  kind: 'command' | 'event';
  id: string;
  args?: unknown;
  startedAt: number;
  durationMs?: number;
  outcome?: 'ok' | 'error' | 'vetoed';
  error?: unknown;
}
export type Around = (call: { kind: 'command' | 'event'; id: string; args?: unknown }, next: () => unknown) => unknown;

export class VetoError extends Error {}

export class Interceptors {
  private readonly chain: Around[] = [];
  /** `onError` receives a failure of an interceptor itself. A broken interceptor must not break the call. */
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  add(around: Around): IDisposable {
    this.chain.push(around);
    return new DisposableDelegate(() => void this.chain.splice(this.chain.indexOf(around), 1));
  }

  run(call: { kind: 'command' | 'event'; id: string; args?: unknown }, terminal: () => unknown): unknown {
    const step = (index: number): unknown => {
      const around = this.chain[index];
      if (!around) return terminal();
      let advanced = false;
      try {
        return around(call, () => {
          advanced = true;
          return step(index + 1);
        });
      } catch (error) {
        if (error instanceof VetoError || advanced) throw error; // a veto and a failure of the real call pass through
        this.onError(error); // the interceptor itself failed before it called next: skip it
        return step(index + 1);
      }
    };
    return step(0);
  }

  get eventHook(): DeliveryHook {
    return (event: BusEvent, deliver) => void this.run({ kind: 'event', id: event.topic.name, args: event.payload }, deliver);
  }
}

/** Native observer: audit log and timing for every command that runs through `commands`. */
export function observeCommands(commands: CommandRegistry, observer: (record: CallRecord) => void): IDisposable {
  const slot: Parameters<CommandRegistry['commandExecuted']['connect']>[0] = (_, { id, args, result }) => {
    const record: CallRecord = { kind: 'command', id, args, startedAt: performance.now() };
    result.then(
      () => observer({ ...record, durationMs: performance.now() - record.startedAt, outcome: 'ok' }),
      (error: unknown) => observer({ ...record, durationMs: performance.now() - record.startedAt, outcome: 'error', error }),
    );
  };
  commands.commandExecuted.connect(slot);
  return new DisposableDelegate(() => void commands.commandExecuted.disconnect(slot));
}

/** The only route to around advice on commands: a registry subclass that the Menu and the CommandPalette are given. */
export class GuardedCommandRegistry extends CommandRegistry {
  constructor(private readonly interceptors: Interceptors) {
    super();
  }
  override execute(id: string, args?: Parameters<CommandRegistry['execute']>[1]): Promise<unknown> {
    try {
      return Promise.resolve(this.interceptors.run({ kind: 'command', id, args }, () => super.execute(id, args)));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

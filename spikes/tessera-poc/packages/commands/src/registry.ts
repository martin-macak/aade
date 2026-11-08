import { Emitter, toDisposable, type Event, type IDisposable } from '@tessera/base';
import type { CommandChange, CommandHandler, CommandMetadata, CommandRegistry } from '@tessera/contracts';
import { state, type Observable, type State } from '@tessera/reactive';

export interface RegisteredHandler {
  readonly handler: CommandHandler<unknown, unknown>;
  readonly owner: string | undefined;
  /** The handler holds the capability commands.override: it ranks like an owner handler. */
  readonly override: boolean;
  readonly seq: number;
}

export class DefaultCommandRegistry implements CommandRegistry {
  readonly #declared = new Map<string, CommandMetadata[]>();
  readonly #handlers = new Map<string, RegisteredHandler[]>();
  readonly #commands: State<ReadonlyMap<string, CommandMetadata>> = state<ReadonlyMap<string, CommandMetadata>>(new Map(), { name: 'commands.declared' });
  readonly #version: State<number> = state(0, { name: 'commands.version' });
  readonly #changed = new Emitter<CommandChange>({ name: 'commands.change', deferInTransaction: false });
  #seq = 0;

  get commands(): Observable<ReadonlyMap<string, CommandMetadata>> {
    return this.#commands.asReadonly();
  }

  /** Bumps on every declaration or handler change. Status and presentation computeds depend on it. */
  get version(): Observable<number> {
    return this.#version.asReadonly();
  }

  get onDidChange(): Event<CommandChange> {
    return this.#changed.event;
  }

  /** Counter for the performance tests: how many times the declared map was published (a batch of declarations is one). */
  publications = 0;

  /** Declares several commands with one publication of the map, one version bump and one change event per command. */
  declareMany(entries: readonly CommandMetadata[]): IDisposable[] {
    const disposables: IDisposable[] = [];
    const ids = new Set<string>();
    for (const metadata of entries) {
      const stack = this.#declared.get(metadata.id) ?? [];
      const entry = Object.freeze({ ...metadata });
      stack.push(entry);
      this.#declared.set(metadata.id, stack);
      ids.add(metadata.id);
      disposables.push(toDisposable(() => this.#undeclare(metadata.id, entry)));
    }
    this.#publishDeclared([...ids]);
    for (const id of ids) this.#changed.fire({ kind: 'declared', commandId: id });
    return disposables;
  }

  #undeclare(id: string, entry: CommandMetadata): void {
    const list = this.#declared.get(id);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.#declared.delete(id);
    this.#publishDeclared([id]);
    this.#changed.fire({ kind: 'undeclared', commandId: id });
  }

  declare(metadata: CommandMetadata): IDisposable {
    const stack = this.#declared.get(metadata.id) ?? [];
    const entry = Object.freeze({ ...metadata });
    stack.push(entry);
    this.#declared.set(metadata.id, stack);
    this.#publishDeclared([metadata.id]);
    this.#changed.fire({ kind: 'declared', commandId: metadata.id });
    return toDisposable(() => this.#undeclare(metadata.id, entry));
  }

  /** Publishes a new map with only `changedIds` recomputed: one native copy of the last map for the whole batch, one version bump. */
  #publishDeclared(changedIds: readonly string[]): void {
    const next = new Map(this.#commands.peek());
    for (const changedId of changedIds) {
      const stack = this.#declared.get(changedId);
      const top = stack?.[stack.length - 1];
      if (top) next.set(changedId, top);
      else next.delete(changedId);
    }
    this.publications++;
    this.#commands.set(next);
    this.#version.update((v) => v + 1);
  }

  registerHandler<A, R>(id: string, handler: CommandHandler<A, R>, owner?: string, options?: { readonly override?: boolean }): IDisposable {
    const entry: RegisteredHandler = { handler: handler as CommandHandler<unknown, unknown>, owner, override: options?.override === true, seq: this.#seq++ };
    const list = this.#handlers.get(id) ?? [];
    list.push(entry);
    this.#handlers.set(id, list);
    this.#version.update((v) => v + 1);
    this.#changed.fire({ kind: 'handlers', commandId: id });
    return toDisposable(() => {
      const current = this.#handlers.get(id);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.#handlers.delete(id);
      this.#version.update((v) => v + 1);
      this.#changed.fire({ kind: 'handlers', commandId: id });
    });
  }

  metadata(id: string): CommandMetadata | undefined {
    const stack = this.#declared.get(id);
    return stack?.[stack.length - 1];
  }

  hasHandler(id: string): boolean {
    return (this.#handlers.get(id)?.length ?? 0) > 0;
  }

  /** Registered handlers of a command, oldest first. */
  handlersOf(id: string): readonly RegisteredHandler[] {
    return this.#handlers.get(id) ?? [];
  }

  dispose(): void {
    this.#changed.dispose();
  }
}

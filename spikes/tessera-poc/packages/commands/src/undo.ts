import { TesseraError, getScheduler, reportError } from '@tessera/base';
import type { UndoEntry, UndoService, UndoStepContext } from '@tessera/contracts';
import { computed, state, type Observable, type State } from '@tessera/reactive';

interface Record {
  readonly entry: UndoEntry;
  /** Every owner that contributed to the entry (a merged group can hold several). Any match invalidates it. */
  readonly owners: ReadonlySet<string>;
  readonly resources: readonly string[];
  valid: boolean;
}

export interface UndoOptions {
  /** Asked before an entry with confirmBeforeUndo is undone. false cancels. Default: always yes. */
  readonly confirm?: (entry: UndoEntry) => Promise<boolean>;
  /** Most undo entries kept per resource; the oldest is dropped beyond it. Default 100. */
  readonly limit?: number;
  /** Is this owner still allowed to push? false refuses the push with `undo.ownerGone`. Default: every owner is. */
  readonly isOwnerLive?: (owner: string) => boolean;
  /** Longest wait for one undo or redo step (not for the confirm dialog). On expiry the lock is released: `undo.timeout`. Default 10000. */
  readonly stepTimeoutMs?: number;
  /** Runs a command for an undo or redo step with `undoable: false`. The module wires the CommandService here. */
  readonly execute?: (commandId: string, args: unknown) => Promise<unknown>;
}

export const DEFAULT_UNDO_STEP_TIMEOUT_MS = 10_000;

export const DEFAULT_UNDO_LIMIT = 100;

function resourcesOf(entry: UndoEntry): readonly string[] {
  return [...new Set([entry.resource, ...(entry.extraResources ?? [])])];
}

export class DefaultUndoService implements UndoService {
  readonly #undoStacks = new Map<string, Record[]>();
  readonly #redoStacks = new Map<string, Record[]>();
  readonly #version: State<number> = state(0, { name: 'undo.version' });
  readonly #groups: Array<Array<{ entry: UndoEntry; owner: string | undefined }>> = [];
  readonly #confirm: ((entry: UndoEntry) => Promise<boolean>) | undefined;
  readonly #isOwnerLive: ((owner: string) => boolean) | undefined;
  readonly #stepTimeoutMs: number;
  readonly #execute: ((commandId: string, args: unknown) => Promise<unknown>) | undefined;

  readonly #limit: number;

  constructor(options?: UndoOptions) {
    this.#confirm = options?.confirm;
    this.#limit = Math.max(1, options?.limit ?? DEFAULT_UNDO_LIMIT);
    this.#isOwnerLive = options?.isOwnerLive;
    this.#stepTimeoutMs = options?.stepTimeoutMs ?? DEFAULT_UNDO_STEP_TIMEOUT_MS;
    this.#execute = options?.execute;
  }

  #bump(): void {
    this.#version.update((v) => v + 1);
  }

  push(entry: UndoEntry, options?: { readonly owner?: string }): void {
    const owner = options?.owner;
    if (owner !== undefined && this.#isOwnerLive && !this.#isOwnerLive(owner)) {
      throw new TesseraError('undo.ownerGone', `"${owner}" cannot push an undo entry: the plugin is not active any more`, { details: { owner, code: entry.code } });
    }
    const group = this.#groups[this.#groups.length - 1];
    if (group) {
      group.push({ entry, owner });
      return;
    }
    this.#pushNow(entry, owner === undefined ? [] : [owner]);
  }

  /** Resources whose undo or redo step is running. A push on one of them waits for the step to end (it would land under the entry that is in flight). */
  readonly #stepping = new Set<string>();
  readonly #queuedPushes: Array<{ readonly entry: UndoEntry; readonly owners: readonly string[] }> = [];

  #pushNow(entry: UndoEntry, owners: readonly string[]): void {
    // An edit made while a step runs on one of its resources is applied in order when the step ends: the entry in flight goes back to its
    // stack first (redo on success, undo on failure), then the new entry lands on top (and clears redo, as every new edit does).
    if (resourcesOf(entry).some((r) => this.#stepping.has(r))) {
      this.#queuedPushes.push({ entry, owners });
      return;
    }
    this.#applyPush(entry, owners);
  }

  #endStep(resources: readonly string[]): void {
    for (const r of resources) this.#stepping.delete(r);
    const queued = this.#queuedPushes.splice(0);
    for (const push of queued) this.#pushNow(push.entry, push.owners); // still blocked by another running step: waits again
  }

  #applyPush(entry: UndoEntry, owners: readonly string[]): void {
    const record: Record = { entry, owners: new Set(owners), resources: resourcesOf(entry), valid: true };
    for (const resource of record.resources) {
      const stack = this.#undoStacks.get(resource) ?? [];
      stack.push(record);
      this.#undoStacks.set(resource, stack);
      this.#redoStacks.delete(resource); // a new edit clears the redo stack of each resource involved
      while (stack.length > this.#limit) this.#drop(stack[0] as Record);
    }
    this.#bump();
  }

  /** Removes a record from every stack it is in (the limit dropped it from one), and deletes stacks that became empty. */
  #drop(record: Record): void {
    record.valid = false;
    for (const stacks of [this.#undoStacks, this.#redoStacks]) {
      for (const resource of record.resources) {
        const stack = stacks.get(resource);
        if (!stack) continue;
        const index = stack.indexOf(record);
        if (index >= 0) stack.splice(index, 1);
        if (stack.length === 0) stacks.delete(resource);
      }
    }
  }

  #top(stacks: Map<string, Record[]>, resource: string): Record | undefined {
    const stack = stacks.get(resource);
    if (!stack) return undefined;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as Record;
      if (top.valid) return top;
      stack.pop(); // invalid entries are skipped and dropped
    }
    stacks.delete(resource); // no empty stacks are kept
    return undefined;
  }

  canUndo(resource: string): Observable<boolean> {
    return computed(() => {
      this.#version.get();
      return this.#top(this.#undoStacks, resource) !== undefined;
    }, { name: `undo.can:${resource}` });
  }

  canRedo(resource: string): Observable<boolean> {
    return computed(() => {
      this.#version.get();
      return this.#top(this.#redoStacks, resource) !== undefined;
    }, { name: `redo.can:${resource}` });
  }

  undo(resource: string): Promise<boolean> {
    return this.#step(resource, 'undo');
  }

  redo(resource: string): Promise<boolean> {
    return this.#step(resource, 'redo');
  }

  /** Resources with a step in flight. A step holds all resources of its record, so steps on one resource run one after the other. */
  readonly #locked = new Set<string>();
  readonly #waiters: Array<() => void> = [];

  /** Takes all resources at once (never hold-and-wait, so no deadlock). Waits in FIFO order while one is taken. */
  async #lock(resources: readonly string[]): Promise<() => void> {
    while (resources.some((r) => this.#locked.has(r))) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    for (const r of resources) this.#locked.add(r);
    return () => {
      for (const r of resources) this.#locked.delete(r);
      for (const wake of this.#waiters.splice(0)) wake();
    };
  }

  async #step(resource: string, direction: 'undo' | 'redo'): Promise<boolean> {
    const from = direction === 'undo' ? this.#undoStacks : this.#redoStacks;
    const to = direction === 'undo' ? this.#redoStacks : this.#undoStacks;
    // Serialize per resource: a second undo() on the same resource waits for the first to finish (key repeat runs in order).
    let held: readonly string[] = [resource];
    let release = await this.#lock(held);
    let record: Record | undefined;
    let stepped: readonly string[] | undefined;
    try {
      for (;;) {
        record = this.#top(from, resource);
        if (!record) return false;
        if (record.resources.every((r) => held.includes(r))) break;
        // A multi-resource entry: take every resource of the record (release first, then take all at once, then look again).
        release();
        held = record.resources;
        release = await this.#lock(held);
      }
      const current = record;
      // A multi-resource entry can only move when it is on top of every resource it touches.
      const onTopEverywhere = (): boolean => current.valid && current.resources.every((other) => this.#top(from, other) === current);
      if (!onTopEverywhere()) return false;
      if (direction === 'undo' && current.entry.confirmBeforeUndo && this.#confirm) {
        if (!(await this.#confirm(current.entry))) return false;
        // Something may have changed while the dialog was open (a new edit, an invalidation): check again.
        if (!onTopEverywhere()) return false;
      }
      for (const r of current.resources) {
        const stack = from.get(r);
        stack?.pop();
        if (stack?.length === 0) from.delete(r);
        this.#stepping.add(r);
      }
      stepped = current.resources;
      this.#bump();
      try {
        await this.#runStep(current.entry, direction);
      } catch (error) {
        // The entry stays where it was: a failed or timed-out step does not delete the user's history.
        if (current.valid) {
          for (const r of current.resources) {
            const stack = from.get(r) ?? [];
            stack.push(current);
            from.set(r, stack);
          }
          this.#bump();
        }
        const owner = firstOf(current.owners);
        const failure = error instanceof TesseraError && error.code === 'undo.timeout' ? error : new TesseraError('undo.failed', `The ${direction} step "${current.entry.code}" failed; the entry stays on its stack`, { cause: error, details: { code: current.entry.code, direction } });
        reportError(failure, { source: 'command', target: current.entry.code, ...(owner !== undefined ? { pluginId: owner } : {}) });
        throw error;
      }
      if (!current.valid) return true; // invalidated while it ran: not kept
      for (const r of current.resources) {
        const stack = to.get(r) ?? [];
        stack.push(current);
        to.set(r, stack);
      }
      this.#bump();
      return true;
    } finally {
      if (stepped) this.#endStep(stepped); // after the entry went back to a stack: the edits made meanwhile land on top of it
      release();
    }
  }

  /** One undo or redo call, with a step context (commands that do not record themselves) and a time bound that releases the lock. */
  async #runStep(entry: UndoEntry, direction: 'undo' | 'redo'): Promise<void> {
    const execute = this.#execute;
    const ctx: UndoStepContext = {
      execute: async <R,>(commandId: string, args?: unknown): Promise<R> => {
        if (!execute) throw new TesseraError('undo.noExecutor', 'No command executor is wired into the undo service');
        return (await execute(commandId, args)) as R;
      },
    };
    const work = Promise.resolve().then(() => (direction === 'undo' ? entry.undo(ctx) : entry.redo(ctx)));
    let timer: { dispose(): void } | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = getScheduler().timeout(() => reject(new TesseraError('undo.timeout', `The ${direction} step "${entry.code}" did not finish in ${this.#stepTimeoutMs} ms`, { details: { code: entry.code, direction } })), this.#stepTimeoutMs);
    });
    expired.catch(() => undefined);
    try {
      await Promise.race([work, expired]);
    } finally {
      timer?.dispose();
    }
  }

  async group<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const collected: Array<{ entry: UndoEntry; owner: string | undefined }> = [];
    this.#groups.push(collected);
    try {
      return await fn();
    } finally {
      this.#groups.splice(this.#groups.indexOf(collected), 1);
      if (collected.length === 1) {
        const only = collected[0] as { entry: UndoEntry; owner: string | undefined };
        this.push(only.entry, only.owner === undefined ? undefined : { owner: only.owner });
      } else if (collected.length > 1) {
        const owners = [...new Set(collected.flatMap((c) => (c.owner === undefined ? [] : [c.owner])))];
        const entries = collected.map((c) => c.entry);
        const resources = [...new Set(entries.flatMap(resourcesOf))];
        const merged: UndoEntry = {
          label,
          code: entries[0]?.code ?? 'group',
          resource: resources[0] as string,
          ...(resources.length > 1 ? { extraResources: resources.slice(1) } : {}),
          ...(entries.some((e) => e.confirmBeforeUndo) ? { confirmBeforeUndo: true } : {}),
          undo: async (stepCtx) => {
            for (const e of entries.toReversed()) await e.undo(stepCtx);
          },
          redo: async (stepCtx) => {
            for (const e of entries) await e.redo(stepCtx);
          },
        };
        // every owner counts: invalidating any of them invalidates the merged entry (the liveness check ran at each push)
        this.#pushNow(merged, owners);
      }
    }
  }

  invalidateOwner(owner: string): void {
    let changed = false;
    for (const stacks of [this.#undoStacks, this.#redoStacks]) {
      for (const stack of stacks.values()) {
        for (const record of stack) {
          if (record.owners.has(owner) && record.valid) {
            record.valid = false;
            changed = true;
          }
        }
      }
    }
    if (changed) this.#bump();
  }

  clear(resource: string, options?: { readonly owner?: string }): void {
    const owner = options?.owner;
    if (owner === undefined) {
      this.#undoStacks.delete(resource);
      this.#redoStacks.delete(resource);
    } else {
      // only the entries the owner contributed to: the stacks of other owners on the same resource stay
      for (const stacks of [this.#undoStacks, this.#redoStacks]) {
        for (const record of [...(stacks.get(resource) ?? [])]) if (record.owners.has(owner)) this.#drop(record);
      }
    }
    this.#bump();
  }
}

function firstOf(set: ReadonlySet<string>): string | undefined {
  for (const value of set) return value;
  return undefined;
}

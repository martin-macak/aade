import type { Observable } from '@tessera/reactive';
import { token, type Token } from '@tessera/di';

export interface UndoEntry {
  readonly label: string;
  /** Non-localized id, for tests and telemetry: 'tasks.complete'. */
  readonly code: string;
  /** The undo stack this entry belongs to: a document URI, or a view instance id. */
  readonly resource: string;
  /** More resources make it a multi-resource entry: undoing it needs all of them on top. */
  readonly extraResources?: readonly string[];
  readonly confirmBeforeUndo?: boolean;
  /** @inProcessOnly A function. The v2 remote API describes an undo entry as a command id plus args. */
  undo(ctx?: UndoStepContext): void | Promise<void>;
  /** @inProcessOnly See undo(). */
  redo(ctx?: UndoStepContext): void | Promise<void>;
}

/** What an undo or redo step gets: a way to run commands that does not record new undo entries. */
export interface UndoStepContext {
  execute<R = unknown>(commandId: string, args?: unknown): Promise<R>;
}

export interface UndoService {
  /** Clears the redo stack of each resource involved. owner: plugin id. */
  push(entry: UndoEntry, options?: { readonly owner?: string }): void;
  canUndo(resource: string): Observable<boolean>;
  canRedo(resource: string): Observable<boolean>;
  /** false if nothing to undo, the entry is invalid, or the user declined a confirmation. */
  undo(resource: string): Promise<boolean>;
  redo(resource: string): Promise<boolean>;
  /** Pushes inside fn are merged into one entry. */
  group<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Marks all entries of a deactivated plugin invalid. Invalid entries are skipped and dropped. */
  invalidateOwner(owner: string): void;
  /** Drops the entries of the resource. With `owner`, only that owner's entries go; the stacks of other owners stay. */
  clear(resource: string, options?: { readonly owner?: string }): void;
}
export const UndoService: Token<UndoService> = token<UndoService>('tessera.undo');

/**
 * Optional host check: is this owner (a plugin id) still allowed to push undo entries? The plugin manager provides it, so an entry of a
 * plugin that is gone is refused with `undo.ownerGone`. An owner the check does not know (the core) is allowed.
 */
export const UndoOwnerCheck: Token<(owner: string) => boolean> = token<(owner: string) => boolean>('tessera.undoOwnerCheck');

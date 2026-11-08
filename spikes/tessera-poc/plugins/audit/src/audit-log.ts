import { computed, state, token } from '@tessera/plugin-api';
import type { Observable, Presenter, State, Token } from '@tessera/plugin-api';

export interface AuditEntry {
  readonly seq: number;
  readonly kind: 'command' | 'event';
  /** Command id or topic id. */
  readonly target: string;
  /** Command source ('palette', 'api', ...) or the publish scope of an event. */
  readonly source: string;
  readonly outcome: 'ok' | 'error' | 'vetoed' | 'published';
  readonly durationMs: number;
  /** Event node id, error message, ... */
  readonly detail: string | undefined;
}

/** The most entries the log keeps. Older entries are dropped (a ring buffer). */
export const AUDIT_LOG_CAPACITY = 1000;

/** A ring buffer: record() writes in place and bumps a version signal; `entries` copies the buffer only when it is read. */
export class AuditLog {
  readonly entries: Observable<readonly AuditEntry[]>;
  readonly #buffer: AuditEntry[] = [];
  readonly #version: State<number> = state(0, { name: 'audit.version' });
  readonly #capacity: number;
  #seq = 0;

  constructor(capacity: number = AUDIT_LOG_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
    this.entries = computed(
      () => {
        this.#version.get();
        return this.#buffer.slice();
      },
      { name: 'audit.entries' },
    );
  }

  record(entry: Omit<AuditEntry, 'seq'>): void {
    if (this.#buffer.length >= this.#capacity) this.#buffer.shift();
    this.#buffer.push({ ...entry, seq: ++this.#seq });
    this.#version.update((v) => v + 1);
  }

  clear(): void {
    this.#buffer.length = 0;
    this.#version.update((v) => v + 1);
  }
}
export const AuditLogToken: Token<AuditLog> = token<AuditLog>('sample.audit/AuditLog');

// ----- the audit.log view (MVP) ----------------------------------------------------------------

export interface AuditViewState {
  readonly entries: readonly AuditEntry[];
  readonly commands: number;
  readonly events: number;
  readonly errors: number;
}
export interface AuditViewIntents {
  clear(): void;
}

/** What a view instance of audit.log reads: a small per-instance model over the plugin-wide AuditLog service. */
export interface AuditViewModel {
  readonly entries: Observable<readonly AuditEntry[]>;
  clear(): void;
}

/** The view model of one audit.log instance. The AuditLog stays the plugin's service (shared by every view and the interceptors). */
export function createAuditViewModel(log: AuditLog): AuditViewModel {
  return { entries: log.entries, clear: () => log.clear() };
}

export class AuditPresenter implements Presenter<AuditViewState, AuditViewIntents> {
  readonly viewState: Observable<AuditViewState>;
  readonly intents: AuditViewIntents;

  constructor(model: AuditViewModel) {
    this.viewState = computed<AuditViewState>(
      () => {
        const all = model.entries.get();
        return {
          entries: all.slice(-200),
          commands: all.filter((e) => e.kind === 'command').length,
          events: all.filter((e) => e.kind === 'event').length,
          errors: all.filter((e) => e.outcome === 'error').length,
        };
      },
      { name: 'audit.viewState' },
    );
    this.intents = { clear: () => model.clear() };
  }

  dispose(): void {
    // the view model holds no resources of its own
  }
}

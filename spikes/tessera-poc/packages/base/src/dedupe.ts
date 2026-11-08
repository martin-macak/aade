import type { IDisposable } from './disposable-types.ts';
import { TesseraError, type ErrorContext, type ErrorReporter } from './errors.ts';
import { getScheduler } from './scheduler.ts';

/** The most distinct keys that an `errors.suppressed` record lists. */
const MAX_LISTED_KEYS = 20;
/** The most distinct detail keys per code, source, target and owner that are open (forwarded) in one window. The rest are counted as suppressed. */
const MAX_DETAIL_KEYS = 10;

export interface DedupeOptions {
  /** Default 5000. Equal reports inside the window are counted, not forwarded. */
  readonly windowMs?: number;
}

/**
 * Wraps a reporter: the same error (code, target and owner) reported again within the window is counted and dropped, and when the
 * window ends one `errors.suppressed` record says how many were dropped. A plugin that fails in a loop cannot flood the log or the
 * UI, and the owner stays visible. The first report of every kind always goes through at once.
 */
export function dedupingReporter(inner: ErrorReporter, options?: DedupeOptions): ErrorReporter & IDisposable {
  const windowMs = options?.windowMs ?? 5000;
  type Entry = { suppressed: number; readonly dropped: Set<string>; context: ErrorContext; timer: IDisposable };
  const open = new Map<string, Entry>();
  /** Open entries with a detail key, per code, source, target and owner: the cap against a flood of reports whose detail changes every time. */
  const detailCount = new Map<string, number>();
  const summary = (code: string, entry: Entry): void => {
    if (entry.suppressed > 0) {
      inner.report(new TesseraError('errors.suppressed', `${entry.suppressed} more "${code}" report(s) suppressed in ${windowMs} ms`, { details: { code, suppressed: entry.suppressed, windowMs, ...(entry.dropped.size > 0 ? { keys: [...entry.dropped] } : {}) } }), entry.context);
    }
  };
  return {
    report(error, context) {
      const code = error instanceof TesseraError ? error.code : error instanceof Error ? error.name : typeof error;
      // The distinct key of the data the report is about (a quarantined storage key, a view id): two keys give two reports.
      const details = ((error instanceof TesseraError ? error.details : undefined) ?? context.details) as { key?: unknown; id?: unknown } | undefined;
      const detail = details?.key ?? details?.id;
      const base = `${code}\u0000${context.source}\u0000${context.target ?? ''}\u0000${context.pluginId ?? ''}`;
      const key = `${base}\u0000${detail === undefined ? '' : String(detail)}`;
      const known = open.get(key);
      if (known) {
        known.suppressed++;
        if (detail !== undefined && known.dropped.size < MAX_LISTED_KEYS) known.dropped.add(String(detail));
        return;
      }
      // A new detail key past the cap: counted in one overflow entry of the group, never forwarded.
      if (detail !== undefined && (detailCount.get(base) ?? 0) >= MAX_DETAIL_KEYS) {
        const overflowKey = `${base}\u0001overflow`;
        const overflow = open.get(overflowKey);
        if (overflow) {
          overflow.suppressed++;
          if (overflow.dropped.size < MAX_LISTED_KEYS) overflow.dropped.add(String(detail));
          return;
        }
        const entry: Entry = {
          suppressed: 1,
          dropped: new Set([String(detail)]),
          context,
          timer: getScheduler().timeout(() => {
            open.delete(overflowKey);
            summary(code, entry);
          }, windowMs),
        };
        open.set(overflowKey, entry);
        return;
      }
      if (detail !== undefined) detailCount.set(base, (detailCount.get(base) ?? 0) + 1);
      const entry: Entry = {
        suppressed: 0,
        dropped: new Set<string>(),
        context,
        timer: getScheduler().timeout(() => {
          open.delete(key);
          if (detail !== undefined) {
            const left = (detailCount.get(base) ?? 1) - 1;
            if (left > 0) detailCount.set(base, left);
            else detailCount.delete(base);
          }
          summary(code, entry);
        }, windowMs),
      };
      open.set(key, entry);
      inner.report(error, context);
    },
    dispose() {
      for (const entry of open.values()) entry.timer.dispose();
      open.clear();
      detailCount.clear();
    },
  };
}

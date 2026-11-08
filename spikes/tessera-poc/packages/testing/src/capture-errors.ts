import { setErrorReporter, type ErrorContext, type IDisposable } from '@tessera/base';

export interface ReportedError {
  readonly error: unknown;
  readonly context: ErrorContext;
}

export interface ErrorCapture extends IDisposable {
  /** Everything reported since the last drain. */
  readonly errors: readonly ReportedError[];
  /** Returns the reported errors and forgets them. */
  drain(): ReportedError[];
}

/**
 * Captures errors sent to reportError() while the capture is installed. A test that expects errors uses it
 * and drains them; errors that nobody drains fail the test (see assertNoUnexpectedErrors).
 */
export function captureErrors(): ErrorCapture {
  const collected: ReportedError[] = [];
  const handle = setErrorReporter({
    report(error, context) {
      collected.push({ error, context });
    },
  });
  return {
    get errors() {
      return collected;
    },
    drain() {
      return collected.splice(0, collected.length);
    },
    dispose() {
      handle.dispose();
    },
  };
}

const unexpected: ReportedError[] = [];
let installedGlobal: IDisposable | undefined;

/** Setup file hook: collects reported errors that no test captured. */
export function startStrictErrorTracking(): void {
  installedGlobal ??= setErrorReporter({
    report(error, context) {
      unexpected.push({ error, context });
    },
  });
}

/** Throws when an error was reported and nobody captured it. Clears the list. */
export function assertNoUnexpectedErrors(): void {
  if (unexpected.length === 0) return;
  const list = unexpected.splice(0, unexpected.length);
  const text = list
    .map((e) => `[${e.context.source}${e.context.target ? ` ${e.context.target}` : ''}] ${e.error instanceof Error ? (e.error.stack ?? e.error.message) : String(e.error)}`)
    .join('\n');
  throw new Error(`${list.length} unexpected error(s) reported:\n${text}`);
}

export function clearUnexpectedErrors(): void {
  unexpected.length = 0;
}

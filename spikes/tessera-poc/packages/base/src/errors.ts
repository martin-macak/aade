import type { IDisposable } from './disposable-types.ts';

export class TesseraError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: string, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TesseraError';
    this.code = code;
    this.details = options?.details;
  }
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: SerializedError;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const out: {
      name: string;
      message: string;
      code?: string;
      stack?: string;
      details?: Readonly<Record<string, unknown>>;
      cause?: SerializedError;
    } = { name: error.name, message: error.message };
    if (error.stack !== undefined) out.stack = error.stack;
    if (error instanceof TesseraError) {
      out.code = error.code;
      if (error.details !== undefined) out.details = error.details;
    }
    if (error.cause !== undefined) out.cause = serializeError(error.cause);
    return out;
  }
  let message: string;
  try {
    message = typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: 'NonError', message };
}

/** The longest cause chain deserializeError follows. A deeper chain is cut off (the frame schema allows less). */
export const MAX_ERROR_CAUSE_DEPTH = 8;

const asText = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/**
 * Rebuilds an error from its serialized form. It never throws and never recurses: it walks the cause chain with a loop and a
 * depth cap, and it accepts a malformed shape (null cause, details that are not an object) by dropping the bad part.
 */
export function deserializeError(error: SerializedError): TesseraError {
  const chain: SerializedError[] = [];
  let cursor: unknown = error;
  while (typeof cursor === 'object' && cursor !== null && chain.length < MAX_ERROR_CAUSE_DEPTH) {
    chain.push(cursor as SerializedError);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  let inner: TesseraError | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i] as SerializedError;
    const options: { cause?: unknown; details?: Record<string, unknown> } = {};
    if (inner !== undefined) options.cause = inner;
    const details = (item as { details?: unknown }).details;
    if (typeof details === 'object' && details !== null && !Array.isArray(details)) options.details = { ...(details as Record<string, unknown>) };
    const code = (item as { code?: unknown }).code;
    const result = new TesseraError(typeof code === 'string' ? code : 'unknown', asText(item.message, ''), options);
    result.name = asText(item.name, 'Error');
    const stack = (item as { stack?: unknown }).stack;
    if (typeof stack === 'string') result.stack = stack;
    inner = result;
  }
  return inner ?? new TesseraError('unknown', 'Unreadable error from the peer');
}

export const ErrorSource = {
  Listener: 'listener',
  Subscriber: 'subscriber',
  Effect: 'effect',
  Command: 'command',
  Interceptor: 'interceptor',
  Activation: 'activation',
  Deactivation: 'deactivation',
  Dispose: 'dispose',
  View: 'view',
  Persistence: 'persistence',
  Ipc: 'ipc',
  Lifecycle: 'lifecycle',
  Global: 'global',
  Unknown: 'unknown',
} as const;
export type ErrorSource = (typeof ErrorSource)[keyof typeof ErrorSource];

export interface ErrorContext {
  readonly source: ErrorSource;
  /** Attribution: the plugin whose code failed, if known. */
  readonly pluginId?: string;
  /** Command id, topic id, token id, view type, channel... */
  readonly target?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorReporter {
  report(error: unknown, context: ErrorContext): void;
}

const consoleReporter: ErrorReporter = {
  report(error, context) {
    console.error(`[tessera:${context.source}${context.target ? ` ${context.target}` : ''}${context.pluginId ? ` plugin=${context.pluginId}` : ''}]`, error);
  },
};

let reporter: ErrorReporter = consoleReporter;

/** Process-wide reporter used by kernel primitives that live outside DI (Emitter, effects). */
export function setErrorReporter(next: ErrorReporter): IDisposable {
  const previous = reporter;
  reporter = next;
  return {
    dispose() {
      if (reporter === next) reporter = previous;
    },
  };
}

/** Reporting never throws. */
export function reportError(error: unknown, context: ErrorContext): void {
  try {
    reporter.report(error, context);
  } catch {
    // a failing reporter must not break the caller
  }
}

export function getErrorReporter(): ErrorReporter {
  return reporter;
}

/** Throws AggregateError when several errors were collected, the error itself when only one. */
export function throwCollected(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, message);
}

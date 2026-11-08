export const LogLevel = { Trace: 0, Debug: 1, Info: 2, Warn: 3, Error: 4, Off: 5 } as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export interface Logger {
  readonly name: string;
  trace(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(name: string): Logger;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly logger: string;
  readonly message: string;
  readonly data?: unknown;
}
export type LogSink = (record: LogRecord) => void;

/** A logger that forwards records at or above `level` to `sink`. The default sink writes to the console. */
export function createLogger(name: string, options?: { level?: LogLevel; sink?: LogSink }): Logger {
  const level = options?.level ?? LogLevel.Info;
  const sink: LogSink =
    options?.sink ??
    ((record) => {
      const line = `[${record.logger}] ${record.message}`;
      const fn = record.level >= LogLevel.Error ? console.error : record.level === LogLevel.Warn ? console.warn : console.log;
      if (record.data === undefined) fn(line);
      else fn(line, record.data);
    });
  const emit = (l: LogLevel, message: string, data?: unknown): void => {
    if (l < level) return;
    sink(data === undefined ? { level: l, logger: name, message } : { level: l, logger: name, message, data });
  };
  return {
    name,
    trace: (m, d) => emit(LogLevel.Trace, m, d),
    debug: (m, d) => emit(LogLevel.Debug, m, d),
    info: (m, d) => emit(LogLevel.Info, m, d),
    warn: (m, d) => emit(LogLevel.Warn, m, d),
    error: (m, d) => emit(LogLevel.Error, m, d),
    child: (childName) => createLogger(`${name}.${childName}`, { level, sink }),
  };
}

export const nullLogger: Logger = createLogger('null', { level: LogLevel.Off, sink: () => {} });

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** crypto.randomUUID() based, with a readable prefix: 'p-1f3a...'. */
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Dot-segment glob. '*' matches one segment, '**' any number (also zero). 'tasks.*' matches 'tasks.add'. */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const p = pattern.split('.');
  const v = value.split('.');
  return matchSegments(p, 0, v, 0);
}

function matchSegments(p: string[], pi: number, v: string[], vi: number): boolean {
  while (pi < p.length) {
    const seg = p[pi] as string;
    if (seg === '**') {
      if (pi === p.length - 1) return true;
      for (let skip = vi; skip <= v.length; skip++) {
        if (matchSegments(p, pi + 1, v, skip)) return true;
      }
      return false;
    }
    if (vi >= v.length) return false;
    if (!matchSegment(seg, v[vi] as string)) return false;
    pi++;
    vi++;
  }
  return vi === v.length;
}

/** One segment. '*' inside a segment matches any characters except a dot. */
function matchSegment(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

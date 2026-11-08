import { Emitter, generateId, matchGlob, reportError, toDisposable, type Event, type IDisposable } from '@tessera/base';
import { DEFAULT_OBSERVER_BUDGET_MS, compose, isolate, limitGuard } from './compose.ts';
import { InterceptorError } from './errors.ts';
import { sealInterceptor, sealObserver } from './membrane.ts';
import type {
  CreateContextOptions,
  Interceptor,
  InterceptorInfo,
  InterceptorPhase,
  InterceptorRegistry,
  InvocationContext,
  InvocationKind,
  InvocationKinds,
  SyncObserver,
} from './types.ts';

const PHASE_RANK: Readonly<Record<InterceptorPhase, number>> = { outer: 0, guard: 1, transform: 2, resilience: 3, inner: 4 };

interface Entry {
  readonly seq: number;
  readonly interceptor: Interceptor;
  readonly phase: InterceptorPhase;
  readonly order: number;
  readonly mode: 'guard' | 'observer';
}
interface ObserverEntry {
  readonly seq: number;
  readonly observer: SyncObserver;
  readonly order: number;
}

class ContextImpl<K extends InvocationKind> implements InvocationContext<K> {
  readonly kind: K;
  readonly target: string;
  readonly data: Readonly<InvocationKinds[K]>;
  readonly signal: AbortSignal;
  readonly source: string;
  readonly depth: number;
  readonly parent: InvocationContext | undefined;
  readonly traceId: string;
  readonly meta: Map<symbol, unknown>;

  constructor(init: {
    kind: K;
    target: string;
    data: Readonly<InvocationKinds[K]>;
    signal: AbortSignal;
    source: string;
    depth: number;
    parent: InvocationContext | undefined;
    traceId: string;
    meta: Map<symbol, unknown>;
  }) {
    this.kind = init.kind;
    this.target = init.target;
    this.data = init.data;
    this.signal = init.signal;
    this.source = init.source;
    this.depth = init.depth;
    this.parent = init.parent;
    this.traceId = init.traceId;
    this.meta = init.meta;
  }

  with(patch: { readonly data?: InvocationKinds[K]; readonly target?: string }): InvocationContext<K> {
    return new ContextImpl<K>({
      kind: this.kind,
      target: patch.target ?? this.target,
      data: patch.data === undefined ? this.data : freezeData(patch.data),
      signal: this.signal,
      source: this.source,
      depth: this.depth,
      parent: this.parent,
      traceId: this.traceId,
      meta: this.meta, // shared on purpose: the notes of one invocation
    });
  }
}

/** Shallow-freezes a copy, so the caller's object stays untouched and the context data cannot change. */
function freezeData<K extends InvocationKind>(data: InvocationKinds[K]): Readonly<InvocationKinds[K]> {
  return (typeof data === 'object' && data !== null ? Object.freeze({ ...(data as object) }) : data) as Readonly<InvocationKinds[K]>;
}

function matches(match: Interceptor['match'] | SyncObserver['match'], ctx: InvocationContext): boolean {
  if (match === undefined) return true;
  if (typeof match === 'string') return matchGlob(match, ctx.target);
  try {
    return match(ctx);
  } catch (error) {
    reportError(error, { source: 'interceptor', target: ctx.target });
    return false;
  }
}

export function createInterceptorRegistry(options?: {
  /** Default 8. */
  readonly maxDepth?: number;
  /** Default 200. The most time an observer interceptor may take on its own before the pipeline goes on without it. */
  readonly observerBudgetMs?: number;
}): InterceptorRegistry {
  const maxDepth = options?.maxDepth ?? 8;
  const observerBudgetMs = options?.observerBudgetMs ?? DEFAULT_OBSERVER_BUDGET_MS;
  /** Interceptors whose timeout was reported already: one report per interceptor, not one per invocation. */
  const timeoutReported = new Set<string>();
  let seq = 0;
  let entries: Entry[] = [];
  let observers: ObserverEntry[] = [];
  /** kind:target -> interceptors that can apply (glob matched or predicate). Cleared on every registration change. */
  const candidateCache = new Map<string, readonly Entry[]>();
  const changed = new Emitter<void>({ name: 'interceptors.change', deferInTransaction: false });

  const invalidate = (): void => {
    candidateCache.clear();
    changed.fire();
  };

  const candidatesFor = (kind: string, target: string): readonly Entry[] => {
    const key = `${kind}:${target}`;
    const cached = candidateCache.get(key);
    if (cached) return cached;
    const found = entries
      .filter((e) => (e.interceptor.kinds as readonly string[]).includes(kind) && (typeof e.interceptor.match === 'function' || e.interceptor.match === undefined || matchGlob(e.interceptor.match, target)))
      .toSorted((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.order - b.order || a.seq - b.seq);
    candidateCache.set(key, found);
    return found;
  };

  return {
    register<K extends InvocationKind, R>(typed: Interceptor<K, R>): IDisposable {
      const interceptor = typed as unknown as Interceptor;
      if ((interceptor.kinds as readonly string[]).includes('event')) {
        throw new InterceptorError(
          'interceptor.kindMismatch',
          `Interceptor "${interceptor.id}" asks for kind "event". Events cannot await: register a SyncObserver with registerObserver() instead.`,
          interceptor.id,
        );
      }
      const entry: Entry = {
        seq: seq++,
        interceptor,
        phase: interceptor.phase ?? 'transform',
        order: interceptor.order ?? 0,
        mode: interceptor.mode ?? 'guard',
      };
      entries = [...entries, entry];
      timeoutReported.delete(interceptor.id); // a new registration may report again
      invalidate();
      return toDisposable(() => {
        if (!entries.includes(entry)) return;
        entries = entries.filter((e) => e !== entry);
        invalidate();
      });
    },

    registerObserver<K extends InvocationKind>(typed: SyncObserver<K>): IDisposable {
      const observer = typed as unknown as SyncObserver;
      const entry: ObserverEntry = { seq: seq++, observer, order: observer.order ?? 0 };
      observers = [...observers, entry];
      invalidate();
      return toDisposable(() => {
        if (!observers.includes(entry)) return;
        observers = observers.filter((o) => o !== entry);
        invalidate();
      });
    },

    createContext<K extends InvocationKind>(kind: K, target: string, data: InvocationKinds[K], opts?: CreateContextOptions): InvocationContext<K> {
      const parent = opts?.parent;
      return new ContextImpl<K>({
        kind,
        target,
        data: freezeData(data),
        signal: opts?.signal ?? new AbortController().signal,
        source: opts?.source ?? parent?.source ?? 'api',
        depth: parent ? parent.depth + 1 : 0,
        parent,
        traceId: parent?.traceId ?? generateId('trace'),
        meta: new Map(),
      });
    },

    run<K extends InvocationKind, R>(ctx: InvocationContext<K>, terminal: (ctx: InvocationContext<K>) => Promise<R>): Promise<R> {
      if (ctx.depth > maxDepth) {
        return Promise.reject(
          new InterceptorError('interceptor.depth', `Invocation depth ${ctx.depth} exceeds the limit of ${maxDepth} for ${ctx.kind} "${ctx.target}". Is a command calling itself?`, 'pipeline'),
        );
      }
      const candidates = candidatesFor(ctx.kind, ctx.target);
      if (candidates.length === 0) return terminal(ctx); // fast path: no match, no wrapping
      const applicable = candidates.filter((e) => typeof e.interceptor.match !== 'function' || matches(e.interceptor.match, ctx));
      if (applicable.length === 0) return terminal(ctx);
      const chain = applicable.map((e) => {
        const raw = e.interceptor as Interceptor<K, R>;
        const interceptor = raw.readOnlyData === true ? sealInterceptor(raw) : raw;
        if (e.mode === 'observer') {
          return isolate(interceptor, {
            budgetMs: observerBudgetMs,
            shouldReport: (id) => {
              if (timeoutReported.has(id)) return false;
              timeoutReported.add(id);
              return true;
            },
          });
        }
        return interceptor.timeoutMs !== undefined ? limitGuard(interceptor, interceptor.timeoutMs) : interceptor;
      });
      return compose<K, R>(chain, terminal)(ctx);
    },

    observe(ctx) {
      for (const entry of observers.toSorted((a, b) => a.order - b.order || a.seq - b.seq)) {
        const { observer } = entry;
        if (!(observer.kinds as readonly string[]).includes(ctx.kind)) continue;
        if (!matches(observer.match, ctx)) continue;
        try {
          (observer.readOnlyData === true ? sealObserver(observer) : observer).observe(ctx);
        } catch (error) {
          reportError(error, {
            source: 'interceptor',
            target: ctx.target,
            ...(observer.owner !== undefined ? { pluginId: observer.owner } : {}),
            details: { interceptorId: observer.id },
          });
        }
      }
    },

    list(kind) {
      const interceptors: InterceptorInfo[] = entries
        .toSorted((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.order - b.order || a.seq - b.seq)
        .filter((e) => kind === undefined || (e.interceptor.kinds as readonly string[]).includes(kind))
        .map((e) => ({
          id: e.interceptor.id,
          kinds: e.interceptor.kinds,
          phase: e.phase,
          order: e.order,
          mode: e.mode,
          owner: e.interceptor.owner,
        }));
      const sync: InterceptorInfo[] = observers
        .filter((o) => kind === undefined || (o.observer.kinds as readonly string[]).includes(kind))
        .map((o) => ({
          id: o.observer.id,
          kinds: o.observer.kinds,
          phase: 'transform' as const,
          order: o.order,
          mode: 'sync-observer' as const,
          owner: o.observer.owner,
        }));
      return [...interceptors, ...sync];
    },

    get onDidChange(): Event<void> {
      return changed.event;
    },
  };
}

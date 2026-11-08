import { TesseraError } from '@tessera/base';
import type { Interceptor, InvocationContext, InvocationKind, Next, SyncObserver } from './types.ts';

// A deep read-only view of invocation data for plugin-owned interceptors (round 2, observer-mutates-invocation-data).
// The context data is only shallow-frozen, and the handler later reads the very same nested objects. Without this, an
// interceptor with no capability could rewrite command arguments or event payloads in place. The membrane costs nothing until
// a property is read, and it copies nothing: a write throws `interceptor.readOnly`.

const proxies = new WeakMap<object, object>(); // real -> proxy
const reals = new WeakMap<object, object>(); // proxy -> real

function isPlainContainer(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function readOnly(): never {
  throw new TesseraError('interceptor.readOnly', 'The data of an invocation is read-only for an interceptor of a plugin. Pass a changed copy with ctx.with({ data }) and next(), or use a guard.');
}

/** Wraps plain objects and arrays (deeply, lazily). Map, Set, Date, typed arrays, class instances and primitives pass through. */
export function readOnlyView<T>(value: T): T {
  if (!isPlainContainer(value)) return value;
  const known = proxies.get(value);
  if (known) return known as T;
  // The proxy target is an empty shadow of the same kind: the real object may be frozen, and a frozen target would forbid wrapping
  // nested values in `get` (proxy invariants). Every trap forwards to the real object.
  const shadow: object = Array.isArray(value) ? [] : {};
  const proxy = new Proxy(shadow, {
    get: (_t, prop) => readOnlyView(Reflect.get(value, prop)),
    has: (_t, prop) => Reflect.has(value, prop),
    ownKeys: () => Reflect.ownKeys(value),
    getOwnPropertyDescriptor: (_t, prop) => {
      const d = Reflect.getOwnPropertyDescriptor(value, prop);
      if (d === undefined) return undefined;
      if (prop === 'length' && Array.isArray(value)) return { value: value.length, writable: true, enumerable: false, configurable: false };
      return { value: readOnlyView(d.value as unknown), writable: false, enumerable: d.enumerable ?? true, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(value),
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
    setPrototypeOf: readOnly,
    preventExtensions: readOnly,
  });
  proxies.set(value, proxy);
  reals.set(proxy, value);
  return proxy as T;
}

/** The real value behind a view; plain containers that hold views are copied with the views replaced (copy on write). */
export function unwrapView<T>(value: T, depth = 0): T {
  if (typeof value !== 'object' || value === null || depth > 50) return value;
  const real = reals.get(value);
  if (real) return real as T;
  if (!isPlainContainer(value)) return value;
  let copy: Record<PropertyKey, unknown> | unknown[] | undefined;
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    const next = unwrapView(child, depth + 1);
    if (next !== child) {
      copy ??= Array.isArray(value) ? [...value] : { ...(value as object) };
      (copy as Record<PropertyKey, unknown>)[key] = next;
    }
  }
  return (copy ?? value) as T;
}

const wrappers = new WeakMap<object, object>(); // real context -> read-only context
const realContexts = new WeakMap<object, object>(); // read-only context -> real

/** The context that a plugin interceptor sees: same fields, read-only data, and `with()` that returns another read-only context. */
export function readOnlyContext<K extends InvocationKind>(ctx: InvocationContext<K>): InvocationContext<K> {
  const known = wrappers.get(ctx);
  if (known) return known as InvocationContext<K>;
  const view: InvocationContext<K> = {
    kind: ctx.kind,
    target: ctx.target,
    data: readOnlyView(ctx.data),
    signal: ctx.signal,
    source: ctx.source,
    depth: ctx.depth,
    get parent(): InvocationContext | undefined {
      return ctx.parent === undefined ? undefined : readOnlyContext(ctx.parent);
    },
    traceId: ctx.traceId,
    meta: ctx.meta,
    with: (patch) => readOnlyContext(ctx.with({ ...(patch.target !== undefined ? { target: patch.target } : {}), ...(patch.data !== undefined ? { data: unwrapView(patch.data) } : {}) })),
  };
  wrappers.set(ctx, view);
  realContexts.set(view, ctx);
  return view;
}

function realContext<K extends InvocationKind>(ctx: InvocationContext<K> | undefined): InvocationContext<K> | undefined {
  if (ctx === undefined) return undefined;
  return (realContexts.get(ctx) as InvocationContext<K> | undefined) ?? ctx;
}

/** An interceptor whose handler sees the read-only context. What it passes to next() is unwrapped, so the handler gets real data. */
export function sealInterceptor<K extends InvocationKind, R>(interceptor: Interceptor<K, R>): Interceptor<K, R> {
  return {
    ...interceptor,
    intercept: (ctx, next) => {
      const sealedNext: Next<K, R> = (nextCtx) => next(realContext(nextCtx) ?? ctx);
      return interceptor.intercept(readOnlyContext(ctx), sealedNext);
    },
  };
}

export function sealObserver<K extends InvocationKind>(observer: SyncObserver<K>): SyncObserver<K> {
  return { ...observer, observe: (ctx) => observer.observe(readOnlyContext(ctx)) };
}

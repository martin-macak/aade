import {
  CancellationError,
  DeferredPromise,
  DisposableStore,
  Emitter,
  TesseraError,
  deserializeError,
  getScheduler,
  isCancellationError,
  isDevMode,
  reportError,
  serializeError,
  toDisposable,
  type Event,
  type IDisposable,
} from '@tessera/base';
import type {
  Remote,
  RpcCallOptions,
  RpcConnection,
  RpcFrame,
  RpcInterface,
  RpcOptions,
  RpcState,
  RpcTransport,
} from '@tessera/contracts';
import { state, type State } from '@tessera/reactive';
import { KNOWN_FRAME_KINDS, errIdOf, frameKindOf, frameSchema, requestIdOf } from './frame-schema.ts';

interface Registered {
  readonly iface: RpcInterface<unknown>;
  readonly implementation: Record<string, unknown>;
}

interface Pending {
  readonly iface: string;
  readonly method: string;
  readonly result: DeferredPromise<unknown>;
  deadlineTimer?: IDisposable;
  readonly spec: { result: { safeParse(input: unknown): { success: boolean } } } | undefined;
  acked: boolean;
  ackTimer: IDisposable | undefined;
}

interface Subscription {
  readonly listeners: Set<(payload: unknown) => void>;
  readonly iface: RpcInterface<unknown>;
  readonly event: string;
}

const DEFAULT_ACK_TIMEOUT_MS = 3000;
export const DEFAULT_CALL_DEADLINE_MS = 30_000;
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
export const DEFAULT_MAX_PENDING = 1000;
export const DEFAULT_MAX_INCOMING_SUBS = 1000;

/** Deepest nesting and most nodes the size walker visits. A frame beyond either counts as too large (it also ends a cycle). */
const SIZE_MAX_DEPTH = 64;
const SIZE_MAX_NODES = 200_000;

/**
 * The size of a frame by structure, not by JSON: string lengths, `byteLength` of binary data (ArrayBuffer, typed arrays, DataView),
 * a few bytes for numbers and booleans, keys and punctuation. An iterative walk with a depth and a node budget that stops once the
 * running size passes `cap`. Returns Infinity when the budget is spent (a cyclic or absurdly wide value) and `cap + 1` when it passes the cap.
 */
export function sizeOf(frame: unknown, cap: number): number {
  let size = 0;
  let nodes = 0;
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: frame, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (++nodes > SIZE_MAX_NODES || depth > SIZE_MAX_DEPTH) return Infinity;
    switch (typeof value) {
      case 'string':
        size += value.length + 2;
        break;
      case 'number':
        size += 8;
        break;
      case 'boolean':
        size += 5;
        break;
      case 'bigint':
        size += 16;
        break;
      case 'undefined':
      case 'function':
      case 'symbol':
        size += 4;
        break;
      case 'object': {
        if (value === null) {
          size += 4;
        } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
          size += value.byteLength + 8;
        } else if (Array.isArray(value)) {
          size += 2 + value.length;
          for (const item of value) stack.push({ value: item, depth: depth + 1 });
        } else {
          size += 2;
          for (const key of Object.keys(value)) {
            size += key.length + 3;
            stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
          }
        }
        break;
      }
    }
    if (size > cap) return cap + 1;
  }
  return size;
}

/** The ArrayBuffers a value holds directly (not the buffer behind a view): they go in the transfer list instead of being copied. */
function transferablesOf(value: unknown): ArrayBuffer[] {
  const found: ArrayBuffer[] = [];
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length > 0 && nodes++ < SIZE_MAX_NODES) {
    const item = stack.pop();
    if (item instanceof ArrayBuffer) found.push(item);
    else if (Array.isArray(item)) stack.push(...item);
    else if (typeof item === 'object' && item !== null && !ArrayBuffer.isView(item)) stack.push(...Object.values(item));
  }
  return found;
}

function fail(code: string, message: string, details?: Record<string, unknown>): TesseraError {
  return new TesseraError(code, message, details ? { details } : undefined);
}

/**
 * The RPC protocol of contracts.md 17.2: handshake, ack first, schema validation on receipt, cancel frames, errors that keep
 * their code, events with sub and unsub, close that rejects pending calls, and `ipc` interceptors on both sides.
 */
export function createRpcConnection(transport: RpcTransport, options: RpcOptions): RpcConnection {
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const validateResults = options.validateResults ?? true;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const store = new DisposableStore(`rpc:${options.name}`);
  const stateValue: State<RpcState> = state<RpcState>('open', { name: `rpc.state:${options.name}` });
  const closedEmitter = new Emitter<{ readonly reason: string }>({ name: `rpc.close:${options.name}`, deferInTransaction: false });
  const registered = new Map<string, Registered>();
  const peerInterfaces = new Map<string, number>();
  let peerHello = false;
  const unknownKinds = new Set<string>();
  const pending = new Map<number, Pending>();
  const inflight = new Map<number, AbortController>();
  const outgoingSubs = new Map<number, Subscription>();
  const incomingSubs = new Map<number, IDisposable>();
  let nextId = 1;
  let closed = false;

  /** Sends a frame. Throws when the transport cannot send it (a value that cannot be cloned). */
  const send = (frame: RpcFrame): void => {
    if (closed) return;
    if (frame.t === 'req' || frame.t === 'ok' || frame.t === 'evt') {
      const transfer = transferablesOf(frame.t === 'req' ? frame.args : frame.t === 'ok' ? frame.value : frame.payload);
      transport.send(frame, transfer);
    } else transport.send(frame);
  };
  /** Like send, for frames that carry no caller data (ack, err, cancel): a failure is reported, not thrown. */
  const sendQuiet = (frame: RpcFrame): void => {
    try {
      send(frame);
    } catch (error) {
      reportError(error, { source: 'ipc', target: options.name });
    }
  };

  const sendHello = (): void =>
    sendQuiet({ t: 'hello', protocol: 1, name: options.name, interfaces: [...registered.values()].map((r) => ({ id: r.iface.id, version: r.iface.version })) });

  const close = (reason: string): void => {
    if (closed) return;
    closed = true;
    stateValue.set('closed');
    for (const [id, p] of pending) {
      p.ackTimer?.dispose();
      p.deadlineTimer?.dispose();
      p.result.reject(fail('rpc.closed', `RPC connection "${options.name}" closed: ${reason}`, { id }));
    }
    pending.clear();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    for (const d of incomingSubs.values()) d.dispose();
    incomingSubs.clear();
    outgoingSubs.clear();
    closedEmitter.fire({ reason });
    store.dispose();
    closedEmitter.dispose();
  };

  /** Settles a pending call with an error. It rejects first and cleans up after, so nothing below can leave the caller waiting. */
  const failPending = (id: number, error: TesseraError): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.result.reject(error);
    p.ackTimer?.dispose();
    p.deadlineTimer?.dispose();
  };

  const markResponsive = (): void => {
    if (stateValue.peek() === 'unresponsive') stateValue.set('open');
  };

  // ----- incoming frames -------------------------------------------------------------------------
  store.add(
    transport.onFrame((raw) => {
      if (closed) return;
      markResponsive();
      // Nothing from the peer is trusted: size first, then the envelope. A bad frame is dropped and reported, never thrown.
      const invalid = (code: 'rpc.invalidFrame' | 'rpc.frameTooLarge', message: string): void => {
        reportError(fail(code, message), { source: 'ipc', target: options.name });
        const requestId = requestIdOf(raw);
        if (requestId !== undefined) sendQuiet({ t: 'err', id: requestId, error: serializeError(fail(code, message)) });
        // A malformed err frame must not leave its caller waiting for the deadline.
        const errId = errIdOf(raw);
        if (errId !== undefined) failPending(errId, fail('rpc.invalidFrame', `The peer answered call ${errId} with a malformed error frame`));
      };

      if (sizeOf(raw, maxFrameBytes) > maxFrameBytes) {
        invalid('rpc.frameTooLarge', `A frame from "${options.name}" peer is larger than ${maxFrameBytes} bytes; dropped`);
        return;
      }
      // The envelope first: a kind this version does not know is reported once and dropped, and the connection stays open
      // (a later protocol feature, such as stream chunks, must not break a peer that does not have it yet).
      const kind = frameKindOf(raw);
      if (kind !== undefined && !KNOWN_FRAME_KINDS.has(kind)) {
        if (!unknownKinds.has(kind)) {
          unknownKinds.add(kind);
          reportError(fail('rpc.unknownFrame', `The "${options.name}" peer sent a frame of kind "${kind.slice(0, 32)}", which this side does not know; dropped`, { kind: kind.slice(0, 32) }), { source: 'ipc', target: options.name });
        }
        return;
      }
      const checked = frameSchema.safeParse(raw);
      if (!checked.success) {
        invalid('rpc.invalidFrame', `A frame from the "${options.name}" peer does not match the protocol (${checked.error.issues[0]?.message ?? 'invalid'}); dropped`);
        return;
      }
      const frame = checked.data;
      try {
        handleFrame(frame);
      } catch (error) {
        reportError(error, { source: 'ipc', target: options.name });
      }
    }),
  );
  store.add(transport.onClose(() => close('transport closed')));

  function handleFrame(frame: RpcFrame): void {
    {
      switch (frame.t) {
        case 'hello':
          peerHello = true;
          peerInterfaces.clear();
          for (const i of frame.interfaces) peerInterfaces.set(i.id, i.version);
          return;
        case 'req':
          void handleRequest(frame);
          return;
        case 'ack': {
          const p = pending.get(frame.id);
          if (p) {
            p.acked = true;
            p.ackTimer?.dispose();
            p.ackTimer = undefined;
          }
          return;
        }
        case 'ok': {
          const p = pending.get(frame.id);
          if (!p) return;
          pending.delete(frame.id);
          p.ackTimer?.dispose();
          p.deadlineTimer?.dispose();
          if (validateResults && p.spec && !p.spec.result.safeParse(frame.value).success) {
            p.result.reject(fail('rpc.invalidResult', `Result of ${p.iface}.${p.method} does not match its schema`, { iface: p.iface, method: p.method }));
          } else p.result.resolve(frame.value);
          return;
        }
        case 'err': {
          const p = pending.get(frame.id);
          if (!p) {
            // An err for a subscription id: the peer refused the sub (unknown interface or event, or too many).
            const sub = outgoingSubs.get(frame.id);
            if (sub) {
              outgoingSubs.delete(frame.id);
              reportError(deserializeError(frame.error), { source: 'ipc', target: `${sub.iface.id}.${sub.event}` });
            }
            return;
          }
          let error: TesseraError;
          try {
            error = deserializeError(frame.error);
          } catch (cause) {
            error = fail('rpc.invalidFrame', `The peer answered ${p.iface}.${p.method} with an error that cannot be read`, { iface: p.iface, method: p.method });
            void cause;
          }
          failPending(frame.id, error);
          return;
        }
        case 'cancel': {
          // The slot is free at once: a handler that ignores its signal and never settles must not hold it for ever.
          const controller = inflight.get(frame.id);
          inflight.delete(frame.id);
          controller?.abort();
          return;
        }
        case 'sub':
          handleSubscribe(frame.id, frame.iface, frame.event);
          return;
        case 'evt': {
          const sub = outgoingSubs.get(frame.id);
          if (!sub) return;
          const schema = Object.hasOwn(sub.iface.events, sub.event) ? (sub.iface.events as Record<string, { safeParse(i: unknown): { success: boolean } }>)[sub.event] : undefined;
          if (schema && !schema.safeParse(frame.payload).success) {
            reportError(fail('rpc.invalidResult', `Event ${sub.iface.id}.${sub.event} payload does not match its schema; dropped`), { source: 'ipc', target: `${sub.iface.id}.${sub.event}` });
            return;
          }
          for (const listener of [...sub.listeners]) {
            try {
              listener(frame.payload);
            } catch (error) {
              reportError(error, { source: 'ipc', target: `${sub.iface.id}.${sub.event}` });
            }
          }
          return;
        }
        case 'unsub':
          incomingSubs.get(frame.id)?.dispose();
          incomingSubs.delete(frame.id);
          return;
        case 'bye':
          close(frame.reason);
          return;
      }
    }
  }

  // ----- callee side -----------------------------------------------------------------------------
  async function handleRequest(frame: Extract<RpcFrame, { t: 'req' }>): Promise<void> {
    // Whatever happens below, the caller gets an answer: ack first, then ok or err (rule 2). Nothing escapes as a rejection.
    try {
      await serveRequest(frame);
    } catch (error) {
      reportError(error, { source: 'ipc', target: `${frame.iface}.${frame.method}` });
      sendQuiet({ t: 'err', id: frame.id, error: serializeError(error) });
      inflight.delete(frame.id);
    }
  }

  async function serveRequest(frame: Extract<RpcFrame, { t: 'req' }>): Promise<void> {
    const entry = registered.get(frame.iface);
    sendQuiet({ t: 'ack', id: frame.id });
    if (!entry) {
      sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.unknownInterface', `Interface "${frame.iface}" is not offered here`, { iface: frame.iface })) });
      return;
    }
    // Own properties only: "constructor", "__proto__" and "toString" are not methods of an interface.
    const methods = entry.iface.methods as Record<string, { args: { safeParse(i: unknown): { success: boolean; data?: unknown } } } | undefined>;
    const spec = Object.hasOwn(methods, frame.method) ? methods[frame.method] : undefined;
    const fn = spec ? entry.implementation[frame.method] : undefined;
    if (!spec || typeof fn !== 'function') {
      sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.unknownInterface', `Method "${frame.iface}.${frame.method}" does not exist`, { iface: frame.iface, method: frame.method })) });
      return;
    }
    if (inflight.size >= maxPending) {
      sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.tooManyPending', `Too many requests are running on "${options.name}" (${maxPending}); try again later`, { limit: maxPending })) });
      return;
    }
    const parsed = spec.args.safeParse(frame.args);
    if (!parsed.success) {
      sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.invalidArgs', `Arguments of ${frame.iface}.${frame.method} do not match their schema`, { iface: frame.iface, method: frame.method })) });
      return;
    }
    const controller = new AbortController();
    inflight.set(frame.id, controller);
    let answered = false;
    let calleeTimer: IDisposable | undefined;
    if (options.calleeDeadlineMs !== undefined) {
      calleeTimer = getScheduler().timeout(() => {
        if (answered) return;
        answered = true;
        inflight.delete(frame.id);
        controller.abort();
        sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.callTimeout', `${frame.iface}.${frame.method} did not finish within ${options.calleeDeadlineMs} ms on the callee`, { iface: frame.iface, method: frame.method })) });
      }, options.calleeDeadlineMs);
    }
    const invoke = async (): Promise<unknown> => (fn as (...args: unknown[]) => Promise<unknown>).apply(entry.implementation, [...(parsed.data as unknown[]), controller.signal]);
    try {
      const registry = options.interceptors?.();
      let value: unknown;
      if (registry) {
        const ctx = registry.createContext('ipc', `${frame.iface}.${frame.method}`, { connection: options.name, iface: frame.iface, method: frame.method, direction: 'incoming', args: frame.args }, { signal: controller.signal, source: `rpc:${options.name}` });
        value = await registry.run(ctx, invoke);
      } else value = await invoke();
      const reply = { t: 'ok', id: frame.id, value } as const;
      if (sizeOf(reply, maxFrameBytes) > maxFrameBytes) throw fail('rpc.frameTooLarge', `The result of ${frame.iface}.${frame.method} is larger than ${maxFrameBytes} bytes`, { limit: maxFrameBytes });
      if (!answered) {
        // answered is set only after the send worked: a result the transport cannot carry (a function, a symbol) still gets an answer.
        try {
          send(reply);
          answered = true;
        } catch (sendError) {
          answered = true;
          sendQuiet({ t: 'err', id: frame.id, error: serializeError(fail('rpc.invalidResult', `The result of ${frame.iface}.${frame.method} cannot be sent: ${sendError instanceof Error ? sendError.message : String(sendError)}`, { iface: frame.iface, method: frame.method })) });
        }
      }
    } catch (error) {
      if (!answered) {
        answered = true;
        sendQuiet({ t: 'err', id: frame.id, error: serializeError(controller.signal.aborted && !(error instanceof TesseraError) ? new CancellationError() : error) });
      }
    } finally {
      calleeTimer?.dispose();
      if (inflight.get(frame.id) === controller) inflight.delete(frame.id);
    }
  }

  function handleSubscribe(id: number, ifaceId: string, event: string): void {
    const refuse = (code: string, message: string): void => sendQuiet({ t: 'err', id, error: serializeError(fail(code, message, { iface: ifaceId, event })) });
    const entry = registered.get(ifaceId);
    if (!entry) return refuse('rpc.unknownInterface', `Interface "${ifaceId}" is not offered here`);
    const source = Object.hasOwn(entry.iface.events, event) ? entry.implementation[event] : undefined;
    if (typeof source !== 'function') return refuse('rpc.unknownInterface', `Event "${ifaceId}.${event}" does not exist`);
    // A repeated sub id replaces the old subscription (a peer cannot stack handlers under one id).
    incomingSubs.get(id)?.dispose();
    incomingSubs.delete(id);
    if (incomingSubs.size >= DEFAULT_MAX_INCOMING_SUBS) return refuse('rpc.tooManyPending', `Too many event subscriptions on "${options.name}" (${DEFAULT_MAX_INCOMING_SUBS})`);
    const subscription = (source as Event<unknown>)((payload) => {
      try {
        send({ t: 'evt', id, payload });
      } catch (error) {
        reportError(fail('rpc.invalidResult', `Event ${ifaceId}.${event} payload cannot be sent`, { cause: String(error) }), { source: 'ipc', target: `${ifaceId}.${event}` });
      }
    });
    incomingSubs.set(id, subscription);
  }

  // ----- caller side -----------------------------------------------------------------------------
  function call(iface: RpcInterface<unknown>, method: string, rawArgs: unknown[], callOptions: RpcCallOptions | undefined): Promise<unknown> {
    if (closed) return Promise.reject(fail('rpc.closed', `RPC connection "${options.name}" is closed`));
    let signal: AbortSignal | undefined;
    const args = [...rawArgs];
    if (args.length > 0 && args[args.length - 1] instanceof AbortSignal) signal = args.pop() as AbortSignal; // never sent (rule 4)
    if (peerHello) {
      const version = peerInterfaces.get(iface.id);
      if (version === undefined) return Promise.reject(fail('rpc.unknownInterface', `The peer does not offer "${iface.id}"`, { iface: iface.id }));
      if (version !== iface.version) return Promise.reject(fail('rpc.versionMismatch', `"${iface.id}" is version ${iface.version} here and ${version} at the peer`, { iface: iface.id }));
    }
    if (signal?.aborted) return Promise.reject(new CancellationError());
    if (pending.size >= maxPending) return Promise.reject(fail('rpc.tooManyPending', `Too many calls wait for a result on "${options.name}" (${maxPending})`, { limit: maxPending }));
    const request = { t: 'req', id: 0, iface: iface.id, method, args } as const;
    if (isDevMode()) {
      // Dev: a value the transport cannot clone fails here, with the method named, not somewhere inside the transport.
      try {
        structuredClone(args);
      } catch (error) {
        return Promise.reject(fail('rpc.invalidArgs', `The arguments of ${iface.id}.${method} cannot be sent (not structured-cloneable): ${error instanceof Error ? error.message : String(error)}`, { iface: iface.id, method }));
      }
    }
    if (sizeOf(request, maxFrameBytes) > maxFrameBytes) return Promise.reject(fail('rpc.frameTooLarge', `The arguments of ${iface.id}.${method} are larger than ${maxFrameBytes} bytes`, { iface: iface.id, method, limit: maxFrameBytes }));
    const deadlineMs = callOptions?.deadlineMs ?? options.interfaceDeadlinesMs?.[iface.id] ?? options.callDeadlineMs ?? DEFAULT_CALL_DEADLINE_MS;
    const run = (): Promise<unknown> => {
      const id = nextId++;
      const result = new DeferredPromise<unknown>();
      const spec = Object.hasOwn(iface.methods, method) ? (iface.methods as Record<string, Pending['spec']>)[method] : undefined;
      const entry: Pending = { iface: iface.id, method, result, spec, acked: false, ackTimer: undefined };
      pending.set(id, entry);
      entry.ackTimer = getScheduler().timeout(() => {
        if (!entry.acked && pending.has(id)) stateValue.set('unresponsive');
      }, callOptions?.timeoutMs ?? ackTimeoutMs);
      entry.deadlineTimer = getScheduler().timeout(() => {
        if (!pending.delete(id)) return;
        entry.ackTimer?.dispose();
        sendQuiet({ t: 'cancel', id });
        result.reject(fail('rpc.callTimeout', `${iface.id}.${method} did not answer in ${deadlineMs} ms`, { iface: iface.id, method, deadlineMs }));
      }, deadlineMs);
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        entry.ackTimer?.dispose();
        entry.deadlineTimer?.dispose();
        sendQuiet({ t: 'cancel', id });
        result.reject(new CancellationError()); // the local promise rejects at once
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        send({ t: 'req', id, iface: iface.id, method, args });
      } catch (error) {
        // The transport refused the frame: nothing leaks (no pending slot, no timer, no abort listener) and the caller gets an answer now (I34).
        signal?.removeEventListener('abort', onAbort);
        failPending(id, fail('rpc.invalidArgs', `The arguments of ${iface.id}.${method} cannot be sent: ${error instanceof Error ? error.message : String(error)}`, { iface: iface.id, method }));
        return result.promise;
      }
      return result.promise.finally(() => signal?.removeEventListener('abort', onAbort));
    };
    const registry = options.interceptors?.();
    if (!registry) return run();
    const ctx = registry.createContext('ipc', `${iface.id}.${method}`, { connection: options.name, iface: iface.id, method, direction: 'outgoing', args }, { ...(signal ? { signal } : {}), source: `rpc:${options.name}` });
    return registry.run(ctx, run);
  }

  function subscribe(iface: RpcInterface<unknown>, event: string, listener: (payload: unknown) => void): IDisposable {
    let found: [number, Subscription] | undefined;
    for (const entry of outgoingSubs) if (entry[1].iface.id === iface.id && entry[1].event === event) found = entry;
    if (!found) {
      const id = nextId++;
      const subscription: Subscription = { listeners: new Set(), iface, event };
      outgoingSubs.set(id, subscription);
      sendQuiet({ t: 'sub', id, iface: iface.id, event });
      found = [id, subscription];
    }
    const [id, subscription] = found;
    subscription.listeners.add(listener);
    return toDisposable(() => {
      subscription.listeners.delete(listener);
      if (subscription.listeners.size === 0 && outgoingSubs.delete(id)) sendQuiet({ t: 'unsub', id });
    });
  }

  const connection: RpcConnection = {
    name: options.name,
    state: stateValue.asReadonly(),
    onDidClose: closedEmitter.event,
    getProxy<T>(iface: RpcInterface<T>, callOptions?: RpcCallOptions): Remote<T> {
      const target: Record<string, unknown> = {};
      for (const method of Object.keys(iface.methods)) {
        target[method] = (...args: unknown[]) => call(iface as RpcInterface<unknown>, method, args, callOptions);
      }
      for (const event of Object.keys(iface.events)) {
        target[event] = (listener: (e: unknown) => void, listenOptions?: { store?: DisposableStore }): IDisposable => {
          const subscription = subscribe(iface as RpcInterface<unknown>, event, listener);
          listenOptions?.store?.add(subscription);
          return subscription;
        };
      }
      return Object.freeze(target) as Remote<T>;
    },
    register<T>(iface: RpcInterface<T>, implementation: T): IDisposable {
      registered.set(iface.id, { iface: iface as RpcInterface<unknown>, implementation: implementation as Record<string, unknown> });
      sendHello();
      return toDisposable(() => {
        if (registered.get(iface.id)?.implementation === (implementation as unknown)) {
          registered.delete(iface.id);
          sendHello();
        }
      });
    },
    dispose() {
      if (closed) return;
      sendQuiet({ t: 'bye', reason: 'disposed' });
      close('disposed');
      transport.dispose();
    },
  };
  sendHello();
  void isCancellationError;
  return connection;
}

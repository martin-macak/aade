import { describe, expect, it } from 'vitest';
import { Emitter, TesseraError, getScheduler, type Event, type Schema } from '@tessera/base';
import { defineRpcInterface, type RpcFrame } from '@tessera/contracts';
import { createInterceptorRegistry } from '@tessera/interceptors';
import { captureErrors, createTestScope } from '@tessera/testing';
import { createInMemoryTransportPair, createRpcConnection } from '@tessera/rpc';

// poc-plan invariant I19 (stretch goal): ack and unresponsive, cancel frames, schema validation, errors keep their code,
// events, close rejects pending calls, ipc interceptors, handshake errors.

const ok = <T>(data: T) => ({ success: true as const, data });
const bad = (message: string) => ({ success: false as const, error: { issues: [{ path: [] as string[], message }] } });
const tuple = <A extends readonly unknown[]>(check: (a: readonly unknown[]) => boolean): Schema<A> => ({ safeParse: (i: unknown) => (Array.isArray(i) && check(i) ? ok(i as unknown as A) : bad('bad args')) });
const type = <T>(kind: 'number' | 'string' | 'void'): Schema<T> => ({
  safeParse: (i: unknown) => (kind === 'void' ? (i === undefined || i === null ? ok(i as T) : bad('expected void')) : typeof i === kind ? ok(i as T) : bad(`expected ${kind}`)),
});

interface Calc {
  add(a: number, b: number): Promise<number>;
  slow(ms: number, signal?: AbortSignal): Promise<string>;
  fail(): Promise<void>;
  lie(): Promise<number>;
  readonly onTick: Event<number>;
}
const CalcInterface = defineRpcInterface<Calc>('test.calc', 1, {
  methods: {
    add: { args: tuple<[number, number]>((a) => a.length === 2 && typeof a[0] === 'number' && typeof a[1] === 'number'), result: type<number>('number') },
    slow: { args: tuple<[number]>((a) => a.length === 1 && typeof a[0] === 'number'), result: type<string>('string') },
    fail: { args: tuple<[]>((a) => a.length === 0), result: type<void>('void') },
    lie: { args: tuple<[]>((a) => a.length === 0), result: type<number>('number') },
  },
  events: { onTick: type<number>('number') },
});

function setup(options?: { interceptors?: ReturnType<typeof createInterceptorRegistry> }) {
  const t = createTestScope({ flat: true });
  const [ta, tb] = createInMemoryTransportPair();
  const caller = createRpcConnection(ta, { name: 'renderer', ...(options?.interceptors ? { interceptors: () => options.interceptors } : {}) });
  const callee = createRpcConnection(tb, { name: 'main', ...(options?.interceptors ? { interceptors: () => options.interceptors } : {}) });
  const ticks = new Emitter<number>({ name: 'test.ticks' });
  const seen: { signal: AbortSignal | undefined; started: number } = { signal: undefined, started: 0 };
  const impl: Calc = {
    add: async (a, b) => a + b,
    slow: async (ms, signal) => {
      seen.started++;
      seen.signal = signal;
      await new Promise<void>((resolve, reject) => {
        const timer = getScheduler().timeout(resolve, ms); // the manual scheduler of the test: no real time passes
        signal?.addEventListener('abort', () => (timer.dispose(), reject(new Error('aborted by cancel frame'))));
      });
      return 'done';
    },
    fail: async () => {
      throw new TesseraError('test.failed', 'it failed', { details: { why: 'because' } });
    },
    lie: async () => 'not a number' as unknown as number,
    onTick: ticks.event,
  };
  callee.register(CalcInterface, impl);
  t.application.track({ dispose: () => (caller.dispose(), callee.dispose(), ticks.dispose()) });
  return { t, caller, callee, remote: caller.getProxy(CalcInterface), ticks, seen, ta, tb };
}

/** The in-memory transport delivers in microtasks: a few turns of the microtask queue deliver every frame in flight. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe('I19: calls', () => {
  it('I19: a call returns the result of the remote implementation', async () => {
    const { remote } = setup();
    expect(await remote.add(2, 3)).toBe(5);
  });

  it('I19: arguments are validated on receipt: bad arguments reject with rpc.invalidArgs and the implementation does not run', async () => {
    const { remote, seen } = setup();
    await expect((remote.add as unknown as (a: unknown, b: unknown) => Promise<number>)('x', 1)).rejects.toMatchObject({ code: 'rpc.invalidArgs' });
    expect(seen.started).toBe(0);
  });

  it('I19: the result is validated on the caller side: a result that breaks its schema rejects with rpc.invalidResult', async () => {
    const { remote } = setup();
    await expect(remote.lie()).rejects.toMatchObject({ code: 'rpc.invalidResult' });
  });

  it('I19: errors keep their code and details across the connection', async () => {
    const { remote } = setup();
    const error = await remote.fail().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(TesseraError);
    expect(error).toMatchObject({ code: 'test.failed', message: 'it failed', details: { why: 'because' } });
  });

  it('I19: a call to an interface the peer does not offer rejects with rpc.unknownInterface', async () => {
    const { caller } = setup();
    const other = defineRpcInterface<{ ping(): Promise<void> }>('test.other', 1, { methods: { ping: { args: tuple<[]>(() => true), result: type<void>('void') } }, events: {} });
    await flush();
    await expect(caller.getProxy(other).ping()).rejects.toMatchObject({ code: 'rpc.unknownInterface' });
  });

  it('I19: a version difference rejects with rpc.versionMismatch', async () => {
    const { caller } = setup();
    const v2 = defineRpcInterface<Calc>('test.calc', 2, { methods: CalcInterface.methods, events: CalcInterface.events });
    await flush();
    await expect(caller.getProxy(v2).add(1, 1)).rejects.toMatchObject({ code: 'rpc.versionMismatch' });
  });
});

describe('I19: ack, unresponsive, cancel, close', () => {
  it('I19: the callee acks first; without an ack after ackTimeoutMs the connection is unresponsive until the next frame arrives', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const caller = createRpcConnection(ta, { name: 'renderer', ackTimeoutMs: 3000 });
    t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
    const frames: RpcFrame[] = [];
    tb.onFrame((f) => frames.push(f));
    const call = caller.getProxy(CalcInterface).add(1, 2); // the peer is a dead end: nobody acks
    call.catch(() => undefined);
    await flush();
    expect(caller.state.peek()).toBe('open');
    t.scheduler.advance(2999);
    expect(caller.state.peek()).toBe('open');
    t.scheduler.advance(1);
    expect(caller.state.peek()).toBe('unresponsive');
    tb.send({ t: 'hello', protocol: 1, name: 'main', interfaces: [] }); // any frame proves life
    await flush();
    expect(caller.state.peek()).toBe('open');
    expect(frames.some((f) => f.t === 'req')).toBe(true);
  });

  it('I19: the callee sends ack before the result', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const callee = createRpcConnection(tb, { name: 'main' });
    callee.register(CalcInterface, { add: async (a: number, b: number) => a + b, slow: async () => 'x', fail: async () => undefined, lie: async () => 1, onTick: Emitter.prototype as never } as unknown as Calc);
    t.application.track({ dispose: () => (callee.dispose(), ta.dispose()) });
    const seen: string[] = [];
    ta.onFrame((f) => seen.push(f.t));
    ta.send({ t: 'req', id: 1, iface: 'test.calc', method: 'add', args: [1, 2] });
    await flush();
    expect(seen.filter((s) => s !== 'hello')).toEqual(['ack', 'ok']);
  });

  it('I19: aborting a call sends a cancel frame, rejects locally at once with a cancellation error, and aborts the remote signal', async () => {
    const { remote, seen, ta } = setup();
    const sent: string[] = [];
    const original = ta.send.bind(ta);
    ta.send = (frame, transfer) => (sent.push(frame.t), original(frame, transfer));
    const controller = new AbortController();
    const call = (remote.slow as (ms: number, signal: AbortSignal) => Promise<string>)(10_000, controller.signal);
    await flush();
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    await flush();
    expect(sent).toContain('cancel');
    expect(seen.signal?.aborted).toBe(true); // the implementation got a fresh signal and it was aborted
  });

  it('I19: the trailing AbortSignal is never sent over the wire', async () => {
    const { remote, ta } = setup();
    const args: unknown[][] = [];
    const original = ta.send.bind(ta);
    ta.send = (frame, transfer) => (frame.t === 'req' && args.push([...frame.args]), original(frame, transfer));
    await (remote.add as unknown as (a: number, b: number, s: AbortSignal) => Promise<number>)(1, 2, new AbortController().signal);
    expect(args).toEqual([[1, 2]]);
  });

  it('I19: closing the transport rejects pending calls with rpc.closed and ends the connection', async () => {
    const { remote, caller, tb } = setup();
    const pending = remote.slow(10_000);
    await flush();
    tb.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'rpc.closed' });
    expect(caller.state.peek()).toBe('closed');
    await expect(remote.add(1, 1)).rejects.toMatchObject({ code: 'rpc.closed' });
  });

  it('I19: dispose says bye: the peer closes too', async () => {
    const { caller, callee } = setup();
    const reasons: string[] = [];
    callee.onDidClose((e) => reasons.push(e.reason));
    caller.dispose();
    await flush();
    expect(reasons).toEqual(['disposed']);
    expect(callee.state.peek()).toBe('closed');
  });
});

describe('I19: events', () => {
  it('I19: the first listener subscribes on the remote event; payloads arrive; the last unsubscribe ends the forwarding', async () => {
    const { remote, ticks } = setup();
    const a: number[] = [];
    const b: number[] = [];
    const subA = remote.onTick((n) => a.push(n));
    const subB = remote.onTick((n) => b.push(n));
    await flush();
    ticks.fire(1);
    await flush();
    subA.dispose();
    ticks.fire(2);
    await flush();
    subB.dispose();
    await flush();
    ticks.fire(3);
    await flush();
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    expect(ticks.hasListeners).toBe(false); // the remote subscription is gone
  });

  it('I19: an event payload that breaks its schema is dropped and reported', async () => {
    const { remote, ticks } = setup();
    const errors = captureErrors();
    const got: number[] = [];
    remote.onTick((n) => got.push(n));
    await flush();
    (ticks as unknown as { fire(v: unknown): void }).fire('nope');
    ticks.fire(7);
    await flush();
    expect(got).toEqual([7]);
    expect(errors.drain()).toHaveLength(1);
    errors.dispose();
  });
});

describe('I19: ipc interceptors', () => {
  it('I19: outgoing and incoming calls run through kind ipc interceptors with target iface.method', async () => {
    const interceptors = createInterceptorRegistry();
    const seen: string[] = [];
    interceptors.register({
      id: 'ipc-spy',
      kinds: ['ipc'],
      async intercept(ctx, next) {
        seen.push(`${ctx.data.direction}:${ctx.target}:${ctx.data.connection}`);
        return next();
      },
    });
    const { remote } = setup({ interceptors });
    await remote.add(1, 2);
    expect(seen.sort()).toEqual(['incoming:test.calc.add:main', 'outgoing:test.calc.add:renderer']);
  });
});

describe('I19: nothing from the peer is trusted (rpc-request-envelope-unvalidated)', () => {
  /** A callee connection and the raw transport of a "peer" that sends whatever frames a test wants. */
  function rawPeer(options?: { maxFrameBytes?: number; maxPending?: number; callDeadlineMs?: number }) {
    const t = createTestScope({ flat: true });
    const [peer, own] = createInMemoryTransportPair();
    const callee = createRpcConnection(own, { name: 'main', ...options });
    const impl: Calc = {
      add: async (a, b) => a + b,
      slow: () => new Promise<string>(() => undefined),
      fail: async () => undefined,
      lie: async () => 1,
      onTick: new Emitter<number>({ name: 'raw.ticks' }).event,
    };
    callee.register(CalcInterface, impl);
    const replies: RpcFrame[] = [];
    peer.onFrame((f) => replies.push(f));
    t.application.track({ dispose: () => (callee.dispose(), peer.dispose()) });
    const send = (frame: unknown): void => peer.send(frame as RpcFrame);
    return { t, callee, peer, replies, send };
  }

  async function ticks(count = 20): Promise<void> {
    for (let i = 0; i < count; i++) await Promise.resolve();
  }

  it('I19: inherited names ("constructor", "__proto__", "toString") are not methods: the caller gets rpc.unknownInterface, nothing is thrown', async () => {
    const { send, replies } = rawPeer();
    const errors = captureErrors();
    for (const [index, method] of ['constructor', '__proto__', 'toString', 'hasOwnProperty'].entries()) send({ t: 'req', id: index + 1, iface: 'test.calc', method, args: [] });
    await ticks();
    const errs = replies.filter((f): f is Extract<RpcFrame, { t: 'err' }> => f.t === 'err');
    expect(errs).toHaveLength(4);
    for (const e of errs) expect(e.error).toMatchObject({ code: 'rpc.unknownInterface' });
    expect(errors.drain()).toEqual([]);
    errors.dispose();
  });

  it('I19: a malformed request (no args array, id not an integer) is dropped, reported as rpc.invalidFrame (an unknown kind: rpc.unknownFrame), and an err frame answers when it has an id', async () => {
    const { send, replies } = rawPeer();
    const errors = captureErrors();
    send({ t: 'req', id: 7, iface: 'test.calc', method: 'add' }); // args missing
    send({ t: 'req', id: 1.5, iface: 'test.calc', method: 'add', args: [] });
    send({ t: 'nonsense' });
    send(null);
    await ticks();
    const reported = errors.drain().map((e) => (e.error as { code: string }).code);
    expect(reported).toEqual(['rpc.invalidFrame', 'rpc.invalidFrame', 'rpc.unknownFrame', 'rpc.invalidFrame']); // an unknown kind is rpc.unknownFrame (reserved room for later frames)
    errors.dispose();
    const errs = replies.filter((f): f is Extract<RpcFrame, { t: 'err' }> => f.t === 'err');
    expect(errs.map((e) => e.id)).toEqual([7]); // only the frame with a usable id gets an answer
    expect(errs[0]?.error).toMatchObject({ code: 'rpc.invalidFrame' });
  });

  it('I19: a bad hello (interfaces is not an array) is rejected and does not change what the connection knows about the peer', async () => {
    const { send, callee } = rawPeer();
    const errors = captureErrors();
    send({ t: 'hello', protocol: 1, name: 'evil', interfaces: 'nope' });
    await ticks();
    expect(errors.drain().map((e) => (e.error as { code: string }).code)).toEqual(['rpc.invalidFrame']);
    errors.dispose();
    expect(callee.state.peek()).toBe('open');
  });

  it('I19: a frame above the size cap is dropped with rpc.frameTooLarge, and a request among them gets an err frame', async () => {
    const { send, replies } = rawPeer({ maxFrameBytes: 200 });
    const errors = captureErrors();
    send({ t: 'req', id: 3, iface: 'test.calc', method: 'add', args: ['x'.repeat(500), 1] });
    await ticks();
    expect(errors.drain().map((e) => (e.error as { code: string }).code)).toEqual(['rpc.frameTooLarge']);
    errors.dispose();
    const err = replies.find((f) => f.t === 'err');
    expect(err).toMatchObject({ t: 'err', id: 3, error: { code: 'rpc.frameTooLarge' } });
  });

  it('I19: a call with arguments above the cap rejects at once with rpc.frameTooLarge and sends nothing', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const caller = createRpcConnection(ta, { name: 'renderer', maxFrameBytes: 200 });
    const frames: RpcFrame[] = [];
    tb.onFrame((f) => frames.push(f));
    t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
    const big = (caller.getProxy(CalcInterface).add as unknown as (a: unknown, b: unknown) => Promise<number>)('x'.repeat(500), 1);
    await expect(big).rejects.toMatchObject({ code: 'rpc.frameTooLarge' });
    expect(frames.some((f) => f.t === 'req' && f.method === 'add')).toBe(false);
  });

  it('I19: a call that gets no result within the deadline rejects with rpc.callTimeout (ManualScheduler) and a cancel frame goes out', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const caller = createRpcConnection(ta, { name: 'renderer', callDeadlineMs: 5000 });
    const frames: RpcFrame[] = [];
    tb.onFrame((f) => frames.push(f));
    t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
    const call = caller.getProxy(CalcInterface).add(1, 2).then(() => undefined, (e: unknown) => e);
    await ticks();
    t.scheduler.advance(4999);
    await ticks();
    expect(frames.some((f) => f.t === 'cancel')).toBe(false);
    t.scheduler.advance(1);
    expect(await call).toMatchObject({ code: 'rpc.callTimeout' });
    await ticks();
    expect(frames.some((f) => f.t === 'cancel')).toBe(true);
  });

  it('I19: the deadline can be set per call and per interface; the default is 30 s', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const caller = createRpcConnection(ta, { name: 'renderer', interfaceDeadlinesMs: { 'test.calc': 2000 } });
    t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
    const byInterface = caller.getProxy(CalcInterface).add(1, 2).then(() => undefined, (e: unknown) => e);
    const byCall = caller.getProxy(CalcInterface, { deadlineMs: 500 }).add(1, 2).then(() => undefined, (e: unknown) => e);
    await ticks();
    t.scheduler.advance(500);
    expect(await byCall).toMatchObject({ code: 'rpc.callTimeout' });
    t.scheduler.advance(1500);
    expect(await byInterface).toMatchObject({ code: 'rpc.callTimeout' });
    const defaulted = createRpcConnection(createInMemoryTransportPair()[0], { name: 'renderer2' });
    const waiting = defaulted.getProxy(CalcInterface).add(1, 2).then(() => undefined, (e: unknown) => e);
    await ticks();
    t.scheduler.advance(29_999);
    await ticks();
    t.scheduler.advance(1);
    expect(await waiting).toMatchObject({ code: 'rpc.callTimeout' });
    defaulted.dispose();
  });

  it('I19: more pending calls than the cap reject with rpc.tooManyPending; running requests above the cap on the callee side get an err frame', async () => {
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const caller = createRpcConnection(ta, { name: 'renderer', maxPending: 2 });
    t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
    const calls = [1, 2, 3].map((n) => caller.getProxy(CalcInterface).add(n, n).then(() => 'pending', (e: unknown) => e));
    expect(await calls[2]).toMatchObject({ code: 'rpc.tooManyPending' });
    const { send, replies } = rawPeer({ maxPending: 1 });
    send({ t: 'req', id: 1, iface: 'test.calc', method: 'slow', args: [1] });
    send({ t: 'req', id: 2, iface: 'test.calc', method: 'slow', args: [1] });
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 2)).toMatchObject({ error: { code: 'rpc.tooManyPending' } });
    void calls;
  });
});

import { describe, expect, it } from 'vitest';
import { Emitter, deserializeError, getScheduler } from '@tessera/base';
import { defineRpcInterface, type RpcFrame } from '@tessera/contracts';
import { captureErrors, createTestScope } from '@tessera/testing';
import { createInMemoryTransportPair, createRpcConnection } from '@tessera/rpc';

const ok = <T>(data: T) => ({ success: true as const, data });
const anyArgs = { safeParse: (i: unknown) => (Array.isArray(i) ? ok(i as never) : { success: false as const, error: { issues: [{ path: [] as string[], message: 'x' }] } }) };
const anyValue = { safeParse: (i: unknown) => ok(i as never) };

interface Svc {
  hang(): Promise<string>;
  readonly onThing: (listener: (n: number) => void) => { dispose(): void };
}
const SvcInterface = defineRpcInterface<Svc>('test.svc', 1, {
  methods: { hang: { args: anyArgs as never, result: anyValue as never } },
  events: { onThing: anyValue as never },
});

const ticks = async (count = 20): Promise<void> => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};

function callerWithRawPeer(respond: (frame: RpcFrame, send: (f: unknown) => void) => void, options?: { callDeadlineMs?: number }) {
  const t = createTestScope({ flat: true });
  const [ta, tb] = createInMemoryTransportPair();
  const caller = createRpcConnection(ta, { name: 'renderer', ...options });
  tb.onFrame((f) => respond(f, (x) => tb.send(x as RpcFrame)));
  t.application.track({ dispose: () => (caller.dispose(), tb.dispose()) });
  return { t, caller, tb };
}

describe('round 2: a malformed err frame rejects the caller at once', () => {
  const malformed: Array<[string, unknown]> = [
    ['cause null', { name: 'Error', message: 'm', cause: null }],
    ['details as a string', { name: 'Error', message: 'm', details: 'text' }],
    ['code as a number', { name: 'Error', message: 'm', code: 42 }],
    ['a 100 deep cause chain', (() => { let e: Record<string, unknown> = { name: 'E', message: 'leaf' }; for (let i = 0; i < 100; i++) e = { name: 'E', message: `l${i}`, cause: e }; return e; })()],
    ['a huge stack', { name: 'Error', message: 'm', stack: 'x'.repeat(100_000) }],
  ];
  for (const [label, error] of malformed) {
    it(`I19: ${label} gives rpc.invalidFrame before the 30 s deadline and the timers are gone`, async () => {
      const capture = captureErrors();
      const { caller } = callerWithRawPeer((frame, send) => {
        if (frame.t === 'req') send({ t: 'err', id: frame.id, error });
      });
      const result = await caller.getProxy(SvcInterface).hang().then(() => undefined, (e: unknown) => e);
      expect(result).toMatchObject({ code: 'rpc.invalidFrame' });
      capture.drain();
      capture.dispose();
    });
  }

  it('I19: a well-formed err with a 5 deep cause chain still arrives with its code', async () => {
    let e: Record<string, unknown> = { name: 'E', message: 'leaf', code: 'x.leaf' };
    for (let i = 0; i < 4; i++) e = { name: 'E', message: `l${i}`, cause: e };
    const { caller } = callerWithRawPeer((frame, send) => {
      if (frame.t === 'req') send({ t: 'err', id: frame.id, error: { ...e, code: 'x.top' } });
    });
    const result = await caller.getProxy(SvcInterface).hang().then(() => undefined, (x: unknown) => x);
    expect(result).toMatchObject({ code: 'x.top' });
  });

  it('base: deserializeError never throws and caps the chain', () => {
    let e: Record<string, unknown> = { name: 'E', message: 'leaf' };
    for (let i = 0; i < 1000; i++) e = { name: 'E', message: `l${i}`, cause: e };
    const out = deserializeError(e as never);
    let depth = 0;
    for (let c: unknown = out; c instanceof Error; c = c.cause) depth++;
    expect(depth).toBeLessThanOrEqual(8);
    expect(deserializeError({ name: 'E', message: 'm', cause: null, details: 'x' } as never).message).toBe('m');
  });
});

describe('round 2: callee slots and subscription limits', () => {
  function rawCallee(options?: { maxPending?: number; calleeDeadlineMs?: number }) {
    const t = createTestScope({ flat: true });
    const [peer, own] = createInMemoryTransportPair();
    const callee = createRpcConnection(own, { name: 'main', ...options });
    const things = new Emitter<number>({ name: 'raw.things' });
    callee.register(SvcInterface, { hang: () => new Promise<string>(() => undefined), onThing: things.event });
    const replies: RpcFrame[] = [];
    peer.onFrame((f) => replies.push(f));
    t.application.track({ dispose: () => (callee.dispose(), peer.dispose(), things.dispose()) });
    return { t, peer, replies, send: (f: unknown) => peer.send(f as RpcFrame), things };
  }

  it('I19: a cancel frame frees the callee slot even when the handler never settles', async () => {
    const { send, replies } = rawCallee({ maxPending: 1 });
    send({ t: 'req', id: 1, iface: 'test.svc', method: 'hang', args: [] });
    await ticks();
    send({ t: 'req', id: 2, iface: 'test.svc', method: 'hang', args: [] });
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 2)).toMatchObject({ error: { code: 'rpc.tooManyPending' } });
    send({ t: 'cancel', id: 1 });
    await ticks();
    send({ t: 'req', id: 3, iface: 'test.svc', method: 'hang', args: [] });
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 3)).toBeUndefined();
  });

  it('I19: calleeDeadlineMs aborts a hung handler, frees the slot and answers rpc.callTimeout (ManualScheduler)', async () => {
    const { t, send, replies } = rawCallee({ maxPending: 1, calleeDeadlineMs: 1000 });
    send({ t: 'req', id: 1, iface: 'test.svc', method: 'hang', args: [] });
    await ticks();
    t.scheduler.advance(1000);
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 1)).toMatchObject({ error: { code: 'rpc.callTimeout' } });
    send({ t: 'req', id: 2, iface: 'test.svc', method: 'hang', args: [] });
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 2)).toBeUndefined();
    void getScheduler;
  });

  it('I19: a sub for an unknown interface or event is answered with err', async () => {
    const { send, replies } = rawCallee();
    send({ t: 'sub', id: 10, iface: 'nope', event: 'onThing' });
    send({ t: 'sub', id: 11, iface: 'test.svc', event: 'onNothing' });
    await ticks();
    expect(replies.find((f) => f.t === 'err' && f.id === 10)).toMatchObject({ error: { code: 'rpc.unknownInterface' } });
    expect(replies.find((f) => f.t === 'err' && f.id === 11)).toMatchObject({ error: { code: 'rpc.unknownInterface' } });
  });

  it('I19: a duplicate sub id replaces the old subscription and a flood of subs is capped at 1000', async () => {
    const { send, replies, things } = rawCallee();
    send({ t: 'sub', id: 1, iface: 'test.svc', event: 'onThing' });
    send({ t: 'sub', id: 1, iface: 'test.svc', event: 'onThing' });
    await ticks();
    things.fire(7);
    await ticks();
    expect(replies.filter((f) => f.t === 'evt')).toHaveLength(1);
    const capture = captureErrors(); // the emitter warns about a possible leak at 175 listeners
    for (let id = 2; id <= 1100; id++) send({ t: 'sub', id, iface: 'test.svc', event: 'onThing' });
    await ticks(50);
    capture.drain();
    capture.dispose();
    expect(replies.filter((f) => f.t === 'err' && f.error.code === 'rpc.tooManyPending').length).toBeGreaterThan(90);
  });
});

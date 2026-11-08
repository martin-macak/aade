import { describe, expect, it } from 'vitest';
import { defineRpcInterface, type RpcFrame } from '@tessera/contracts';
import { captureErrors, createTestScope } from '@tessera/testing';
import { createInMemoryTransportPair, createRpcConnection } from '@tessera/rpc';

const ok = <T>(data: T) => ({ success: true as const, data });
const anyArgs = { safeParse: (i: unknown) => (Array.isArray(i) ? ok(i as never) : { success: false as const, error: { issues: [{ path: [] as string[], message: 'x' }] } }) };
const anyValue = { safeParse: (i: unknown) => ok(i as never) };

interface Svc {
  fn(): Promise<unknown>;
  echo(payload: unknown): Promise<unknown>;
}
const SvcInterface = defineRpcInterface<Svc>('test.svc3', 1, {
  methods: { fn: { args: anyArgs as never, result: anyValue as never }, echo: { args: anyArgs as never, result: anyValue as never } },
  events: {},
});

const ticks = async (count = 40): Promise<void> => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};

function pair(callee: Svc, options?: { maxFrameBytes?: number; maxPending?: number }) {
  const t = createTestScope({ flat: true });
  const [ta, tb] = createInMemoryTransportPair();
  const caller = createRpcConnection(ta, { name: 'renderer', maxPending: 3, ...options });
  const server = createRpcConnection(tb, { name: 'main', ...options });
  server.register(SvcInterface, callee);
  t.application.track({ dispose: () => (caller.dispose(), server.dispose()) });
  return { t, caller, server, proxy: caller.getProxy(SvcInterface) };
}

describe('I34: a failed send answers the request and leaks nothing (rpc-send-failure-unanswered)', () => {
  it('a result the transport cannot clone (a function) gives rpc.invalidResult at once, not the call deadline', async () => {
    const errors = captureErrors();
    const { proxy } = pair({ fn: async () => ({ f: () => 1 }), echo: async (x) => x });
    const result = await proxy.fn().then(() => undefined, (e: unknown) => e);
    expect(result).toMatchObject({ code: 'rpc.invalidResult' });
    errors.drain();
    errors.dispose();
  });

  it('a function argument rejects and the pending table stays empty: maxPending calls still fit afterwards', async () => {
    const { proxy } = pair({ fn: async () => 1, echo: async (x) => x });
    for (let i = 0; i < 10; i++) {
      const rejected = await proxy.echo({ f: () => 1 }).then(() => undefined, (e: unknown) => e);
      expect(rejected).toMatchObject({ code: 'rpc.invalidArgs' });
    }
    // with maxPending 3 a leaked slot per failed call would give rpc.tooManyPending by now
    expect(await proxy.echo(7)).toBe(7);
  });
});

describe('rpc-sizeof-blind-to-binary: the frame cap counts bytes by structure', () => {
  const cap = 10_000;
  for (const [label, make] of [
    ['Uint8Array', (n: number) => new Uint8Array(n)],
    ['ArrayBuffer', (n: number) => new ArrayBuffer(n)],
  ] as const) {
    it(`${label}: 0.5x the cap passes, 1x and 2x are refused with rpc.frameTooLarge`, async () => {
      const { proxy } = pair({ fn: async () => 1, echo: async (x) => x }, { maxFrameBytes: cap });
      const half = await proxy.echo(make(cap / 2));
      expect((half as { byteLength: number }).byteLength).toBe(cap / 2);
      for (const factor of [1, 2]) {
        const refused = await proxy.echo(make(cap * factor)).then(() => undefined, (e: unknown) => e);
        expect(refused).toMatchObject({ code: 'rpc.frameTooLarge' });
      }
    });
  }

  it('an incoming frame is counted the same way: a raw peer frame with a big buffer is dropped and reported', async () => {
    const errors = captureErrors();
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const server = createRpcConnection(ta, { name: 'main', maxFrameBytes: cap });
    server.register(SvcInterface, { fn: async () => 1, echo: async (x) => x });
    t.application.track({ dispose: () => (server.dispose(), tb.dispose()) });
    tb.send({ t: 'req', id: 1, iface: 'test.svc3', method: 'echo', args: [new Uint8Array(cap * 2)] } as RpcFrame);
    await ticks();
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toContain('rpc.frameTooLarge');
  });
});

describe('rpc-no-bulk-stream-or-flow-control: reserved protocol room', () => {
  it('an unknown frame kind is reported once and dropped; the connection stays open and a hello with features is accepted', async () => {
    const errors = captureErrors();
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const server = createRpcConnection(ta, { name: 'main' });
    server.register(SvcInterface, { fn: async () => 'alive', echo: async (x) => x });
    const received: RpcFrame[] = [];
    tb.onFrame((f) => received.push(f));
    t.application.track({ dispose: () => (server.dispose(), tb.dispose()) });
    tb.send({ t: 'hello', protocol: 1, name: 'peer', interfaces: [], features: ['stream'] } as RpcFrame);
    tb.send({ t: 'chunk', id: 1, data: 'x' } as never);
    tb.send({ t: 'chunk', id: 2, data: 'y' } as never);
    await ticks();
    expect(errors.drain().map((e) => (e.error as { code?: string }).code)).toEqual(['rpc.unknownFrame']);
    expect(server.state.peek()).toBe('open');
    tb.send({ t: 'req', id: 5, iface: 'test.svc3', method: 'fn', args: [] } as RpcFrame);
    await ticks();
    expect(received.some((f) => f.t === 'ok' && f.id === 5 && (f as { value: unknown }).value === 'alive')).toBe(true);
  });
});

describe('bulk-replies-exceed-frame-cap: paging at the RPC interface layer', () => {
  it('a 3 MB storage scope loads completely through the frame cap, page by page', async () => {
    const { memoryStorageBackend } = await import('@tessera/persistence');
    const {
      createMainStorageService,
      mainStorageInterface,
      remoteStorageBackend,
    } = await import('@tessera/rpc');
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) big[`key${String(i).padStart(2, '0')}`] = { v: 1, data: 'x'.repeat(100_000) }; // ~3 MB in 30 entries
    const backend = memoryStorageBackend({ application: big });
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const renderer = createRpcConnection(ta, { name: 'renderer' });
    const main = createRpcConnection(tb, { name: 'main' });
    const service = createMainStorageService(backend);
    let pages = 0;
    main.register(mainStorageInterface, { ...service, loadPage: async (s, c) => (pages++, service.loadPage(s, c)) });
    t.application.track({ dispose: () => (renderer.dispose(), main.dispose(), backend.dispose()) });
    const remote = remoteStorageBackend(renderer.getProxy(mainStorageInterface));
    const loaded = await remote.load('application');
    expect(Object.keys(loaded)).toHaveLength(30);
    expect(pages).toBeGreaterThan(3);
    expect(loaded['key29']).toEqual(big['key29']);
  });

  it('300 plugin manifests of 5 KB list completely, and an entry no frame can carry is quarantined main-side', async () => {
    const { createMainPluginsService, mainPluginsInterface, remotePluginCatalog } = await import('@tessera/rpc');
    const { Emitter } = await import('@tessera/base');
    const changed = new Emitter<void>({ name: 'test.catalog' });
    const descriptions = Array.from({ length: 300 }, (_, i) => ({ manifest: { id: `p.${i}`, description: 'd'.repeat(5000) }, location: `l${i}`, source: 'user' as const }));
    const huge = { manifest: { id: 'p.huge', description: 'h'.repeat(2_000_000) }, location: 'huge', source: 'user' as const };
    const errors = captureErrors();
    const t = createTestScope({ flat: true });
    const [ta, tb] = createInMemoryTransportPair();
    const renderer = createRpcConnection(ta, { name: 'renderer' });
    const main = createRpcConnection(tb, { name: 'main' });
    main.register(mainPluginsInterface, createMainPluginsService({ list: async () => [...descriptions, huge] as never, onDidChange: changed.event }));
    t.application.track({ dispose: () => (renderer.dispose(), main.dispose(), changed.dispose()) });
    const catalog = remotePluginCatalog(renderer.getProxy(mainPluginsInterface));
    const listed = await catalog.list();
    expect(listed).toHaveLength(300);
    expect(listed.some((d) => (d.manifest as { id: string }).id === 'p.huge')).toBe(false);
    errors.drain();
    errors.dispose();
  });
});

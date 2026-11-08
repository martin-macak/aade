import { Emitter, type IDisposable } from '@tessera/base';
import type { RpcFrame, RpcTransport } from '@tessera/contracts';

/**
 * Two connected transports in one realm. Frames are structured-cloned, like over a MessagePort, so a test cannot rely on
 * object identity, and delivery is asynchronous (a microtask), so a send never re-enters the sender.
 */
export function createInMemoryTransportPair(): readonly [RpcTransport, RpcTransport] {
  const a = new InMemoryTransport('a');
  const b = new InMemoryTransport('b');
  a.connect(b);
  b.connect(a);
  return [a, b];
}

class InMemoryTransport implements RpcTransport {
  readonly onFrame: RpcTransport['onFrame'];
  readonly onClose: RpcTransport['onClose'];
  readonly #frames = new Emitter<RpcFrame>({ name: 'rpc.memory.frame', deferInTransaction: false });
  readonly #closed = new Emitter<void>({ name: 'rpc.memory.close', deferInTransaction: false });
  readonly #name: string;
  #peer: InMemoryTransport | undefined;
  #isClosed = false;

  constructor(name: string) {
    this.#name = name;
    this.onFrame = this.#frames.event;
    this.onClose = this.#closed.event;
  }

  connect(peer: InMemoryTransport): void {
    this.#peer = peer;
  }

  send(frame: RpcFrame): void {
    if (this.#isClosed) return;
    const copy = structuredClone(frame);
    const peer = this.#peer;
    queueMicrotask(() => peer?.receive(copy));
  }

  receive(frame: RpcFrame): void {
    if (this.#isClosed) return;
    this.#frames.fire(frame);
  }

  /** The peer went away. */
  peerClosed(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#closed.fire();
    this.#frames.dispose();
    this.#closed.dispose();
  }

  dispose(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    const peer = this.#peer;
    queueMicrotask(() => peer?.peerClosed());
    this.#closed.fire();
    this.#frames.dispose();
    this.#closed.dispose();
  }

  toString(): string {
    return `InMemoryTransport(${this.#name})`;
  }
}

/** A transport over a MessagePort (browser, worker, Electron utility). Port transfer is not used in v1. */
export function messagePortTransport(port: MessagePort): RpcTransport {
  const frames = new Emitter<RpcFrame>({ name: 'rpc.port.frame', deferInTransaction: false });
  const closed = new Emitter<void>({ name: 'rpc.port.close', deferInTransaction: false });
  let isClosed = false;
  const onMessage = (event: MessageEvent): void => frames.fire(event.data as RpcFrame);
  port.addEventListener('message', onMessage as EventListener);
  port.addEventListener('close', () => close());
  port.start();
  function close(): void {
    if (isClosed) return;
    isClosed = true;
    port.removeEventListener('message', onMessage as EventListener);
    port.close();
    closed.fire();
    frames.dispose();
    closed.dispose();
  }
  const transport: RpcTransport = {
    send: (frame, transfer) => {
      if (!isClosed) port.postMessage(frame, [...(transfer ?? [])]);
    },
    onFrame: frames.event,
    onClose: closed.event,
    dispose: close,
  };
  return transport;
}

export type { IDisposable };

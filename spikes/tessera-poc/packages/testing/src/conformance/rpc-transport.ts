import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcFrame, RpcTransport } from '@tessera/contracts';

/** A real transport (a MessagePort) delivers on the event loop: wait for the condition, no fixed delay. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  await vi.waitFor(() => expect(predicate(), `rpcTransportConformance: waiting for ${what}`).toBe(true), { timeout: 2000, interval: 1 });
}

/** Lets the event loop run a few turns, so a message that was posted earlier has been delivered (when it is delivered at all). */
async function turns(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); // a macrotask turn, not a sleep
}

const hello = (name: string): RpcFrame => ({ t: 'hello', protocol: 1, name, interfaces: [] });

/**
 * Conformance suite for the RpcTransport port (contracts.md 17.2, poc-plan invariant I19). Run it against every transport:
 * in-memory and MessagePort. The two transports of a pair are connected to each other.
 */
export function rpcTransportConformance(name: string, create: () => readonly [RpcTransport, RpcTransport] | Promise<readonly [RpcTransport, RpcTransport]>): void {
  describe(`I19: RpcTransport conformance: ${name}`, () => {
    const live: RpcTransport[] = [];
    afterEach(() => {
      for (const t of live.splice(0)) t.dispose();
    });
    async function pair(): Promise<readonly [RpcTransport, RpcTransport]> {
      const [a, b] = await create();
      live.push(a, b);
      return [a, b];
    }

    it('I19: frames sent on one end arrive on the other, in order, in both directions', async () => {
      const [a, b] = await pair();
      const atB: RpcFrame[] = [];
      const atA: RpcFrame[] = [];
      b.onFrame((f) => atB.push(f));
      a.onFrame((f) => atA.push(f));
      a.send({ t: 'ack', id: 1 });
      a.send({ t: 'ack', id: 2 });
      a.send({ t: 'ack', id: 3 });
      b.send(hello('b'));
      await waitFor(() => atB.length === 3 && atA.length === 1, 'frames');
      expect(atB.map((f) => (f.t === 'ack' ? f.id : -1))).toEqual([1, 2, 3]);
      expect(atA[0]?.t).toBe('hello');
    });

    it('I19: a frame is copied (structured clone): changing the sent object later does not change what arrives', async () => {
      const [a, b] = await pair();
      const received: RpcFrame[] = [];
      b.onFrame((f) => received.push(f));
      const args = [{ n: 1 }];
      a.send({ t: 'req', id: 1, iface: 'x', method: 'm', args });
      args[0]!.n = 99;
      await waitFor(() => received.length === 1, 'frame');
      expect((received[0] as unknown as { args: Array<{ n: number }> }).args[0]?.n).toBe(1);
    });

    it('I19: disposing one end closes the other (onClose fires) and sending afterwards does not throw', async () => {
      const [a, b] = await pair();
      let closed = 0;
      b.onClose(() => closed++);
      a.dispose();
      await waitFor(() => closed === 1, 'close');
      expect(() => a.send({ t: 'bye', reason: 'late' })).not.toThrow();
      expect(() => b.send({ t: 'bye', reason: 'late' })).not.toThrow();
    });

    it('I19: after a transport is disposed it delivers no more frames', async () => {
      const [a, b] = await pair();
      const received: RpcFrame[] = [];
      b.onFrame((f) => received.push(f));
      b.dispose();
      a.send({ t: 'ack', id: 1 });
      await turns();
      expect(received).toEqual([]);
    });
  });
}

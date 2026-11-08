import { describe, expect, it } from 'vitest';
import { Emitter } from '@tessera/base';
import { defineTopic, type EventMeta, type EventRelay } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { tree } from './kit.ts';

function fakeRelay(): EventRelay & {
  readonly forwarded: Array<{ topicId: string; payload: unknown; origin: string }>;
  receive(topicId: string, payload: unknown, traceId?: string): void;
  dispose(): void;
} {
  const remote = new Emitter<{ readonly topicId: string; readonly payload: unknown; readonly traceId: string | undefined }>();
  const forwarded: Array<{ topicId: string; payload: unknown; origin: string }> = [];
  return {
    forwarded,
    forward: (topicId: string, payload: unknown, meta: EventMeta) => {
      forwarded.push({ topicId, payload, origin: meta.origin });
    },
    onRemote: remote.event,
    receive: (topicId, payload, traceId) => remote.fire({ topicId, payload, traceId }),
    dispose: () => remote.dispose(),
  };
}

const numberSchema = {
  safeParse: (input: unknown) => (typeof input === 'number' ? { success: true as const, data: input } : { success: false as const, error: { issues: [{ path: [], message: 'not a number' }] } }),
};

describe('C7: relay to other windows', () => {
  it('C7: only global publications of crossProcess topics with origin local are forwarded', () => {
    const t = tree();
    const relay = fakeRelay();
    const handle = t.bus.setRelay(relay);
    const cross = defineTopic<number>('relay.cross', { crossProcess: true, schema: numberSchema });
    const local = defineTopic<number>('relay.local');
    t.tasks.publish(cross, 1);
    t.tasks.publish(cross, 2, { scope: 'workItem' });
    t.tasks.publish(cross, 3, { scope: 'descendants' });
    t.tasks.publish(local, 4);
    expect(relay.forwarded).toEqual([{ topicId: 'relay.cross', payload: 1, origin: 'local' }]);
    handle.dispose();
    relay.dispose();
  });

  it('C7: a remote publication is validated, published at the root with scope global and origin remote, and never forwarded again', () => {
    const t = tree();
    const relay = fakeRelay();
    const handle = t.bus.setRelay(relay);
    const cross = defineTopic<number>('relay.in', { crossProcess: true, schema: numberSchema });
    const seen: Array<[number, string, string, string | undefined]> = [];
    t.other.subscribe(cross, (p, meta) => seen.push([p, meta.origin, meta.sourceNodeId, meta.traceId]));
    relay.receive('relay.in', 7, 'trace-1');
    expect(seen).toEqual([[7, 'remote', 'application', 'trace-1']]);
    expect(relay.forwarded).toEqual([]);
    handle.dispose();
    relay.dispose();
  });

  it('C7: an invalid remote payload is dropped and reported; an unknown topic id is dropped silently', () => {
    const t = tree();
    const capture = captureErrors();
    const relay = fakeRelay();
    const handle = t.bus.setRelay(relay);
    const cross = defineTopic<number>('relay.bad', { crossProcess: true, schema: numberSchema });
    const seen: number[] = [];
    t.other.subscribe(cross, (p) => seen.push(p));
    relay.receive('relay.bad', 'not a number');
    relay.receive('relay.never.seen', 1);
    expect(seen).toEqual([]);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context).toMatchObject({ source: 'ipc', target: 'relay.bad' });
    handle.dispose();
    relay.dispose();
  });

  it('C7: only one relay at a time; disposing the handle allows another', () => {
    const t = tree();
    const first = fakeRelay();
    const second = fakeRelay();
    const handle = t.bus.setRelay(first);
    expect(() => t.bus.setRelay(second)).toThrow(/already installed/);
    handle.dispose();
    const next = t.bus.setRelay(second);
    next.dispose();
    first.dispose();
    second.dispose();
  });

  it('C7: a throwing relay does not break local delivery', () => {
    const t = tree();
    const capture = captureErrors();
    const remote = new Emitter<never>();
    const handle = t.bus.setRelay({
      forward() {
        throw new Error('relay down');
      },
      onRemote: remote.event as never,
    });
    const cross = defineTopic<number>('relay.down', { crossProcess: true, schema: numberSchema });
    const seen: number[] = [];
    t.win.subscribe(cross, (n) => seen.push(n));
    t.tasks.publish(cross, 1);
    expect(seen).toEqual([1]);
    expect(capture.drain()).toHaveLength(1);
    capture.dispose();
    handle.dispose();
    remote.dispose();
  });
});

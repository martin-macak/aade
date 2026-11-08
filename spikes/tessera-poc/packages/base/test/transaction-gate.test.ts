import { describe, expect, it } from 'vitest';
import { captureErrors } from '@tessera/testing';
import { transactionGate } from '@tessera/base';

describe('C6: transaction gate savepoints', () => {
  it('outside a transaction defer() runs at once', () => {
    let ran = false;
    transactionGate.defer(() => (ran = true));
    expect(ran).toBe(true);
  });

  it('runs deferred work in FIFO order on the outermost commit only', () => {
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.defer(() => log.push('outer 1'));
    transactionGate.begin();
    transactionGate.defer(() => log.push('inner'));
    transactionGate.end(true);
    expect(log).toEqual([]);
    expect(transactionGate.depth).toBe(1);
    transactionGate.defer(() => log.push('outer 2'));
    transactionGate.end(true);
    expect(log).toEqual(['outer 1', 'inner', 'outer 2']);
    expect(transactionGate.depth).toBe(0);
  });

  it('C6: work deferred in a failed inner transaction is dropped even when the outer one commits', () => {
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.defer(() => log.push('before'));
    transactionGate.begin();
    transactionGate.defer(() => log.push('inside failed'));
    transactionGate.end(false);
    transactionGate.defer(() => log.push('after'));
    transactionGate.end(true);
    expect(log).toEqual(['before', 'after']);
  });

  it('C6: a failed outer transaction drops everything, including committed inner work', () => {
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.begin();
    transactionGate.defer(() => log.push('inner committed'));
    transactionGate.end(true);
    transactionGate.end(false);
    expect(log).toEqual([]);
  });

  it('C6: work deferred while flushing runs in the same flush, after the current items', () => {
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.defer(() => {
      log.push('a');
      transactionGate.defer(() => log.push('c, deferred by a'));
    });
    transactionGate.defer(() => log.push('b'));
    transactionGate.end(true);
    expect(log).toEqual(['a', 'b', 'c, deferred by a']);
  });

  it('a throwing item is reported (source listener) and does not stop the flush', () => {
    const capture = captureErrors();
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.defer(() => {
      throw new Error('x');
    });
    transactionGate.defer(() => log.push('still runs'));
    transactionGate.end(true);
    expect(log).toEqual(['still runs']);
    const reported = capture.drain();
    capture.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context.source).toBe('listener');
  });

  it('a transaction opened by a flushed item keeps its savepoint and commits with the flush', () => {
    const log: string[] = [];
    transactionGate.begin();
    transactionGate.defer(() => {
      transactionGate.begin();
      transactionGate.defer(() => log.push('nested ok'));
      transactionGate.end(true);
      transactionGate.begin();
      transactionGate.defer(() => log.push('nested failed'));
      transactionGate.end(false);
    });
    transactionGate.end(true);
    expect(log).toEqual(['nested ok']);
  });

  it('end() without begin() throws', () => {
    expect(() => transactionGate.end(true)).toThrow();
  });
});

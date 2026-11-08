import { describe, expect, it } from 'vitest';
import { state } from '@tessera/reactive';

describe('packaging contract: the host registers its module instances', () => {
  it('the host registers @tessera/base and @tessera/reactive under Symbol.for', () => {
    state(0); // the module is loaded
    const holder = globalThis as unknown as Record<symbol, { instance: object } | undefined>;
    expect(holder[Symbol.for('@tessera/base')]?.instance).toBeDefined();
    expect(holder[Symbol.for('@tessera/reactive')]?.instance).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';
import { captureErrors } from '@tessera/testing';
import { registerModuleInstance } from '@tessera/base';

describe('packaging contract: one module instance per realm (plugin-packaging-contract-missing)', () => {
  it('a second, different copy reports tessera.duplicateModule once and does not throw', () => {
    const errors = captureErrors();
    const first = {};
    const second = {};
    const pkg = `@tessera/test-duplicate-${Math.random()}`;
    expect(registerModuleInstance(pkg, first)).toBe(true);
    expect(registerModuleInstance(pkg, first)).toBe(true); // the same instance again: fine
    expect(() => registerModuleInstance(pkg, second)).not.toThrow();
    expect(registerModuleInstance(pkg, second)).toBe(false);
    expect(registerModuleInstance(pkg, {})).toBe(false);
    const reported = errors.drain();
    errors.dispose();
    expect(reported).toHaveLength(1); // once, not once per call
    expect(reported[0]?.error).toMatchObject({ code: 'tessera.duplicateModule', details: { pkg } });
    expect(reported[0]?.context.target).toBe(pkg);
  });
});

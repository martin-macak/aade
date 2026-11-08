import { describe, expect, it } from 'vitest';
import { FAIL_SETTING } from '../src/main.ts';
import { manifest } from '../src/manifest.ts';

describe('C16: sample.faulty manifest', () => {
  it('C16: the setting failOnActivate defaults to true and is declared in contributes.configuration', () => {
    const settings = manifest.contributes?.['configuration'] as Array<{ key: string; default: unknown }>;
    expect(settings.find((s) => s.key === FAIL_SETTING)?.default).toBe(true);
  });

  it('C16: it declares a command (activation by onCommand) and an interceptor, and requests no capability', () => {
    expect(manifest.contributes?.['commands']).toEqual([expect.objectContaining({ id: 'faulty.boom' })]);
    expect(manifest.capabilities).toBeUndefined();
    expect(manifest.activationEvents).toBeUndefined();
  });
});

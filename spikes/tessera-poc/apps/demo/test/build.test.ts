import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// C28: the demo app builds with Vite 8 (`vite build`). The test runs the build in memory (nothing is written) and checks
// the shape of the output: an HTML entry, one entry chunk, and the plugin code split into lazy chunks.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Output = { type: 'chunk' | 'asset'; fileName: string; code?: string; isEntry?: boolean; isDynamicEntry?: boolean };

describe('C28: vite build of the demo app', () => {
  it('C28: builds an index.html, one entry chunk, and separate lazy chunks for the plugin entries', async () => {
    const result = await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { write: false, sourcemap: false } });
    const outputs = ((Array.isArray(result) ? result : [result]) as unknown as Array<{ output: Output[] }>).flatMap((r) => r.output);
    expect(outputs.some((o) => o.fileName === 'index.html')).toBe(true);
    const chunks = outputs.filter((o) => o.type === 'chunk');
    const entry = chunks.filter((c) => c.isEntry);
    expect(entry).toHaveLength(1);
    // code that only a plugin's main entry contains is not in the entry chunk ...
    const taskMain = chunks.find((c) => c.code?.includes('Select a task first'));
    expect(taskMain).toBeDefined();
    expect(taskMain?.isEntry).toBe(false);
    expect(entry[0]?.code).not.toContain('Select a task first');
    expect(entry[0]?.code).not.toContain('sample.faulty failed on purpose');
    // ... and the same for the React UI entries, the audit plugin and the faulty plugin
    expect(chunks.find((c) => c.code?.includes('Pin this view'))?.isEntry).toBe(false);
    expect(chunks.find((c) => c.code?.includes('audit-commands'))?.isEntry).toBe(false);
    expect(chunks.find((c) => c.code?.includes('sample.faulty failed on purpose'))?.isEntry).toBe(false);
    // the framework itself is in the entry: React, dockview and the shell
    expect(entry[0]?.code).toContain('tessera-default-styles');
    expect(entry[0]?.code).toContain('dv-dockview');
    expect(chunks.filter((c) => c.isDynamicEntry).length).toBeGreaterThanOrEqual(6);
  }, 120_000);
});

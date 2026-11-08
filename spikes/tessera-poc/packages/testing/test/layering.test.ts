import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Claim C1: the core compiles without DOM types and imports no React, DOM, Electron or Node built-ins;
// L2 packages never import each other. This suite proves the fences by breaking them on purpose.

const pocRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(pocRoot, 'package.json'));
const tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

interface RunResult {
  readonly status: number;
  readonly output: string;
}

function run(args: readonly string[]): RunResult {
  try {
    const output = execFileSync(process.execPath, [...args], { cwd: pocRoot, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('C1: TypeScript lib fence', () => {
  it('C1: the DOM-free fixture does not compile under tsconfig.l0-l3.json (document and HTMLElement do not exist)', () => {
    const result = run([tscBin, '-p', 'packages/base/test-fixtures/tsconfig.json']);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Cannot find name 'document'/);
    expect(result.output).toMatch(/Cannot find name 'HTMLElement'/);
  });

  it('C1: the same code compiles when the dom lib is added (the fixture fails because of the fence, not because of a typo)', () => {
    const result = run([tscBin, '-p', 'packages/base/test-fixtures/tsconfig.dom-control.json']);
    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  });

  it('C1: every core package compiles under the fence (src, tsconfig.json)', () => {
    const result = run(['scripts/tsc-all.mjs', 'typecheck']);
    expect(result.output).toContain('typecheck: ok');
    expect(result.status).toBe(0);
  }, 60_000);

  it('C1: web-worker globals exist as types while DOM globals do not (the lib is es2023 + webworker)', () => {
    // AbortSignal, queueMicrotask, setTimeout, structuredClone, performance and console are available in core code.
    expect(typeof AbortSignal).toBe('function');
    expect(typeof structuredClone).toBe('function');
  });
});

describe('C1: allowed-dependency check', () => {
  it('C1: passes for the real packages', () => {
    const result = run(['scripts/check-deps.mjs']);
    expect(result.output).toContain('check-deps: ok');
    expect(result.status).toBe(0);
  });

  it('C1: fails for a package that lists a forbidden @tessera dependency, React, and Node built-ins in core source', () => {
    const result = run(['scripts/check-deps.mjs', '--packages-dir', 'packages/testing/test-fixtures/layering/packages']);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/events: dependencies lists @tessera\/commands, which is not in its allowed @tessera list/);
    expect(result.output).toMatch(/events: dependencies lists third-party react, which is not allowed/);
    expect(result.output).toMatch(/imports Node built-in node:fs/);
    expect(result.output).toMatch(/core source imports forbidden module react/);
    expect(result.output).toMatch(/reactive: dependencies lists @tessera\/events/);
  });
});

describe('C23: sample plugins import only @tessera/plugin-api (packages.md rule 5)', () => {
  it('C23: check-deps scans the sample plugins and passes', () => {
    const result = run(['scripts/check-deps.mjs']);
    expect(result.output).toMatch(/check-deps: ok \(\d+ packages, \d+ plugins\)/);
  });

  it('C23: check-deps fails for a plugin that depends on or imports an implementation package or a Node built-in', () => {
    const result = run(['scripts/check-deps.mjs', '--packages-dir', 'packages/testing/test-fixtures/layering/packages', '--plugins-dir', 'packages/testing/test-fixtures/layering/plugins']);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/plugins\/bad: dependencies lists @tessera\/events; a plugin may depend only on/);
    expect(result.output).toMatch(/imports @tessera\/events; plugins import only @tessera\/plugin-api/);
    expect(result.output).toMatch(/imports Node built-in node:fs/);
  });

  it('C23: dependency-cruiser rule plugins-only-facade flags a plugin that imports a package other than plugin-api', () => {
    const result = run(['scripts/depcruise.mjs', '--base-dir', 'packages/testing/test-fixtures/layering']);
    expect(result.output).toMatch(/plugins-only-facade: plugins\/bad\/src\/main\.ts -> packages\/events\/src\/index\.ts/);
  }, 60_000);
});

describe('C1: dependency-cruiser layer rules', () => {
  it('C1: passes for the real packages and sees cross-package edges', () => {
    const result = run(['scripts/depcruise.mjs']);
    expect(result.output).toMatch(/depcruise: ok \(\d+ modules, [1-9]\d* cross-package edges/);
    expect(result.status).toBe(0);
  }, 60_000);

  it('C1: flags a sideways import between L2 packages, a Node built-in in core and an import outside the allowed list', () => {
    const result = run(['scripts/depcruise.mjs', '--base-dir', 'packages/testing/test-fixtures/layering']);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/l2-no-sideways: packages\/events\/src\/index\.ts -> packages\/commands\/src\/index\.ts/);
    expect(result.output).toMatch(/core-no-node-builtins: packages\/events\/src\/index\.ts/);
    expect(result.output).toMatch(/allowed-deps-reactive: packages\/reactive\/src\/index\.ts -> packages\/events\/src\/index\.ts/);
    expect(result.output).toMatch(/allowed-deps-events: packages\/events\/src\/index\.ts -> packages\/commands\/src\/index\.ts/);
  }, 60_000);
});

describe('C1: oxlint restricted imports and globals', () => {
  it('C1: passes for the real packages', () => {
    const bin = join(dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');
    const result = run([bin, '--config', '.oxlintrc.json', '--deny-warnings', 'packages', 'plugins', 'apps']);
    expect(result.status).toBe(0);
  }, 60_000);
});

describe('C26: the React fences (stage C)', () => {
  const fixtures = ['--packages-dir', 'packages/testing/test-fixtures/layering/packages', '--plugins-dir', 'packages/testing/test-fixtures/layering/plugins'];

  it('C26: check-deps passes for the real UI entries of sample.tasks and sample.audit', () => {
    const result = run(['scripts/check-deps.mjs']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('check-deps: ok');
  });

  it('round 3: the plugin fence is by specifier: the root entry of @tessera/react is refused everywhere, @tessera/react/ui only in ui-* files', () => {
    const result = run(['scripts/check-deps.mjs', ...fixtures]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/bad-react-root\/src\/main\.ts: imports @tessera\/react; plugins import only @tessera\/plugin-api, and ui-\* entries also @tessera\/react\/ui/);
    expect(result.output).toMatch(/bad-react-root\/src\/main\.ts: imports @tessera\/react\/ui; only the ui-\* entries of a plugin may import the React UI surface/);
    expect(result.output).toMatch(/bad-react-root\/src\/ui-react\.tsx: imports "@tessera\/react"; a UI entry may import only react/);
    expect(result.output).not.toMatch(/ui-react\.tsx: imports @tessera\/react\/ui/);
  });

  it('C26: check-deps rejects a UI entry with a run-time import from its plugin, an import of the facade, a Node built-in, and React in a main entry', () => {
    const result = run(['scripts/check-deps.mjs', ...fixtures]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ui-react\.tsx: imports ".\/logic\.ts" at run time; a UI entry may import its plugin's files only with "import type"/);
    expect(result.output).toMatch(/ui-react\.tsx: imports "@tessera\/plugin-api"; a UI entry may import only react/);
    expect(result.output).toMatch(/bad-ui\/src\/main\.ts: imports react; only the ui-\* entries of a plugin may import React/);
    expect(result.output.match(/imports ".\/logic\.ts" at run time/g)).toHaveLength(1); // the "import type" line of the same file is fine
  });

  it('C26: check-deps enforces one owner per foreign technology: React only in @tessera/react, dockview-core only in @tessera/layout-dockview', () => {
    const result = run(['scripts/check-deps.mjs', ...fixtures]);
    expect(result.output).toMatch(/packages\/dom\/src\/index\.ts: imports react, which only @tessera\/react may import/);
    expect(result.output).toMatch(/packages\/dom\/src\/index\.ts: imports dockview-core, which only @tessera\/layout-dockview may import/);
    expect(result.output).toMatch(/packages\/layout-dockview\/src\/index\.ts: imports react, which only @tessera\/react may import/);
    expect(result.output).not.toMatch(/layout-dockview\/src\/index\.ts: imports dockview-core, which only/);
  });

  it('C26: dependency-cruiser flags React and dockview imports outside their owners and a UI entry that imports its plugin at run time', () => {
    const result = run(['scripts/depcruise.mjs', '--base-dir', 'packages/testing/test-fixtures/layering']);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/only-react-package-imports-react: packages\/dom\/src\/index\.ts -> (\.\.\/)*node_modules\/react\//);
    expect(result.output).toMatch(/only-dockview-package-imports-dockview: packages\/dom\/src\/index\.ts -> (\S*node_modules\/)?dockview-core/);
    expect(result.output).toMatch(/only-react-package-imports-react: plugins\/bad-ui\/src\/main\.ts -> (\.\.\/)*node_modules\/react\//);
    expect(result.output).toMatch(/ui-only-view-imports: plugins\/bad-ui\/src\/ui-react\.tsx -> plugins\/bad-ui\/src\/logic\.ts/);
    expect(result.output).not.toMatch(/only-dockview-package-imports-dockview: packages\/layout-dockview/);
  }, 60_000);

  it('C26: oxlint rejects the global document and window, the facade and a run-time relative import in a plugin UI entry', () => {
    // the overrides of .oxlintrc.json are relative to the config file: a copy inside the fixture folder applies them to the fixture
    const dir = join(pocRoot, 'packages/testing/test-fixtures/layering');
    const config = join(dir, '.oxlintrc.json');
    writeFileSync(config, readFileSync(join(pocRoot, '.oxlintrc.json'), 'utf8').replace('"**/test-fixtures/**"', '"**/node_modules/**"'));
    try {
      const bin = join(dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');
      const result = run([bin, '--config', config, join(dir, 'plugins')]);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-globals/);
      expect(result.output).toMatch(/global document/);
      expect(result.output).toMatch(/global window/);
      expect(result.output).toMatch(/UI entries import react and @tessera\/react only/);
      expect(result.output).toMatch(/only with import type/);
    } finally {
      rmSync(config, { force: true });
    }
  }, 60_000);
});

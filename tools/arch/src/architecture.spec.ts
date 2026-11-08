/**
 * Repo-level architecture rules. `pnpm archTest` runs them.
 *
 * ArchUnitTS sees imports in two ways, and each rule uses the one that fits.
 * The Nx project graph sees every dependency between projects, however the
 * import is written. The TypeScript program sees single files, but it marks an
 * import through a workspace package name as external. Its cycle check stops
 * at a package boundary for that reason.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractGraph, nxProjectSlices, projectFiles } from 'archunit';

const ROOT = resolve(import.meta.dirname, '../../..');
const TSCONFIG = join(ROOT, 'tsconfig.json');
const DIAGRAM = resolve(import.meta.dirname, '../architecture.puml');

/** Highest layer first. A layer may import only the layers after it. */
const LAYERS = ['apps', 'modules', 'libs'] as const;

/** A layer folder exists only once it holds a package. */
const PRESENT_LAYERS = LAYERS.filter((layer) => existsSync(join(ROOT, layer)));

const MAX_FILE_LINES = 400;

const TEST_FILE = /\.(?:spec|test)\.tsx?$/;
const PRODUCTION_FILE = /^(?!.*\.(?:spec|test)\.tsx?$).*\.tsx?$/;
const SIZED_FILE = /^(?!.*\.(?:spec|test)\.tsx?$)(?!.*\.generated\.tsx?$).*\.tsx?$/;

/**
 * Counts the lines of a repository-relative file.
 *
 * ArchUnitTS also offers `file.content`, but it reads the file relative to the
 * working directory and treats a failed read as an empty file. The size rule
 * would then always pass, so this function reads the file itself and throws.
 */
function lineCount(file: string): number {
  return readFileSync(join(ROOT, file), 'utf8').trimEnd().split('\n').length;
}

/** Returns the package of a repository-relative file, or undefined. */
function packageOf(file: string): string | undefined {
  return /^((?:apps|modules|libs|tools)\/[^/]+)\//.exec(file)?.[1];
}

describe('dependencies between projects', () => {
  it('match tools/arch/architecture.puml, so add a line there for a new dependency', async () => {
    const rule = nxProjectSlices(ROOT)
      .should()
      .ignoringExternalDependencies()
      .adhereToDiagramInFile(DIAGRAM);

    await expect(rule).toPassAsync();
  });
});

describe('layer order', () => {
  for (const [index, layer] of LAYERS.entries()) {
    if (!PRESENT_LAYERS.includes(layer)) continue;

    for (const higher of LAYERS.slice(0, index)) {
      it(`${layer} must not import ${higher}`, async () => {
        const rule = projectFiles(TSCONFIG)
          .inFolder(`${layer}/**`)
          .shouldNot()
          .dependOnFiles()
          .inFolder(`${higher}/**`);

        await expect(rule).toPassAsync({ allowEmptyTests: true });
      });
    }
  }
});

describe.each(PRESENT_LAYERS)('code in %s', (layer) => {
  it('has no import cycles inside a package', async () => {
    const rule = projectFiles(TSCONFIG).inFolder(`${layer}/**`).should().haveNoCycles();

    await expect(rule).toPassAsync();
  });

  it(`keeps production files at ${MAX_FILE_LINES} lines or fewer`, async () => {
    const rule = projectFiles(TSCONFIG)
      .inFolder(`${layer}/**`)
      .withName(SIZED_FILE)
      .should()
      .adhereTo(
        (file) => lineCount(file.path) <= MAX_FILE_LINES,
        `A production file must have at most ${MAX_FILE_LINES} lines. Split it by responsibility.`,
      );

    await expect(rule).toPassAsync();
  });

  it('never imports test files from production files', async () => {
    const rule = projectFiles(TSCONFIG)
      .inFolder(`${layer}/**`)
      .withName(PRODUCTION_FILE)
      .shouldNot()
      .dependOnFiles()
      .withName(TEST_FILE);

    await expect(rule).toPassAsync({ allowEmptyTests: true });
  });
});

describe('package boundaries', () => {
  it('forbid relative imports into another package, so use its package name', async () => {
    const graph = await extractGraph(TSCONFIG);

    const crossing = graph
      .filter((edge) => !edge.external)
      .filter((edge) => {
        const from = packageOf(edge.source);
        const to = packageOf(edge.target);
        return from !== undefined && to !== undefined && from !== to;
      })
      .map((edge) => `${edge.source} -> ${edge.target}`);

    expect(crossing).toEqual([]);
  });
});

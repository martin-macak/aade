// Writes tsconfig.json, tsconfig.test.json and tsconfig.build.json for every workspace package.
// The build references come from the package.json "dependencies" on other workspace packages.
// Usage: node scripts/sync-tsconfigs.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Which base each group of packages compiles against. Packages that touch the DOM or Node say so here. */
const LIB_BASE = {
  default: '../../tsconfig.l0-l3.json',
  dom: '../../tsconfig.dom.json',
};
const DOM_PACKAGES = new Set(['dom', 'react', 'layout-dockview', 'host-web']);

const packages = [];
for (const group of ['packages', 'plugins', 'apps']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    packages.push({ group, name, dir, pkg });
  }
}
const byName = new Map(packages.map((p) => [p.pkg.name, p]));

// A plugin with ui-* entries (React views) gets a second tsconfig for them with the DOM lib and JSX: the main entry and the
// presenters keep compiling under the DOM-free lib fence (tsconfig.json excludes src/ui-*), the UI entries compile under
// tsconfig.ui.json, and the build and the tests use the DOM config.
const hasUi = (dir) => existsSync(join(dir, 'src')) && readdirSync(join(dir, 'src')).some((f) => /^ui-.*\.tsx?$/.test(f));

const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

for (const { group, name, dir, pkg } of packages) {
  const base = group === 'packages' && DOM_PACKAGES.has(name) ? LIB_BASE.dom : LIB_BASE.default;
  const hasSrc = existsSync(join(dir, 'src'));
  const hasTest = existsSync(join(dir, 'test'));
  const ui = group === 'plugins' && hasUi(dir);
  const isDemo = group === 'apps' && name === 'demo';
  // headless tests import @tessera/dom (mount targets for the plain DOM mounter). They still run in Node: the types need the DOM lib, the runtime has none.
  const usesDomInTests = group === 'apps' && name === 'headless';
  write(join(dir, 'tsconfig.json'), {
    extends: base,
    ...(ui ? { exclude: ['src/ui-*'] } : {}),
    include: hasSrc ? (group === 'plugins' ? ['src', 'tessera-plugin.json'] : ['src']) : [],
  });
  if (ui) {
    write(join(dir, 'tsconfig.ui.json'), { extends: LIB_BASE.dom, include: ['src', 'tessera-plugin.json'] });
  }
  if (isDemo) {
    write(join(dir, 'tsconfig.json'), { extends: LIB_BASE.dom, compilerOptions: { types: ['vite/client'], isolatedDeclarations: false, noEmit: true }, include: ['src', 'vite.config.ts'] });
  }
  if (hasTest) {
    write(join(dir, 'tsconfig.test.json'), {
      extends: ui || isDemo || usesDomInTests ? LIB_BASE.dom : base,
      compilerOptions: { types: isDemo ? ['node', 'vite/client'] : ['node'], isolatedDeclarations: false },
      include: [...(hasSrc ? ['src'] : []), 'test'],
    });
  }
  if (hasSrc && group === 'plugins') {
    // Plugins keep their manifest (tessera-plugin.json) beside src; the build includes it.
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => byName.has(d));
    write(join(dir, 'tsconfig.build.json'), {
      extends: ui ? './tsconfig.ui.json' : './tsconfig.json',
      compilerOptions: { composite: true, noEmit: false, outDir: 'dist', rootDir: '.', tsBuildInfoFile: 'dist/.tsbuildinfo' },
      include: ['src', 'tessera-plugin.json'],
      references: deps.map((d) => ({ path: `../../${byName.get(d).group}/${byName.get(d).name}/tsconfig.build.json` })),
    });
  } else if (hasSrc && isDemo) {
    // the demo app is built by Vite; the TypeScript build only checks it (noEmit, so it is not a composite project)
    write(join(dir, 'tsconfig.build.json'), {
      extends: './tsconfig.json',
      compilerOptions: { composite: false, noEmit: true },
      include: ['src', 'vite.config.ts'],
    });
  } else if (hasSrc) {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => byName.has(d));
    write(join(dir, 'tsconfig.build.json'), {
      extends: './tsconfig.json',
      compilerOptions: { composite: true, noEmit: false, outDir: 'dist', rootDir: 'src', tsBuildInfoFile: 'dist/.tsbuildinfo' },
      include: ['src'],
      references: deps.map((d) => ({ path: `../../${byName.get(d).group}/${byName.get(d).name}/tsconfig.build.json` })),
    });
  }
}
console.log(`synced tsconfig files for ${packages.length} package(s)`);

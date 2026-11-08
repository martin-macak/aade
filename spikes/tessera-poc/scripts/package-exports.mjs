// The real exports of every package (round 2, package-api-lists-drift), and a check of the "Public API" columns of docs/3-architecture/packages.md.
// A name that the table lists but the package does not export is drift (the column was written by hand and rotted). The table may list a
// subset: it names the main exports. `--print` lists the real exports per package, so the column can be written from fact.
// Usage: node scripts/package-exports.mjs [--print]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(root, '..', 'docs', '3-architecture', 'packages.md');

function read(file) {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The names exported by a module file, following `export * from` and `export { } from`. */
function exportsOf(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return new Set();
  seen.add(file);
  const text = read(file);
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), m[1]);
    for (const name of exportsOf(target, seen)) names.add(name);
  }
  return names;
}

const packages = {};
for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const names = new Set();
  const entries = Object.entries(pkg.exports ?? {}).filter(([key]) => key !== './package.json');
  for (const [, value] of entries) {
    const file = typeof value === 'string' ? value : value.default ?? value.types;
    if (file) for (const n of exportsOf(resolve(dir, file))) names.add(n);
  }
  packages[`@tessera/${name}`] = names;
}

if (process.argv.includes('--print')) {
  for (const [name, names] of Object.entries(packages)) console.log(`${name}: ${[...names].sort().join(', ')}`);
  process.exit(0);
}
if (!existsSync(docPath)) {
  console.log(`package-exports: skipped (${docPath} not found: the docs folder is not next to the proof of concept)`);
  process.exit(0);
}

const problems = [];
let rows = 0;
for (const line of readFileSync(docPath, 'utf8').split('\n')) {
  const cells = line.split('|').map((c) => c.trim());
  const first = /^`(@tessera\/[a-z-]+)`$/.exec(cells[1] ?? '');
  if (!first) continue;
  const real = packages[first[1]];
  if (!real) continue; // a package that is not built yet (host-electron)
  rows++;
  const apiCell = cells[3] ?? '';
  for (const m of apiCell.matchAll(/`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g)) {
    const name = m[1];
    if (!real.has(name)) problems.push(`${first[1]}: the Public API column lists \`${name}\`, which the package does not export`);
  }
}
if (problems.length > 0) {
  console.error(`package-exports: ${problems.length} name(s) in packages.md are not real exports (run "node scripts/package-exports.mjs --print" for the real list):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`package-exports: ok (${rows} rows of packages.md checked against ${Object.keys(packages).length} packages)`);

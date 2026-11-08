// Runs the TypeScript 7 compiler for every workspace package.
// Usage: node scripts/tsc-all.mjs typecheck|build [package-name...]
//   typecheck: tsc -p tsconfig.json (src, with the DOM-free lib fence), tsconfig.ui.json (plugin UI entries, DOM lib) and tsconfig.test.json (src + test) per package.
//   build:     tsc -b over all tsconfig.build.json files (project references, declaration emit, dist/).
// Why not "tsc" from node_modules/.bin: @typescript/typescript6 pulls a typescript 6 alias whose bin
// is also called "tsc" and wins the .bin symlink. We resolve the TypeScript 7 bin explicitly.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

const mode = process.argv[2] ?? 'typecheck';
const only = new Set(process.argv.slice(3));

const dirs = [];
for (const group of ['packages', 'plugins', 'apps']) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    if (only.size > 0 && ![...only].some((o) => `${group}/${name}`.endsWith(o))) continue;
    dirs.push({ name: `${group}/${name}`, dir });
  }
}

function run(args, cwd) {
  const started = performance.now();
  try {
    execFileSync(process.execPath, [tscBin, ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, ms: 0, output: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

let failed = 0;
if (mode === 'build') {
  const projects = dirs.map((d) => join(d.dir, 'tsconfig.build.json')).filter((p) => existsSync(p));
  const result = run(['-b', ...projects], root);
  if (result.ok) console.log(`ok   build     ${projects.length} project(s) (${result.ms} ms)`);
  else {
    failed++;
    console.error(result.output);
  }
} else {
  for (const { name, dir } of dirs) {
    for (const file of ['tsconfig.json', 'tsconfig.ui.json', 'tsconfig.test.json']) {
      if (!existsSync(join(dir, file))) continue;
      const result = run(['-p', join(dir, file)], dir);
      if (result.ok) console.log(`ok   typecheck ${name} ${file} (${result.ms} ms)`);
      else {
        failed++;
        console.error(`FAIL typecheck ${name} ${file}`);
        console.error(result.output);
      }
    }
  }
}
if (failed > 0) {
  console.error(`${mode} failed`);
  process.exit(1);
}
console.log(`${mode}: ok`);

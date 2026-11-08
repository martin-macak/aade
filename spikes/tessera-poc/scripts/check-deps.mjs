// Allowed-dependency check (packages.md section 5, "Allowed-deps check") plus an import scan.
//  1. Every dependency of a package.json is in the closed list of scripts/layers.json.
//  2. Every bare import in src/ is declared in package.json (dependencies or peerDependencies).
//     Every bare import in test/ is declared in dependencies, peerDependencies or devDependencies.
//     (npm workspaces hoist, so a phantom import would compile. This script is the fence.)
//  3. Core source (src/) never imports React, DOM libraries, Electron, node: built-ins or vitest.
// Usage: node scripts/check-deps.mjs [--packages-dir <dir>]
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirArg = process.argv.indexOf('--packages-dir');
const packagesDir = dirArg > 0 ? resolve(process.argv[dirArg + 1]) : join(root, 'packages');
const rules = JSON.parse(readFileSync(join(root, 'scripts/layers.json'), 'utf8'));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const problems = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|[^\w.$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|declare\s+module\s+['"]([^'"]+)['"]/g;

function specifiers(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set();
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec && !spec.startsWith('.') && !spec.startsWith('/')) found.add(spec);
  }
  return [...found];
}

function packageName(spec) {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

for (const name of readdirSync(packagesDir).sort()) {
  const dir = join(packagesDir, name);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rule = rules.packages[name];
  if (!rule) {
    problems.push(`packages/${name}: not listed in scripts/layers.json`);
    continue;
  }
  const where = `packages/${name}`;

  // 1. declared dependencies against the closed list
  const allowedTessera = new Set(rule.tessera.map((n) => `@tessera/${n}`));
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[section] ?? {})) {
      if (dep.startsWith('@tessera/')) {
        if (!allowedTessera.has(dep)) problems.push(`${where}: ${section} lists ${dep}, which is not in its allowed @tessera list (${[...allowedTessera].join(', ') || 'none'})`);
      } else {
        const allowed = section === 'dependencies' ? rule.thirdParty : [...rule.thirdParty, ...rule.peerThirdParty];
        if (!allowed.includes(dep)) problems.push(`${where}: ${section} lists third-party ${dep}, which is not allowed (${allowed.join(', ') || 'none'})`);
      }
    }
  }
  // The internal packages move in lockstep at 0.0.0. @tessera/plugin-api is the exception: its version is the plugin API version (semver),
  // and a test (plugin-api/test/surface.test.ts) keeps it equal to TESSERA_API_VERSION.
  const expectedVersion = name === 'plugin-api' ? '1.0.0' : '0.0.0';
  if (pkg.version !== expectedVersion) problems.push(`${where}: version must be ${expectedVersion}${name === 'plugin-api' ? ' (the plugin API version)' : ' (lockstep)'}`);

  // 2 + 3. import scan
  const declaredRuntime = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const declaredAny = new Set([...declaredRuntime, ...Object.keys(pkg.devDependencies ?? {})]);
  for (const [folder, declared] of [['src', declaredRuntime], ['test', declaredAny]]) {
    for (const file of walk(join(dir, folder))) {
      for (const spec of specifiers(file)) {
        const dep = packageName(spec);
        const shown = relative(root, file);
        if (builtins.has(dep)) {
          if (folder === 'src' && rule.layer !== 'T') problems.push(`${shown}: imports Node built-in ${spec} (core must not)`);
          continue;
        }
        if (folder === 'src' && rules.coreLayers.includes(rule.layer) && rules.forbiddenInCore.includes(dep)) problems.push(`${shown}: core source imports forbidden module ${dep}`);
        // packages.md rule 4: one owner per foreign technology (L4 packages, which may use DOM libraries, but only their own)
        if (folder === 'src' && rule.layer === 'L4' && rules.foreignOwners[dep] && !rules.foreignOwners[dep].includes(name)) problems.push(`${shown}: imports ${dep}, which only @tessera/${rules.foreignOwners[dep].join(', @tessera/')} may import (one owner per foreign technology)`);
        if (dep === `@tessera/${name}`) continue; // self import
        if (!declared.has(dep)) problems.push(`${shown}: imports ${dep}, which ${where}/package.json does not declare`);
        if (dep.startsWith('@tessera/') && folder === 'src' && rule.layer !== 'T' && !allowedTessera.has(dep)) {
          problems.push(`${shown}: imports ${dep}, which is not allowed for ${name}`);
        }
      }
    }
  }
}

// 4. Sample plugins (poc/plugins/*): src imports only @tessera/plugin-api (and the rendering adapter in UI entries).
const pluginsArg = process.argv.indexOf('--plugins-dir');
const pluginsDir = pluginsArg > 0 ? resolve(process.argv[pluginsArg + 1]) : join(root, 'plugins');
let pluginCount = 0;
if (existsSync(pluginsDir) && (pluginsArg > 0 || dirArg < 0)) {
  const allowedPlugin = new Set(rules.pluginAllowed.map((n) => `@tessera/${n}`));
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    pluginCount++;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const where = `plugins/${name}`;
    for (const section of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        if (dep.startsWith('@tessera/') && !allowedPlugin.has(dep)) problems.push(`${where}: ${section} lists ${dep}; a plugin may depend only on ${[...allowedPlugin].join(', ')}`);
      }
    }
    // contracts.md 14.11: the shared singletons (the plugin API, the React adapter, React, the reactive engine, base) come from the host.
    // A plugin that lists one under `dependencies` would install a second copy next to the host's. They are peers (and dev dependencies).
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (rules.pluginAllowed.map((n) => `@tessera/${n}`).includes(dep) || dep.startsWith('@tessera/') || dep === 'react' || dep === 'react-dom') {
        problems.push(`${where}: dependencies lists the shared singleton ${dep}; list it under peerDependencies (and devDependencies for the build) so the plugin shares the host's copy (contracts.md 14.11)`);
      }
    }
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    // The tests of a plugin may import more (@tessera/testing, vitest), but each import must be declared in its package.json.
    for (const file of walk(join(dir, 'test'))) {
      for (const spec of specifiers(file)) {
        const dep = packageName(spec);
        if (builtins.has(dep) || dep === `@tessera/${name}`) continue;
        if (!declared.has(dep)) problems.push(`${relative(root, file)}: imports ${dep}, which ${where}/package.json does not declare (dependencies, peerDependencies or devDependencies)`);
      }
    }
    for (const file of walk(join(dir, 'src'))) {
      const isUi = /(^|\/)ui-[^/]*\.tsx?$/.test(file);
      if (isUi) checkUiFile(file);
      for (const spec of specifiers(file)) {
        const dep = packageName(spec);
        if (builtins.has(dep)) {
          problems.push(`${relative(root, file)}: imports Node built-in ${spec}`);
          continue;
        }
        if ((dep === 'react' || dep === 'react-dom') && !isUi) problems.push(`${relative(root, file)}: imports ${dep}; only the ui-* entries of a plugin may import React (packages.md rule 5)`);
        // Fence by specifier (round 3): @tessera/plugin-api anywhere; @tessera/react/ui only in ui-* files; the root entry of @tessera/react
        // (the renderer and the window chrome) and every other subpath of any @tessera package are refused.
        if (dep.startsWith('@tessera/') && spec !== '@tessera/plugin-api') {
          if (spec === '@tessera/react/ui') {
            if (!isUi) problems.push(`${relative(root, file)}: imports ${spec}; only the ui-* entries of a plugin may import the React UI surface (packages.md rule 5)`);
          } else problems.push(`${relative(root, file)}: imports ${spec}; plugins import only @tessera/plugin-api, and ui-* entries also @tessera/react/ui (packages.md rule 5)`);
        }
        if (!declared.has(dep)) problems.push(`${relative(root, file)}: imports ${dep}, which ${where}/package.json does not declare`);
      }
    }
  }
}

// C26(a): a plugin UI entry (src/ui-*) imports only react, @tessera/react and type-only imports from the plugin's own files.
function checkUiFile(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const shown = relative(root, file);
  for (const match of text.matchAll(/(?:^|[^\w.$])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const [, , isType, spec] = match;
    if (spec.startsWith('.')) {
      if (!isType) problems.push(`${shown}: imports "${spec}" at run time; a UI entry may import its plugin's files only with "import type" (no business logic in React, C26)`);
    } else if (!['react', 'react/jsx-runtime', '@tessera/react/ui'].includes(spec)) {
      problems.push(`${shown}: imports "${spec}"; a UI entry may import only react, react/jsx-runtime and @tessera/react/ui (C26; the main entry of @tessera/react is the renderer and the window chrome, not the plugin UI surface)`);
    }
  }
  if (/\bdynamic\s*import\s*\(|\bimport\s*\(/.test(text)) problems.push(`${shown}: dynamic import in a UI entry`);
}

if (problems.length > 0) {
  console.error(`check-deps: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-deps: ok (${readdirSync(packagesDir).length} packages, ${pluginCount} plugins)`);

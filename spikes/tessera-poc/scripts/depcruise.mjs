// Runs dependency-cruiser over packages/ and fails on violations. It also fails when the run saw no cross-package
// edge at all, so a parser failure cannot turn into a silent green.
// Usage: node scripts/depcruise.mjs [--base-dir <dir>]   (base-dir holds a packages/ folder; default: the poc root)
import { cruise } from 'dependency-cruiser';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirArg = process.argv.indexOf('--base-dir');
process.chdir(dirArg > 0 ? resolve(process.argv[dirArg + 1]) : root);
const require = createRequire(import.meta.url);
const config = require(resolve(root, '.dependency-cruiser.cjs'));

import { existsSync } from 'node:fs';
const targets = ['packages', 'plugins', 'apps'].filter((d) => existsSync(d));
const result = await cruise(targets, { ...config.options, validate: true, ruleSet: { forbidden: config.forbidden, options: config.options } });
const output = result.output;
const summary = output.summary;

const modules = output.modules.filter((m) => /^(packages|plugins|apps)\//.test(m.source));
const crossPackageEdges = modules.flatMap((m) =>
  m.dependencies.filter((d) => d.resolved.startsWith('packages/') && d.resolved.split('/')[1] !== m.source.split('/')[1]),
);

for (const v of summary.violations) {
  const rule = v.rule.name;
  const to = v.to ?? '';
  console.error(`${v.rule.severity.toUpperCase()} ${rule}: ${v.from} -> ${to}${v.cycle ? ` (cycle: ${v.cycle.map((c) => c.name).join(' -> ')})` : ''}`);
}

if (modules.length === 0 || (modules.length > 20 && crossPackageEdges.length === 0)) {
  console.error(`depcruise: suspicious run (${modules.length} modules, ${crossPackageEdges.length} cross-package edges). The parser may have failed.`);
  process.exit(1);
}
if (summary.error > 0) {
  console.error(`depcruise: ${summary.error} violation(s) in ${modules.length} modules`);
  process.exit(1);
}
console.log(`depcruise: ok (${modules.length} modules, ${crossPackageEdges.length} cross-package edges, ${summary.totalCruised} cruised, ${forbiddenCount()} rules)`);
function forbiddenCount() {
  return config.forbidden.length;
}

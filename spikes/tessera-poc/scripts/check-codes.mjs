// Error-code catalog check (round 2, error-code-catalog-incomplete): every error code that code in packages/*/src throws or reports
// must appear in contracts section 21 (docs/3-architecture/contracts.md). Codes are stable API; an undocumented one is drift.
// Usage: node scripts/check-codes.mjs [--list]   (--list prints the codes found in the source)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(root, '..', 'docs', '3-architecture', 'contracts.md');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Constructors and helpers whose first string argument is a code: new XError('code'), fail('code'), reject('code'), denied(id, '...') has none.
const AREAS = 'di|reactive|lifecycle|interceptor|bus|workItem|when|command|plugin|workbench|storage|rpc|shell|config|layout|undo|errors|view|tessera';
const CODE = new RegExp(String.raw`(?:new\s+\w*Error|\bfail|\breject)\(\s*(?:[\w.]+,\s*)?['"\`]((?:${AREAS})\.[A-Za-z.]+|cancelled|timeout|validation)['"\`]`, 'g');
const CODE_FIELD = new RegExp(String.raw`\bcode:\s*['"\`]((?:${AREAS})\.[A-Za-z.]+)['"\`]`, 'g');

const found = new Map();
for (const pkg of readdirSync(join(root, 'packages')).sort()) {
  for (const file of walk(join(root, 'packages', pkg, 'src'))) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of [CODE, CODE_FIELD]) for (const m of text.matchAll(re)) if (!found.has(m[1])) found.set(m[1], `packages/${pkg}`);
  }
}

if (process.argv.includes('--list')) {
  for (const code of [...found.keys()].sort()) console.log(code);
  process.exit(0);
}
if (!existsSync(docPath)) {
  console.log(`check-codes: skipped (${docPath} not found: the docs folder is not next to the proof of concept)`);
  process.exit(0);
}
const doc = readFileSync(docPath, 'utf8');
const start = doc.indexOf('## 21. Error codes');
const end = doc.indexOf('## 22.', start);
const section = start < 0 ? '' : doc.slice(start, end < 0 ? undefined : end);
const documented = new Set([...section.matchAll(/`([A-Za-z][A-Za-z.]*)`/g)].map((m) => m[1]));
const missing = [...found].filter(([code]) => !documented.has(code)).sort(([a], [b]) => a.localeCompare(b));
if (missing.length > 0) {
  console.error(`check-codes: ${missing.length} error code(s) in the source are not in contracts section 21:`);
  for (const [code, where] of missing) console.error(`  - ${code} (${where})`);
  process.exit(1);
}
console.log(`check-codes: ok (${found.size} codes in the source, all documented)`);

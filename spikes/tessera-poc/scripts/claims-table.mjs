// Prints the claims table of the POC report from a Vitest JSON report (docs/8-poc/poc-report.md).
//
// Counting rule (the one the report states):
//   - a test belongs to claim Cn when its own title or any title of its describe chain starts with "Cn:" or "Cn " (Cn = C1 ... C99);
//   - a test with two claim ids counts under both claims;
//   - the distinct total counts every test once, whatever the number of claims;
//   - a test with no claim id is "unclaimed" (it ran, but no claim covers it). They are listed by file, so a reader can see what no claim covers.
//     The earlier report called them "helpers", which hid that some of them test behavior (round 2, poc-report-counting-rule).
//
// Usage:
//   node scripts/claims-table.mjs                  runs "vitest run" (TESSERA_BROWSER=0 skips the browser projects) and prints the table
//   node scripts/claims-table.mjs results.json     reads a report made by "vitest run --reporter=json --outputFile=results.json"
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let reportPath = process.argv[2];
if (!reportPath) {
  const dir = join(root, 'node_modules', '.cache');
  mkdirSync(dir, { recursive: true });
  reportPath = join(dir, 'tessera-claims.json');
  try {
    execFileSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${reportPath}`], { cwd: root, stdio: 'ignore', env: process.env });
  } catch {
    // a failing test still leaves a report; the table shows the failed count
  }
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const claimOf = /^(C\d+)(?::|\s|$)/;
const claims = new Map();
const distinct = new Set();
let passed = 0;
let failed = 0;
const unclaimed = new Map();
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    const key = `${file.name}::${test.fullName}`;
    distinct.add(key);
    if (test.status === 'passed') passed++;
    else if (test.status === 'failed') failed++;
    const ids = new Set();
    for (const title of [...(test.ancestorTitles ?? []), test.title]) {
      const match = claimOf.exec(title ?? '');
      if (match) ids.add(match[1]);
    }
    if (ids.size === 0) {
      const where = file.name.startsWith(root) ? file.name.slice(root.length + 1) : file.name;
      unclaimed.set(where, (unclaimed.get(where) ?? 0) + 1);
    }
    for (const id of ids) {
      const entry = claims.get(id) ?? { tests: 0, failed: 0 };
      entry.tests++;
      if (test.status === 'failed') entry.failed++;
      claims.set(id, entry);
    }
  }
}

const rows = [...claims].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
console.log('| Claim | Tests | Failed |');
console.log('|---|---|---|');
for (const [id, entry] of rows) console.log(`| ${id} | ${entry.tests} | ${entry.failed} |`);
const counted = rows.reduce((sum, [, entry]) => sum + entry.tests, 0);
console.log('');
console.log(`Claims: ${rows.length}. Tests counted under a claim: ${counted} (a test with two claim ids counts twice).`);
console.log(`Distinct tests in the run: ${distinct.size} (passed ${passed}, failed ${failed}).`);
const unclaimedTotal = [...unclaimed.values()].reduce((sum, n) => sum + n, 0);
console.log(`Unclaimed tests (no claim id): ${unclaimedTotal} in ${unclaimed.size} files. Claimed tests: ${distinct.size - unclaimedTotal}.`);
if (unclaimed.size > 0) {
  console.log('');
  console.log('| Unclaimed tests by file | Tests |');
  console.log('|---|---|');
  for (const [where, n] of [...unclaimed].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`| \`${where}\` | ${n} |`);
}

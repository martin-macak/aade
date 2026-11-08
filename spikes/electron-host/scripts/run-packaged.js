'use strict';
// Runs the PACKAGED app (electron-builder --dir output) in --smoke mode, N times, and prints one summary JSON line.
// Exit code 0 only if every run exits 0, prints exactly one stdout line, and that line has ok:true.
//
//   node scripts/run-packaged.js              one run, prints the raw smoke line (what a CI job runs)
//   node scripts/run-packaged.js --runs 5     five runs, prints a summary with the median
//   node scripts/run-packaged.js --unpackaged also usable with the unpackaged app: see npm run smoke
//
// Wall time is measured here, from spawn to exit. The "ready" time is measured inside the app (see main.js).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const out = path.resolve(__dirname, '..', 'out');
const runsArg = process.argv.indexOf('--runs');
const runs = runsArg > -1 ? Number(process.argv[runsArg + 1]) : 1;

function findBinary() {
  if (process.env.SPIKE_BINARY) return process.env.SPIKE_BINARY;
  if (process.platform === 'darwin') {
    for (const dir of ['mac-arm64', 'mac']) {
      const p = path.join(out, dir, 'ElectronHostSpike.app', 'Contents', 'MacOS', 'ElectronHostSpike');
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'win32') {
    const p = path.join(out, 'win-unpacked', 'ElectronHostSpike.exe');
    if (fs.existsSync(p)) return p;
  } else {
    // The Linux executable name comes from electron-builder; pick the biggest executable in the unpacked dir.
    const dir = path.join(out, 'linux-unpacked');
    if (fs.existsSync(dir)) {
      const candidates = fs
        .readdirSync(dir)
        .map((name) => ({ name, full: path.join(dir, name) }))
        .filter((f) => fs.statSync(f.full).isFile() && (fs.statSync(f.full).mode & 0o111) !== 0)
        .sort((a, b) => fs.statSync(b.full).size - fs.statSync(a.full).size);
      if (candidates.length) return candidates[0].full;
    }
  }
  console.error('packaged binary not found under out/. Run: npm run pack');
  process.exit(2);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const binary = findBinary();
const samples = [];
let failed = false;
for (let i = 0; i < runs; i += 1) {
  const started = process.hrtime.bigint();
  const result = spawnSync(binary, ['--smoke'], { encoding: 'utf8', timeout: 45000 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const lines = (result.stdout || '').split('\n').filter((l) => l.length > 0);
  let parsed = null;
  try {
    parsed = lines.length === 1 ? JSON.parse(lines[0]) : null;
  } catch {
    parsed = null;
  }
  const ok = result.status === 0 && parsed !== null && parsed.ok === true;
  if (!ok) {
    failed = true;
    console.error(`run ${i + 1} failed: status=${result.status} signal=${result.signal} stdoutLines=${lines.length}`);
    console.error((result.stderr || '').slice(0, 2000));
    console.error(lines.join('\n').slice(0, 2000));
  }
  samples.push({ ok, wallMs, parsed, raw: lines[0] });
}

if (runs === 1) {
  // A CI job wants the literal line.
  process.stdout.write(`${samples[0].raw || ''}\n`);
} else {
  const kb = (parsed, type, named) => {
    const rows = (parsed.metrics || []).filter((m) => m.type === type && (!named || m.name === named));
    return rows.reduce((sum, m) => sum + m.workingSetKB, 0);
  };
  const good = samples.filter((s) => s.ok);
  const summary = {
    runs,
    allOk: !failed,
    readyMs: { samples: good.map((s) => Math.round(s.parsed.timingMs.ready)), median: median(good.map((s) => s.parsed.timingMs.ready)) },
    wallMs: { samples: good.map((s) => Math.round(s.wallMs)), median: median(good.map((s) => s.wallMs)), note: 'spawn to exit; includes the 1.5 s main-thread block test and the hardening probes' },
    workingSetKB: {
      browser: median(good.map((s) => kb(s.parsed, 'Browser'))),
      renderer: median(good.map((s) => kb(s.parsed, 'Tab'))),
      pluginHost: median(good.map((s) => kb(s.parsed, 'Utility', 'tessera-plugin-host'))),
      gpu: median(good.map((s) => kb(s.parsed, 'GPU'))),
      networkService: median(good.map((s) => kb(s.parsed, 'Utility', 'Network Service'))),
      total: median(good.map((s) => (s.parsed.metrics || []).reduce((sum, m) => sum + m.workingSetKB, 0))),
    },
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
process.exit(failed ? 1 : 0);

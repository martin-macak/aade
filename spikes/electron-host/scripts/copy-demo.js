'use strict';
// Copies the Tessera demo build (spikes/tessera-poc/apps/demo/dist) into ./renderer and injects the spike's
// main-world helper (src/bridge.js) as the first script of index.html. Nothing under spikes/tessera-poc changes.
//
// Build the demo first:   mise exec -- npm run build:tessera-demo
// Then:                   mise exec -- npm run copy:demo

const fs = require('node:fs');
const path = require('node:path');

const spikeRoot = path.resolve(__dirname, '..');
const demoDist = path.resolve(spikeRoot, '..', 'tessera-poc', 'apps', 'demo', 'dist');
const target = path.join(spikeRoot, 'renderer');

if (!fs.existsSync(path.join(demoDist, 'index.html'))) {
  console.error('Tessera demo build not found. Run: npm run build:tessera-demo');
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(demoDist, target, { recursive: true });
fs.copyFileSync(path.join(spikeRoot, 'src', 'bridge.js'), path.join(target, 'bridge.js'));

const indexPath = path.join(target, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('<head>')) {
  console.error('index.html has no <head>; cannot inject bridge.js');
  process.exit(1);
}
// Classic script, first in <head>: it runs before the demo's module script and sees CSP violations from the start.
fs.writeFileSync(indexPath, html.replace('<head>', '<head>\n    <script src="/bridge.js"></script>'));

const count = fs.readdirSync(path.join(target, 'assets')).length;
console.log(`copied Tessera demo build to renderer/ (${count} asset files) and injected bridge.js`);

'use strict';
// Main process of the Electron host spike. Throwaway: it exists to test one hypothesis.
//   Electron 45 with a hardened, sandboxed renderer hosts the Tessera React 19 + dockview demo, a
//   utility-process plugin host is reachable from the renderer over a MessagePort, and the packaged app starts.
//
// Run modes:
//   electron .            normal window (shown), same code path
//   electron . --smoke    hidden window, no dock icon, prints exactly one JSON line, exits 0 or 1
//
// stdout belongs to the smoke result line. Diagnostics go to stderr.
//
// Reproduce (every command through mise; the Tessera demo needs `npm ci` in ../tessera-poc once):
//   mise exec -- npm ci
//   mise exec -- npx install-electron         Electron 45 has no postinstall: the binary downloads lazily
//   mise exec -- npm run build                builds the Tessera demo, copies it to renderer/, injects bridge.js
//   mise exec -- npm run --silent smoke       unpackaged smoke run
//   mise exec -- npm run pack                 electron-builder --dir for the current platform
//   mise exec -- npm run --silent smoke:packaged   one packaged smoke run, prints the raw JSON line
//   mise exec -- npm run --silent bench       five packaged runs, prints medians
//
// Findings recorded in code comments: the CSP deviation (style-src-elem) is at CSP below; the main-thread
// block test in runSmoke proves that ping/pong does not pass through main; the plugin host is an unsandboxed
// utility process (osSandboxed is false in app.getAppMetrics()), the renderer is OS-sandboxed (true).

const { app, BrowserWindow, MessageChannelMain, ipcMain, protocol, session, utilityProcess } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_TIMEOUT_MS = 30000;
const SCHEME = 'app';
const HOST = 'tessera';
const ENTRY_URL = `${SCHEME}://${HOST}/index.html`;
const RENDERER_ROOT = path.join(__dirname, 'renderer');
// Harness self-test only: SPIKE_NEGATIVE=kill-host or =unsafe-prefs makes the smoke run fail on purpose,
// so the checks are shown not to be vacuous. Unset in every real run.
const NEGATIVE = process.env.SPIKE_NEGATIVE || '';
const BLOCK_MS = 1500; // how long main blocks its own JavaScript thread in the direct-path test

// Time origin: when the OS created this process (before Electron loaded). Falls back to the JS clock.
const creationTime = typeof process.getCreationTime === 'function' ? process.getCreationTime() : null;
const sinceStart = () => (creationTime ? Date.now() - creationTime : Math.round(performance.now()));

const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

// The scheme must be registered before the app is ready. standard: relative URLs and origins behave as for
// https. secure: a secure context, so the page may use APIs that need one. supportFetchAPI: fetch() works.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// CSP, sent as a response header by the protocol handler. The strictest form was tested first
// (style-src 'self'): it blocked two <style> elements that the demo creates at run time, so the layout
// CSS was missing. Deviation: style-src-elem allows 'unsafe-inline'. The element injected by dockview-core
// (its stylesheet) and by @tessera/react (its default styles, option injectStyles) set textContent
// from JS strings, so only a nonce or a hash could avoid this, and neither library path takes one here.
// Inline style ATTRIBUTES stay blocked (style-src-attr falls back to style-src 'self'); the demo set none.
// script-src stays 'self' without 'unsafe-eval'. One benign violation remains: zod probes Function('')
// in a try/catch to pick its non-JIT path.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function respond(status, body, extra) {
  return new Response(body, {
    status,
    headers: {
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      ...extra,
    },
  });
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return respond(403, 'forbidden', { 'content-type': 'text/plain' });
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return respond(400, 'bad request', { 'content-type': 'text/plain' });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = path.normalize(path.join(RENDERER_ROOT, pathname));
    // Reject anything that leaves the renderer root (../ tricks, absolute paths, encoded separators).
    if (file !== RENDERER_ROOT && !file.startsWith(RENDERER_ROOT + path.sep)) {
      return respond(403, 'forbidden', { 'content-type': 'text/plain' });
    }
    try {
      // fs.readFile also reads inside app.asar. The renderer files are not unpacked.
      const data = await fs.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return respond(200, data, { 'content-type': type });
    } catch {
      return respond(404, 'not found', { 'content-type': 'text/plain' });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// Plugin host: a utility process. Main only brokers the MessageChannel; it never listens on the ports.

const hardening = { openDenied: 0, navBlocked: 0 };
const pluginHost = { child: null, pid: null, exited: false, exitCode: null, ready: false, attachedCount: 0, ownMessages: 0 };
let portHandoffs = 0;

function startPluginHost() {
  const child = utilityProcess.fork(path.join(__dirname, 'plugin-host.js'), [], {
    serviceName: 'tessera-plugin-host',
    stdio: 'pipe', // keep the child's output away from our stdout line
  });
  pluginHost.child = child;
  child.stdout?.on('data', (d) => process.stderr.write(`[plugin-host] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[plugin-host] ${d}`));
  child.on('spawn', () => {
    pluginHost.pid = child.pid;
  });
  child.on('message', (message) => {
    // Control messages only (ready, attached). Ping/pong never arrives here.
    pluginHost.ownMessages += 1;
    if (message && message.type === 'ready') pluginHost.ready = true;
    if (message && message.type === 'attached') pluginHost.attachedCount += 1;
  });
  child.on('exit', (code) => {
    pluginHost.exited = true;
    pluginHost.exitCode = code;
  });
  if (NEGATIVE === 'kill-host') child.on('spawn', () => child.kill());
  return child;
}

// Page -> preload -> main: "give me a port". Main checks the sender before it creates a channel.
ipcMain.on('plugin-port-request', (event) => {
  const frameUrl = event.senderFrame ? event.senderFrame.url : '';
  if (!frameUrl.startsWith(`${SCHEME}://${HOST}/`)) {
    log('refused plugin-port-request from', frameUrl);
    return;
  }
  if (!pluginHost.child || pluginHost.exited) {
    log('plugin host is not running; no port handed out');
    return;
  }
  const { port1, port2 } = new MessageChannelMain();
  pluginHost.child.postMessage({ type: 'attach' }, [port1]);
  event.sender.postMessage('plugin-port', null, [port2]);
  portHandoffs += 1;
  // From here on main holds neither port in any usable way: both ends were transferred.
});

// ---------------------------------------------------------------------------------------------------------
// Window

function createWindow() {
  const unsafe = NEGATIVE === 'unsafe-prefs';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: !unsafe,
      sandbox: !unsafe,
      nodeIntegration: unsafe,
      webviewTag: false,
    },
  });
  const wc = win.webContents;

  // No new windows, ever.
  wc.setWindowOpenHandler(() => {
    hardening.openDenied += 1;
    return { action: 'deny' };
  });
  // Navigation stays inside the app origin. Location.reload() of the demo is same-origin and passes.
  const allowed = (url) => url.startsWith(`${SCHEME}://${HOST}/`);
  wc.on('will-navigate', (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      hardening.navBlocked += 1;
      log('blocked navigation to', url);
    }
  });
  wc.on('will-redirect', (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      log('blocked redirect to', url);
    }
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
  return win;
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

// ---------------------------------------------------------------------------------------------------------
// Smoke mode

let finished = false;
function finish(result, code) {
  if (finished) return;
  finished = true;
  const line = JSON.stringify(result);
  // macOS pipes are asynchronous: exit only after the write has flushed, or the line can be cut.
  process.stdout.write(`${line}\n`, () => app.exit(code));
}

const blockMainThread = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function runSmoke(win) {
  const wc = win.webContents;
  const consoleErrors = [];
  wc.on('console-message', (event) => {
    // Electron 45 passes one details object. Level is a string such as 'error'.
    const level = event.level ?? '';
    if (level === 'error' || level === 3) consoleErrors.push(String(event.message ?? '').slice(0, 300));
  });
  const failures = [];
  const fail = (reason) => failures.push(reason);

  const page = await wc.executeJavaScript('window.__smoke()', true);
  const readyMs = sinceStart(); // all page checks passed: demo rendered a docked panel and the port round trip is done

  // Memory at ready, before the direct-path test disturbs anything.
  const metrics = app.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    name: m.name ?? null,
    workingSetKB: m.memory.workingSetSize,
    peakWorkingSetKB: m.memory.peakWorkingSetSize,
    privateKB: m.memory.privateBytes ?? null,
    osSandboxed: m.sandboxed ?? null,
  }));

  // (a) a docked panel with React-rendered content exists
  const p = page.panel;
  const panelOk =
    p.dockviewRoot && p.dockPanel && p.reactRendered && p.tasksViewChildren > 0 && p.filterInput && p.rect.width > 50 && p.rect.height > 50;
  if (!panelOk) fail('panel: no docked React panel');

  // (b) the main world has no Node
  const mw = page.mainWorld;
  const isolatedOk = mw.typeofRequire === 'undefined' && mw.typeofProcess === 'undefined';
  if (!isolatedOk) fail(`main world: typeof require=${mw.typeofRequire}, typeof process=${mw.typeofProcess}`);

  // (c) MessagePort ping/pong round trip, answered by the utility process (pid equals the forked child's pid)
  const pingsOk =
    page.pings.length === 3 &&
    page.pings.every((x) => x.pid === pluginHost.child.pid && x.processType === 'utility') &&
    page.pings.map((x) => x.seq).join() === '1,2,3';
  if (!pingsOk) fail(`port round trip: pings=${JSON.stringify(page.pings)}, child pid=${pluginHost.child.pid}`);

  // (d) the utility process is alive
  let signalOk = false;
  try {
    process.kill(pluginHost.child.pid, 0);
    signalOk = true;
  } catch {
    signalOk = false;
  }
  const inMetrics = metrics.some((m) => m.type === 'Utility' && m.pid === pluginHost.child.pid);
  const utilityOk = pluginHost.child.pid > 0 && !pluginHost.exited && signalOk && inMetrics;
  if (!utilityOk) fail(`utility process not alive: exited=${pluginHost.exited}, signal0=${signalOk}, inMetrics=${inMetrics}`);

  // Extra evidence that main is not on the path: block main's JavaScript thread for BLOCK_MS and run a ping
  // from the renderer inside that window. If the round trip completes while main is blocked, main did not relay it.
  const ipcBefore = pluginHost.ownMessages;
  const pending = wc.executeJavaScript('window.__directPing(200)', true);
  await new Promise((r) => setTimeout(r, 50)); // let the request leave main before it blocks
  const blockStart = Date.now();
  blockMainThread(BLOCK_MS);
  const blockEnd = Date.now();
  const direct = await pending;
  const insideBlock = direct.sentWall >= blockStart && direct.receivedWall <= blockEnd;
  const directOk = insideBlock && direct.pid === pluginHost.child.pid && direct.rttMs < BLOCK_MS / 2;
  if (!directOk) fail(`direct path: round trip not inside main's blocked window: ${JSON.stringify({ blockStart, blockEnd, direct })}`);

  // Hardening probes. Cases that must be refused: window.open, and navigation to a foreign origin.
  const opened = await wc.executeJavaScript("window.open('https://example.invalid/') === null", true);
  await wc.executeJavaScript("setTimeout(() => location.assign('https://example.invalid/'), 0); true", true);
  await new Promise((r) => setTimeout(r, 300));
  const stillOnApp = wc.getURL().startsWith(`${SCHEME}://${HOST}/`);
  const prefs = wc.getLastWebPreferences();
  const hardeningOk =
    opened && hardening.openDenied >= 1 && hardening.navBlocked >= 1 && stillOnApp &&
    prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false && prefs.webviewTag === false;
  if (!hardeningOk) fail(`hardening: ${JSON.stringify({ opened, ...hardening, stillOnApp, prefs: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag } })}`);

  // Optional, for a human look at the hidden window: --screenshot=<file.png> (not part of the checks).
  const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
  if (shotArg) {
    const image = await wc.capturePage();
    await fs.writeFile(shotArg.slice('--screenshot='.length), image.toPNG());
  }

  const violations = page.cspViolations;
  const ok = failures.length === 0;
  return {
    ok,
    failures,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    checks: {
      dockedReactPanel: !!panelOk,
      mainWorldNoNode: !!isolatedOk,
      portRoundTrip: !!pingsOk,
      utilityAlive: !!utilityOk,
      portDirectNotViaMain: !!directOk,
      hardeningHolds: !!hardeningOk,
    },
    webPreferences: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag },
    hardening: { windowOpenReturnedNull: opened, openDenied: hardening.openDenied, foreignNavBlocked: hardening.navBlocked, stillOnAppOrigin: stillOnApp },
    panel: { tabTitles: p.tabTitles, tasksViewChildren: p.tasksViewChildren, rect: p.rect },
    mainWorld: { typeofRequire: mw.typeofRequire, typeofProcess: mw.typeofProcess, typeofModule: mw.typeofModule, typeofBuffer: mw.typeofBuffer },
    pings: page.pings.map((x) => ({ rttMs: Number(x.rttMs.toFixed(2)), pid: x.pid, seq: x.seq })),
    direct: { rttMs: Number(direct.rttMs.toFixed(2)), mainBlockedMs: blockEnd - blockStart, insideBlock, controlMessagesToMainDuringBlock: pluginHost.ownMessages - ipcBefore },
    pluginHost: { pid: pluginHost.pid, handoffs: portHandoffs },
    cspViolations: violations.length,
    cspViolationDetail: violations.slice(0, 5),
    consoleErrors: consoleErrors.length,
    consoleErrorSamples: consoleErrors.slice(0, 3),
    timingMs: { ready: readyMs, panel: Math.round(p.panelMs), appMounted: Math.round(p.mountedMs) },
    timingNote: 'ready = ms from OS process creation (process.getCreationTime) until the docked panel and port round trip were verified',
    metrics,
  };
}

// ---------------------------------------------------------------------------------------------------------

if (SMOKE) {
  // Never steal focus on the developer's desktop.
  if (app.dock) app.dock.hide();
}

app.whenReady().then(async () => {
  registerProtocol();
  hardenSession();
  startPluginHost();
  const win = createWindow();

  if (SMOKE) {
    const timer = setTimeout(() => {
      finish({ ok: false, failures: [`smoke timeout after ${SMOKE_TIMEOUT_MS} ms`] }, 1);
    }, SMOKE_TIMEOUT_MS);
    timer.unref?.();
    win.webContents.on('render-process-gone', (_e, details) => {
      finish({ ok: false, failures: [`renderer gone: ${details.reason}`] }, 1);
    });
    win.webContents.on('did-fail-load', (_e, code, description, url) => {
      finish({ ok: false, failures: [`did-fail-load ${code} ${description} ${url}`] }, 1);
    });
    pluginHost.child.on('exit', (code) => {
      if (!finished) log('plugin host exited with code', code);
    });
    try {
      await win.loadURL(ENTRY_URL);
      const result = await runSmoke(win);
      finish(result, result.ok ? 0 : 1);
    } catch (error) {
      finish({ ok: false, failures: [`exception: ${error && error.message ? error.message : String(error)}`] }, 1);
    }
  } else {
    win.loadURL(ENTRY_URL);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (pluginHost.child && !pluginHost.exited) pluginHost.child.kill();
});

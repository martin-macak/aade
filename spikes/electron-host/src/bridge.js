'use strict';
// Main-world helper, injected into the copied index.html by scripts/copy-demo.js as a classic script
// (before the demo's module script). It is the only code of this spike that runs in the page.
//  - records CSP violations from the first moment
//  - asks the preload for the plugin-host MessagePort and does ping/pong over it
//  - offers window.__smoke() and window.__directPing(), which main drives with executeJavaScript
// executeJavaScript runs in the main world, so typeof require / typeof process below are the page's view.
(function () {
  var violations = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample || '' });
  });

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function waitFor(fn, label, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    for (;;) {
      var value = fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + label);
      await sleep(20);
    }
  }

  var portPromise = null;
  var pending = new Map();
  var nextNonce = 1;

  function requestPort() {
    if (portPromise) return portPromise;
    portPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no MessagePort from preload within 10 s')); }, 10000);
      function onMessage(event) {
        if (event.source !== window || !event.data || event.data.type !== 'tessera:plugin-port') return;
        if (event.ports.length !== 1) return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        var port = event.ports[0];
        port.onmessage = function (e) {
          var d = e.data;
          if (d && d.type === 'pong' && pending.has(d.nonce)) {
            pending.get(d.nonce)(d);
            pending.delete(d.nonce);
          }
        };
        resolve(port);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'tessera:port-request' }, window.location.origin);
    });
    return portPromise;
  }

  async function ping() {
    var port = await requestPort();
    var nonce = 'n' + nextNonce++;
    var sentWall = Date.now();
    var sent = performance.now();
    var reply = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { pending.delete(nonce); reject(new Error('pong timeout')); }, 5000);
      pending.set(nonce, function (d) { clearTimeout(timer); resolve(d); });
      port.postMessage({ type: 'ping', nonce: nonce });
    });
    return {
      nonce: nonce,
      rttMs: performance.now() - sent,
      sentWall: sentWall,
      receivedWall: Date.now(),
      pid: reply.pid,
      processType: reply.processType,
      seq: reply.seq,
    };
  }

  function hasReactFiber(el) {
    return Object.keys(el).some(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactProps$') === 0; });
  }

  async function smoke() {
    var started = performance.now();
    var app = await waitFor(function () {
      var el = document.getElementById('app');
      return el && el.childElementCount > 0 ? el : null;
    }, '#app mounted');
    var mountedMs = performance.now() - started;

    // The demo opens no view on a clean start. Press "1b. Tasks in dock tab" to put a React view in a dockview panel.
    var button = await waitFor(function () { return document.querySelector('[data-demo="open-editor"]'); }, 'open-editor button');
    button.click();

    var view = await waitFor(function () {
      return document.querySelector('.tessera-dock-panel [data-testid="tasks-view"]');
    }, 'docked tasks view');
    var panel = view.closest('.tessera-dock-panel');
    var dockRoot = view.closest('.dv-dockview');
    var tabs = Array.prototype.map.call(document.querySelectorAll('.dv-tessera-tab-title'), function (t) { return t.textContent; });
    var panelMs = performance.now() - started;

    // Port round trip: three pings, all must answer from the same utility process.
    var pings = [];
    for (var i = 0; i < 3; i++) pings.push(await ping());

    return {
      panel: {
        dockviewRoot: !!dockRoot,
        dockPanel: !!panel,
        reactRendered: hasReactFiber(view),
        tasksViewChildren: view.childElementCount,
        rect: (function () { var r = view.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })(),
        filterInput: !!view.querySelector('input[aria-label="Local filter"]'),
        tabTitles: tabs,
        mountedMs: mountedMs,
        panelMs: panelMs,
      },
      mainWorld: {
        typeofRequire: typeof require,
        typeofProcess: typeof process,
        typeofModule: typeof module,
        typeofBuffer: typeof Buffer,
        typeofGlobal: typeof global,
        typeofElectron: typeof window.electron,
        isolated: typeof require === 'undefined' && typeof process === 'undefined',
      },
      pings: pings,
      cspViolations: violations.slice(),
    };
  }

  // Pings after `delayMs` and reports wall-clock start and end, so main can show that the whole
  // round trip happened while main's JavaScript thread was blocked.
  async function directPing(delayMs) {
    await requestPort();
    await sleep(delayMs);
    return ping();
  }

  window.__smoke = smoke;
  window.__directPing = directPing;
})();

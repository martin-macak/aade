'use strict';
// Sandboxed preload (CommonJS, require('electron') only). With contextIsolation the preload runs in an
// isolated world, so it cannot hand a MessagePort to the page through contextBridge. It relays the port
// with window.postMessage instead, the pattern of the Electron "MessagePorts" tutorial.
//
// Handshake, because the page scripts run after the preload and a port that arrives early would be lost:
//   1. page (src/bridge.js) posts {type:'tessera:port-request'} to its own window
//   2. preload forwards it to main with ipcRenderer.send('plugin-port-request')
//   3. main creates a MessageChannelMain, gives port1 to the utility process, port2 to this frame
//   4. preload relays port2 to the main world with window.postMessage(..., ports)
// The page can request a port, but main checks the sender frame URL before it creates a channel.

const { ipcRenderer } = require('electron');

const ORIGIN = window.location.origin;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'tessera:port-request') return;
  ipcRenderer.send('plugin-port-request');
});

ipcRenderer.on('plugin-port', (event) => {
  window.postMessage({ type: 'tessera:plugin-port' }, ORIGIN, event.ports);
});

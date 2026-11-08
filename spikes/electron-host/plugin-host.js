'use strict';
// Plugin host: runs in an Electron utility process (utilityProcess.fork). Main hands it one end of a
// MessageChannelMain over process.parentPort. The renderer holds the other end, so after the handoff
// ping/pong traffic flows renderer <-> utility process and main is not on the path. In a real host this
// is where plugin code would run. Here it only answers pings, with its own pid as proof of origin.
// Nothing may be written to stdout: smoke mode prints exactly one JSON line from main.

const parentPort = process.parentPort;

parentPort.on('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'attach' || event.ports.length !== 1) return;
  const port = event.ports[0];
  let pings = 0;
  port.on('message', (portEvent) => {
    const data = portEvent.data;
    if (!data || data.type !== 'ping') return;
    pings += 1;
    port.postMessage({
      type: 'pong',
      nonce: data.nonce,
      seq: pings,
      pid: process.pid,
      processType: process.type,
      hostTime: Date.now(),
    });
  });
  // MessagePortMain queues messages until start() is called.
  port.start();
  parentPort.postMessage({ type: 'attached', pid: process.pid });
});

parentPort.postMessage({ type: 'ready', pid: process.pid });

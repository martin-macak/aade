import { rpcTransportConformance } from '@tessera/testing';
import { createInMemoryTransportPair, messagePortTransport } from '@tessera/rpc';

rpcTransportConformance('in-memory', () => createInMemoryTransportPair());
rpcTransportConformance('MessagePort', () => {
  const { port1, port2 } = new MessageChannel();
  return [messagePortTransport(port1), messagePortTransport(port2)];
});

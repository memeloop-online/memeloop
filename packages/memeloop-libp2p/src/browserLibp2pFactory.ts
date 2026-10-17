import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';

import type { Libp2pNodeFactory } from './portableLibp2pDeviceNetworkService.js';

/**
 * Browser/React-Native factory: outbound WebSocket/WSS plus circuit relay.
 * It intentionally has no Node TCP listener or mDNS/UDP import.
 */
export const createBrowserLibp2p: Libp2pNodeFactory = async (options) => {
  const peerDiscovery = options.bootstrapMultiaddrs.length === 0
    ? []
    : [bootstrap({
      list: options.bootstrapMultiaddrs,
      tagName: 'memeloop-bootstrap',
      tagTTL: Infinity,
    })];
  return await createLibp2p({
    privateKey: options.privateKey,
    addresses: {
      listen: options.enableCircuitRelay ? ['/p2p-circuit'] : options.listen.addresses,
      announce: options.listen.announce,
    },
    transports: options.enableCircuitRelay
      ? [webSockets(), circuitRelayTransport()]
      : [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      ping: ping(),
    },
    start: false,
  });
};

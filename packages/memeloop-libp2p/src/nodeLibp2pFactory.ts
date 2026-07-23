import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';

import type { Libp2pNodeFactory } from './portableLibp2pDeviceNetworkService.js';

function relayListenAddresses(addresses: string[]): string[] {
  return addresses.includes('/p2p-circuit') ? addresses : [...addresses, '/p2p-circuit'];
}

export const createNodeLibp2p: Libp2pNodeFactory = async (options) => {
  const peerDiscovery = [
    ...(options.bootstrapMultiaddrs.length === 0
      ? []
      : [bootstrap({
        list: options.bootstrapMultiaddrs,
        tagName: 'memeloop-bootstrap',
        tagTTL: Infinity,
      })]),
    ...(options.enableMdns ? [mdns({ serviceTag: 'memeloop' })] : []),
  ];
  return await createLibp2p({
    privateKey: options.privateKey,
    addresses: {
      listen: options.enableCircuitRelay
        ? relayListenAddresses(options.listen.addresses)
        : options.listen.addresses,
      announce: options.listen.announce,
    },
    transports: options.enableCircuitRelay
      ? [tcp(), webSockets(), circuitRelayTransport()]
      : [tcp(), webSockets()],
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

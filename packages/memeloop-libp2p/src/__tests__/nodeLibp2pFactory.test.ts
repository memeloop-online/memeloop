import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import type { Libp2p } from '@libp2p/interface';
import { tcp } from '@libp2p/tcp';
import type { Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createNodeLibp2p } from '../nodeLibp2pFactory.js';
import { resolveRelayTransportManager } from '../portableLibp2pDeviceNetworkService.js';

interface RelayTransportManager {
  listen(addresses: Multiaddr[]): Promise<void>;
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('tcp_port_unavailable');
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition_timeout');
}

function transportManager(node: Libp2p): RelayTransportManager {
  const manager = resolveRelayTransportManager(node);
  if (manager === undefined) throw new Error('transport_manager_unavailable');
  return manager;
}

describe('Node libp2p factory', () => {
  it('registers DCUtR whenever private circuit relay support is enabled', async () => {
    const node = await createNodeLibp2p({
      privateKey: await generateKeyPair('Ed25519'),
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      bootstrapMultiaddrs: [],
      enableCircuitRelay: true,
      enableMdns: false,
    });
    try {
      await node.start();
      expect(node.getProtocols()).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\/libp2p\/dcutr(?:\/|$)/u)]),
      );
    } finally {
      await node.stop();
    }
  });

  it('does not advertise DCUtR when circuit relay support is disabled', async () => {
    const node = await createNodeLibp2p({
      privateKey: await generateKeyPair('Ed25519'),
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      bootstrapMultiaddrs: [],
      enableCircuitRelay: false,
      enableMdns: false,
    });
    try {
      await node.start();
      expect(node.getProtocols().some((protocol) => protocol.startsWith('/libp2p/dcutr'))).toBe(false);
    } finally {
      await node.stop();
    }
  });

  it('upgrades a real three-node circuit relay connection to direct TCP', async () => {
    const [firstPort, secondPort] = await Promise.all([unusedTcpPort(), unusedTcpPort()]);
    const relay = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        circuitRelay: circuitRelayServer({
          reservations: { maxReservations: 4, reservationTtl: 60_000 },
        }),
      },
      start: false,
    });
    const first = await createNodeLibp2p({
      privateKey: await generateKeyPair('Ed25519'),
      listen: {
        addresses: [`/ip4/127.0.0.1/tcp/${firstPort}`],
        announce: [`/dns4/localhost/tcp/${firstPort}`],
      },
      bootstrapMultiaddrs: [],
      enableCircuitRelay: true,
      enableMdns: false,
    });
    const second = await createNodeLibp2p({
      privateKey: await generateKeyPair('Ed25519'),
      listen: {
        addresses: [`/ip4/127.0.0.1/tcp/${secondPort}`],
        announce: [`/dns4/localhost/tcp/${secondPort}`],
      },
      bootstrapMultiaddrs: [],
      enableCircuitRelay: true,
      enableMdns: false,
    });

    try {
      await relay.start();
      await Promise.all([first.start(), second.start()]);
      const relayAddress = relay.getMultiaddrs()[0];
      if (relayAddress === undefined) throw new Error('relay_address_unavailable');
      const relayListener = relayAddress.encapsulate('/p2p-circuit');
      await Promise.all([
        transportManager(first).listen([relayListener]),
        transportManager(second).listen([relayListener]),
      ]);
      const relayedDialAddress = relayListener.encapsulate(`/p2p/${second.peerId.toString()}`);

      const relayedConnection = await first.dial(relayedDialAddress);
      expect(relayedConnection.remotePeer.toString()).toBe(second.peerId.toString());
      expect(relayedConnection.remoteAddr.toString()).toContain('/p2p-circuit');

      const directConnection = await waitFor(() =>
        first.getConnections(second.peerId).find((connection) => connection.limits == null && !connection.remoteAddr.toString().includes('/p2p-circuit'))
      );
      expect(directConnection.remoteAddr.toString()).toContain('/tcp/');
      await waitFor(() =>
        first.getConnections(second.peerId).every((connection) => !connection.remoteAddr.toString().includes('/p2p-circuit'))
          ? true
          : undefined
      );
    } finally {
      await Promise.allSettled([first.stop(), second.stop(), relay.stop()]);
    }
  }, 20_000);
});

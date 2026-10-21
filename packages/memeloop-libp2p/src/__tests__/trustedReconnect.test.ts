import type { Libp2p } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { expect, it } from 'vitest';
import { createBrowserLibp2p } from '../browserLibp2pFactory.js';
import { createDeviceIdentity, type Libp2pNodeFactoryOptions, PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

it('restores trusted invite addresses into the real peer store before the first RPC, without authorizing unrelated bootstrap peers', async () => {
  const local = await createDeviceIdentity('mobile', 'phone');
  const desktop = await createDeviceIdentity('desktop', 'desktop');
  const unrelated = await createDeviceIdentity('desktop', 'unrelated');
  const address = `/ip4/127.0.0.1/tcp/41001/ws/p2p/${desktop.peerId}`;
  const other = `/ip4/127.0.0.1/tcp/41002/ws/p2p/${unrelated.peerId}`;
  let node: Libp2p | undefined;
  let options: Libp2pNodeFactoryOptions | undefined;
  const service = new PortableLibp2pDeviceNetworkService({
    identity: local,
    bootstrapMultiaddrs: [address, other],
    trustedDevices: [{
      peerId: desktop.peerId,
      publicKeyMultibase: desktop.publicKeyMultibase,
      deviceName: 'desktop',
      platform: 'desktop',
      trustMode: 'local-pairing',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    }],
    enableCircuitRelay: false,
    listen: { addresses: [], announce: [] },
    nodeFactory: async input => {
      options = input;
      // Remove asynchronous discovery so this proves restoration, not bootstrap timing.
      node = await createBrowserLibp2p({ ...input, bootstrapMultiaddrs: [] });
      return node;
    },
  });
  try {
    await service.start();
    const peer = await node!.peerStore.get(peerIdFromString(desktop.peerId));
    expect(peer.addresses.map(item => item.multiaddr.toString())).toContain('/ip4/127.0.0.1/tcp/41001/ws');
    expect(options!.isExplicitDialAddress!(address)).toBe(true);
    expect(options!.isExplicitDialAddress!(other)).toBe(false);
    await expect(node!.peerStore.get(peerIdFromString(unrelated.peerId))).rejects.toThrow();
    await service.removeTrustedDevice(desktop.peerId);
    expect(options!.isExplicitDialAddress!(address)).toBe(false);
  } finally {
    await service.stop();
  }
});

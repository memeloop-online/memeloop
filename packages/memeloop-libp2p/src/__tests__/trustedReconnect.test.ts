import type { Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { expect, it, vi } from 'vitest';
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

it('retries retained identity-bound routes when real peer-store addresses expire despite being merged again', async () => {
  const local = await createDeviceIdentity('mobile', 'phone');
  const desktop = await createDeviceIdentity('desktop', 'desktop');
  const address = `/ip4/127.0.0.1/tcp/41001/ws/p2p/${desktop.peerId}`;
  let node: Libp2p | undefined;
  const service = new PortableLibp2pDeviceNetworkService({
    identity: local,
    bootstrapMultiaddrs: [address],
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
      node = await createBrowserLibp2p({ ...input, bootstrapMultiaddrs: [] });
      return node;
    },
  });
  try {
    await service.start();
    const target = peerIdFromString(desktop.peerId);
    expect((await node!.peerStore.get(target)).addresses).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_001);
    expect((await node!.peerStore.get(target)).addresses).toHaveLength(0);
    const originalDial = node!.dialProtocol.bind(node);
    const stream = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Stream;
    const dial = vi.spyOn(node!, 'dialProtocol').mockImplementation((peer, protocol, options) => {
      // Keep the first real dial: it must fail because merge does not refresh
      // observed timestamps. Only the direct network attempt is substituted.
      if (!Array.isArray(peer)) return originalDial(peer, protocol, options);
      return Promise.resolve(stream);
    });
    const controller = new AbortController();
    const result = await service.openStream(desktop.peerId, '/memeloop/rpc/2.0.0', { signal: controller.signal });
    expect(dial).toHaveBeenCalledTimes(2);
    const fallback = dial.mock.calls[1];
    expect(Array.isArray(fallback[0]) && fallback[0].map(item => item.toString())).toEqual([address]);
    expect(fallback[1]).toBe('/memeloop/rpc/2.0.0');
    expect(fallback[2]).toMatchObject({ signal: controller.signal, runOnLimitedConnection: true });
    await result.close();
    expect(stream.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await service.stop();
  }
});

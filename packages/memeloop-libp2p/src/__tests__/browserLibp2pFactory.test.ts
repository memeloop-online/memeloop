import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { expect, it, vi } from 'vitest';
import { createBrowserLibp2p } from '../browserLibp2pFactory.js';

vi.mock('libp2p', () => ({ createLibp2p: vi.fn(async () => ({})) }));

it('permits the explicit LAN pairing destination while retaining default denial for other insecure destinations', async () => {
  const invited = '/ip4/192.168.1.20/tcp/1234/ws';
  await createBrowserLibp2p({
    privateKey: await generateKeyPair('Ed25519'),
    bootstrapMultiaddrs: [],
    enableCircuitRelay: false,
    enableMdns: false,
    listen: { addresses: [], announce: [] },
    isExplicitDialAddress: address => address === invited,
  });
  const gate = vi.mocked(createLibp2p).mock.calls[0][0]!.connectionGater!.denyDialMultiaddr!;
  expect(await gate(multiaddr(invited))).toBe(false);
  expect(await gate(multiaddr('/ip4/192.168.1.21/tcp/1234/ws'))).toBe(true);
  expect(await gate(multiaddr('/ip4/8.8.8.8/tcp/1234/ws'))).toBe(true);
  expect(await gate(multiaddr('/dns4/example.com/tcp/443/wss'))).toBe(false);
});

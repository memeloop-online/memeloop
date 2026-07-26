import { describe, expect, it } from 'vitest';

import { createDevicePairingInvite, encodeDevicePairingInvite, parseDevicePairingInvite } from '../pairingInvite.js';

describe('device pairing invites', () => {
  const now = 1_700_000_000_000;
  const device = {
    peerId: '12D3KooWdesktop',
    displayName: 'Desktop',
    multiaddrs: [
      '/ip4/192.168.1.10/tcp/41000/ws/p2p/12D3KooWdesktop',
      '/ip4/192.168.1.10/tcp/41000/ws/p2p/12D3KooWdesktop',
    ],
  };

  it('round-trips a bounded WebSocket invitation', () => {
    const invite = createDevicePairingInvite(device, { now });
    expect(parseDevicePairingInvite(
      encodeDevicePairingInvite(invite),
      { now: now + 1 },
    )).toEqual({
      ...invite,
      multiaddrs: [device.multiaddrs[0]],
    });
  });

  it('rejects expired invitations', () => {
    const serialized = encodeDevicePairingInvite(
      createDevicePairingInvite(device, { now, ttlMs: 1_000 }),
    );
    expect(() => parseDevicePairingInvite(serialized, { now: now + 1_000 })).toThrow('expired');
  });

  it('rejects transports unavailable to browser and mobile clients', () => {
    expect(() =>
      createDevicePairingInvite({
        ...device,
        multiaddrs: ['/ip4/192.168.1.10/tcp/41000'],
      }, { now })
    ).toThrow('WebSocket');
  });
});

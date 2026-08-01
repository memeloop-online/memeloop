import { describe, expect, it, vi } from 'vitest';

import { canonicalDevicePairingInviteBytes, createDevicePairingInvite, encodeDevicePairingInvite, parseDevicePairingInvite } from '../pairingInvite.js';

describe('device pairing invites', () => {
  const now = 1_700_000_000_000;
  const device = {
    peerId: '12D3KooWdesktop',
    publicKeyMultibase: 'libp2p-pub:desktop',
    displayName: 'Desktop',
    multiaddrs: [
      '/ip4/192.168.1.10/tcp/41000/ws/p2p/12D3KooWdesktop',
      '/ip4/192.168.1.10/tcp/41000/ws/p2p/12D3KooWdesktop',
    ],
  };

  async function invite(ttlMs?: number) {
    return createDevicePairingInvite(device, {
      now,
      ttlMs,
      sign: async (payload) => `signature-${payload.byteLength}`,
    });
  }

  it('round-trips an identity-bound signed invitation', async () => {
    const created = await invite();
    const verifyIdentity = vi.fn(async ({ invite: parsed, payload }) =>
      parsed.peerId === device.peerId &&
      parsed.publicKeyMultibase === device.publicKeyMultibase &&
      parsed.signature === `signature-${payload.byteLength}`
    );

    await expect(parseDevicePairingInvite(encodeDevicePairingInvite(created), {
      now: now + 1,
      verifyIdentity,
    })).resolves.toEqual({
      ...created,
      multiaddrs: [device.multiaddrs[0]],
    });
    expect(verifyIdentity).toHaveBeenCalledOnce();
  });

  it('rejects expired, tampered, and invalidly signed invitations', async () => {
    const created = await invite(1_000);
    await expect(parseDevicePairingInvite(encodeDevicePairingInvite(created), {
      now: now + 1_000,
      verifyIdentity: async () => true,
    })).rejects.toThrow('expired');

    const tampered = { ...created, deviceName: 'Attacker' };
    await expect(parseDevicePairingInvite(JSON.stringify(tampered), {
      now: now + 1,
      verifyIdentity: async ({ invite: parsed, payload }) => parsed.signature === `signature-${payload.byteLength}` && parsed.deviceName === 'Desktop',
    })).rejects.toThrow('identity verification');
  });

  it('rejects addresses whose final PeerId does not match the signed identity', async () => {
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: ['/ip4/192.168.1.10/tcp/41000/ws/p2p/12D3KooWattacker'],
    }, {
      now,
      sign: async () => 'signature',
    })).rejects.toThrow('PeerId-bound');
  });

  it('rejects transports unavailable to browser and mobile clients', async () => {
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: ['/ip4/192.168.1.10/tcp/41000/p2p/12D3KooWdesktop'],
    }, {
      now,
      sign: async () => 'signature',
    })).rejects.toThrow('WebSocket');
  });

  it('uses deterministic canonical bytes independent of address order', () => {
    const base = {
      protocol: 'memeloop-device-pairing-v2' as const,
      peerId: device.peerId,
      publicKeyMultibase: device.publicKeyMultibase,
      deviceName: device.displayName,
      multiaddrs: [
        '/dns4/b.example/tcp/443/wss/p2p/12D3KooWdesktop',
        '/dns4/a.example/tcp/443/wss/p2p/12D3KooWdesktop',
      ],
      createdAt: now,
      expiresAt: now + 1_000,
    };
    expect(canonicalDevicePairingInviteBytes(base)).toEqual(
      canonicalDevicePairingInviteBytes({ ...base, multiaddrs: base.multiaddrs.toReversed() }),
    );
  });
});

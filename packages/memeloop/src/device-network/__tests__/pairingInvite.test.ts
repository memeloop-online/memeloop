import { describe, expect, it, vi } from 'vitest';

import {
  canonicalDevicePairingInviteBytes,
  createDevicePairingInvite,
  DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS,
  encodeDevicePairingInvite,
  parseDevicePairingInvite,
} from '../pairingInvite.js';

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

  it('keeps transport choice host-neutral for direct TCP and future QUIC paths', async () => {
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: ['/ip4/192.168.1.10/tcp/41000/p2p/12D3KooWdesktop'],
    }, {
      now,
      sign: async () => 'signature',
    })).resolves.toMatchObject({
      multiaddrs: ['/ip4/192.168.1.10/tcp/41000/p2p/12D3KooWdesktop'],
    });
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: ['/ip4/192.168.1.10/udp/41000/quic-v1/p2p/12D3KooWdesktop'],
    }, {
      now,
      sign: async () => 'signature',
    })).resolves.toBeDefined();
  });

  it('accepts a relay PeerId only in a canonical circuit path with the invite destination last', async () => {
    const circuit = '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWrelay/p2p-circuit/p2p/12D3KooWdesktop';
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: [circuit],
    }, {
      now,
      sign: async () => 'signature',
    })).resolves.toMatchObject({ multiaddrs: [circuit] });
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: [
        '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWrelay/p2p-circuit/p2p/attacker',
      ],
    }, { now, sign: async () => 'signature' })).rejects.toThrow('PeerId-bound');
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWrelay/p2p-circuit'],
    }, { now, sign: async () => 'signature' })).rejects.toThrow('PeerId-bound');
    await expect(createDevicePairingInvite({
      ...device,
      multiaddrs: [
        '/dns4/direct.example/tcp/443/wss/p2p/extra/p2p/12D3KooWdesktop',
      ],
    }, { now, sign: async () => 'signature' })).rejects.toThrow('PeerId-bound');
  });

  it('rejects unknown top-level keys and future invitations before identity verification', async () => {
    const created = await invite();
    const verifyIdentity = vi.fn(async () => true);
    await expect(parseDevicePairingInvite(
      JSON.stringify({
        ...created,
        attackerControlled: true,
      }),
      {
        now: now + 1,
        verifyIdentity,
      },
    )).rejects.toThrow('invalid device pairing invite');
    await expect(parseDevicePairingInvite(
      JSON.stringify({
        ...created,
        createdAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS + 2,
        expiresAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS + 1_002,
      }),
      {
        now: now + 1,
        verifyIdentity,
      },
    )).rejects.toThrow('future');
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('accepts the clock-skew boundary and rejects the next millisecond', async () => {
    const created = await invite();
    await expect(parseDevicePairingInvite(
      JSON.stringify({
        ...created,
        createdAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS,
        expiresAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS + 1_000,
      }),
      {
        now,
        verifyIdentity: async () => true,
      },
    )).resolves.toBeDefined();
    await expect(parseDevicePairingInvite(
      JSON.stringify({
        ...created,
        createdAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS + 1,
        expiresAt: now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS + 1_001,
      }),
      {
        now,
        verifyIdentity: async () => true,
      },
    )).rejects.toThrow('future');
  });

  it('requires the verifier to bind both the public key and signature to the PeerId', async () => {
    const created = await invite();
    await expect(parseDevicePairingInvite(
      JSON.stringify({
        ...created,
        publicKeyMultibase: 'libp2p-pub:attacker',
      }),
      {
        now: now + 1,
        verifyIdentity: async ({ invite: parsed, payload }) =>
          parsed.peerId === device.peerId &&
          parsed.publicKeyMultibase === device.publicKeyMultibase &&
          parsed.signature === `signature-${payload.byteLength}`,
      },
    )).rejects.toThrow('identity verification');
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
      canonicalDevicePairingInviteBytes({ ...base, multiaddrs: [...base.multiaddrs].reverse() }),
    );
  });
});

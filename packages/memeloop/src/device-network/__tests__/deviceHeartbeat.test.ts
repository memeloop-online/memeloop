import { describe, expect, it, vi } from 'vitest';

import {
  buildDeviceHeartbeatMessage,
  DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS,
  DEVICE_HEARTBEAT_LIMITS,
  DEVICE_HEARTBEAT_SIGNATURE_DOMAIN,
  type DeviceHeartbeatUnsignedMessage,
  signDeviceHeartbeatMessage,
  verifyDeviceHeartbeatMessage,
} from '../deviceHeartbeat.js';

const now = 1_700_000_000_000;

function heartbeat(
  overrides: Partial<DeviceHeartbeatUnsignedMessage> = {},
): DeviceHeartbeatUnsignedMessage {
  return {
    peerId: '12D3KooWdevice',
    timestamp: now,
    nonce: 'nonce-1',
    capabilities: {
      tools: ['z-tool', 'a-tool'],
      mcpServers: ['server-b', 'server-a'],
      hasWiki: true,
      agentLoop: true,
      imChannels: ['matrix', 'discord'],
      wikis: [
        { wikiId: 'wiki-b', title: 'B' },
        { wikiId: 'wiki-a', pathHint: '/wiki/a' },
      ],
    },
    multiaddrs: ['/dns4/b.example/tcp/443/wss', '/dns4/a.example/tcp/443/wss'],
    relayReservations: ['/dns4/relay-b.example/tcp/443/wss', '/dns4/relay-a.example/tcp/443/wss'],
    ...overrides,
  };
}

function signatureFor(payload: Uint8Array): string {
  const hash = payload.reduce((value, byte) => ((value * 31) ^ byte) >>> 0, 2_166_136_261);
  return `test-signature-${hash.toString(16)}`;
}

describe('device heartbeat proof of possession', () => {
  it('builds fixed-domain canonical bytes independent of set ordering', () => {
    const input = heartbeat();
    const reordered = heartbeat({
      capabilities: {
        ...input.capabilities,
        tools: [...input.capabilities.tools].reverse(),
        mcpServers: [...input.capabilities.mcpServers].reverse(),
        imChannels: [...input.capabilities.imChannels].reverse(),
        wikis: [...input.capabilities.wikis].reverse(),
      },
      multiaddrs: [...input.multiaddrs].reverse(),
      relayReservations: [...input.relayReservations].reverse(),
    });

    const payload = buildDeviceHeartbeatMessage(input);
    expect(payload).toEqual(buildDeviceHeartbeatMessage(reordered));
    expect(new TextDecoder().decode(payload)).toBe(JSON.stringify({
      domain: DEVICE_HEARTBEAT_SIGNATURE_DOMAIN,
      payload: {
        capabilities: {
          agentLoop: true,
          hasWiki: true,
          imChannels: ['discord', 'matrix'],
          mcpServers: ['server-a', 'server-b'],
          tools: ['a-tool', 'z-tool'],
          wikis: [
            { pathHint: '/wiki/a', wikiId: 'wiki-a' },
            { title: 'B', wikiId: 'wiki-b' },
          ],
        },
        multiaddrs: ['/dns4/a.example/tcp/443/wss', '/dns4/b.example/tcp/443/wss'],
        nonce: input.nonce,
        peerId: input.peerId,
        relayReservations: [
          '/dns4/relay-a.example/tcp/443/wss',
          '/dns4/relay-b.example/tcp/443/wss',
        ],
        timestamp: now,
      },
    }));
  });

  it('signs normalized bytes and verifies identity binding before atomically consuming the nonce', async () => {
    const signed = await signDeviceHeartbeatMessage(heartbeat(), {
      sign: async payload => `signature-${payload.byteLength}`,
    });
    const events: string[] = [];
    const verifyIdentity = vi.fn(async input => {
      events.push('verify');
      return input.peerId === signed.peerId &&
        input.publicKeyMultibase === 'libp2p-pub:key' &&
        input.signature === `signature-${input.payload.byteLength}`;
    });
    const consumeNonce = vi.fn(async input => {
      events.push('consume');
      return input.peerId === signed.peerId && input.nonce === 'nonce-1';
    });

    await expect(verifyDeviceHeartbeatMessage(signed, {
      publicKeyMultibase: 'libp2p-pub:key',
      now,
      verifyIdentity,
      consumeNonce,
    })).resolves.toBe(true);
    expect(events).toEqual(['verify', 'consume']);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(consumeNonce).toHaveBeenCalledOnce();
  });

  it('rejects tampering, a mismatched PeerId/public key, and invalid signatures without consuming a nonce', async () => {
    const signed = await signDeviceHeartbeatMessage(heartbeat(), signatureFor);
    const consumeNonce = vi.fn(async () => true);
    const verifyIdentity = vi.fn(async ({ peerId, publicKeyMultibase, payload, signature }) =>
      peerId === '12D3KooWdevice' &&
      publicKeyMultibase === 'libp2p-pub:key' &&
      signature === signatureFor(payload)
    );
    const options = {
      publicKeyMultibase: 'libp2p-pub:attacker',
      now,
      verifyIdentity,
      consumeNonce,
    };

    await expect(verifyDeviceHeartbeatMessage(signed, options)).resolves.toBe(false);
    await expect(verifyDeviceHeartbeatMessage({
      ...signed,
      capabilities: { ...signed.capabilities, hasWiki: false },
    }, {
      ...options,
      publicKeyMultibase: 'libp2p-pub:key',
      verifyIdentity,
    })).resolves.toBe(false);
    await expect(verifyDeviceHeartbeatMessage({ ...signed, signature: 'invalid-signature' }, {
      ...options,
      publicKeyMultibase: 'libp2p-pub:key',
    })).resolves.toBe(false);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it('enforces the default symmetric 60 second time window', async () => {
    const accept = async (timestamp: number) =>
      verifyDeviceHeartbeatMessage({
        ...heartbeat({ timestamp }),
        signature: 'signature',
      }, {
        publicKeyMultibase: 'libp2p-pub:key',
        now,
        verify: async () => true,
        consumeNonce: async () => true,
      });

    await expect(accept(now - DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS)).resolves.toBe(true);
    await expect(accept(now + DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS)).resolves.toBe(true);
    await expect(accept(now - DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS - 1)).resolves.toBe(false);
    await expect(accept(now + DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS + 1)).resolves.toBe(false);
  });

  it('fails closed when replay protection is absent, rejects, or throws', async () => {
    const signed = { ...heartbeat(), signature: 'signature' };
    const base = {
      publicKeyMultibase: 'libp2p-pub:key',
      now,
      verifyIdentity: async () => true,
    };

    await expect(verifyDeviceHeartbeatMessage(signed, base)).resolves.toBe(false);
    await expect(verifyDeviceHeartbeatMessage(signed, {
      ...base,
      consumeNonce: async () => false,
    })).resolves.toBe(false);
    await expect(verifyDeviceHeartbeatMessage(signed, {
      ...base,
      consumeNonce: async () => {
        throw new Error('nonce store unavailable');
      },
    })).resolves.toBe(false);
  });

  it('rejects malformed, duplicate, and oversized fields before signing or verification', async () => {
    expect(() => buildDeviceHeartbeatMessage(heartbeat({ nonce: '' }))).toThrow('nonce');
    expect(() =>
      buildDeviceHeartbeatMessage(heartbeat({
        nonce: 'n'.repeat(DEVICE_HEARTBEAT_LIMITS.nonceCharacters + 1),
      }))
    ).toThrow('nonce');
    expect(() =>
      buildDeviceHeartbeatMessage(heartbeat({
        multiaddrs: Array.from(
          { length: DEVICE_HEARTBEAT_LIMITS.multiaddrs + 1 },
          (_, index) => `/ip4/127.0.0.1/tcp/${index}`,
        ),
      }))
    ).toThrow('multiaddrs');
    expect(() =>
      buildDeviceHeartbeatMessage(heartbeat({
        capabilities: { ...heartbeat().capabilities, tools: ['duplicate', 'duplicate'] },
      }))
    ).toThrow('capabilities.tools');

    const signer = vi.fn(async () => 'signature');
    await expect(signDeviceHeartbeatMessage({
      ...heartbeat(),
      peerId: ' peer ',
    }, signer)).rejects.toThrow('peerId');
    expect(signer).not.toHaveBeenCalled();

    await expect(verifyDeviceHeartbeatMessage({
      ...heartbeat(),
      timestamp: Number.MAX_SAFE_INTEGER + 1,
      signature: 'signature',
    }, {
      publicKeyMultibase: 'libp2p-pub:key',
      now,
      verifyIdentity: async () => true,
      consumeNonce: async () => true,
    })).resolves.toBe(false);
  });
});

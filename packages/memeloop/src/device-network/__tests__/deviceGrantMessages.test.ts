import { describe, expect, it } from 'vitest';

import {
  buildDeviceBindingMessage,
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  DEVICE_BINDING_SIGNATURE_DOMAIN,
  DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
  DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
  DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
  DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
  deviceConnectionGrantAllowsProtocol,
  deviceConnectionGrantAllowsRpc,
  hasCanonicalDeviceConnectionGrantClaims,
  hasCanonicalDeviceRelayReservationTokenClaims,
} from '../deviceGrantMessages.js';
import type { DeviceConnectionGrant } from '../types.js';

function scopedGrant(overrides: Partial<DeviceConnectionGrant> = {}): DeviceConnectionGrant {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    subjectPeerId: 'peer-1',
    allowedPeerIds: ['peer-2'],
    protocols: ['/memeloop/rpc/2.0.0', '/memeloop/sync/2.0.0'],
    rpcMethodScope: { mode: 'ids', ids: ['memeloop.agent.get', 'memeloop.chat.send'] },
    conversationScope: { mode: 'ids', ids: ['conversation-1'] },
    definitionScope: { mode: 'ids', ids: ['definition-1'] },
    issuedAt: 1_000,
    expiresAt: 2_000,
    signature: 'signature',
    ...overrides,
  };
}

describe('device grant signature messages', () => {
  it('builds the exact v2 account binding bytes', () => {
    expect(new TextDecoder().decode(buildDeviceBindingMessage({
      accountId: 'account-1',
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:key-1',
      nonce: 'nonce-1',
    }))).toBe(JSON.stringify({
      domain: DEVICE_BINDING_SIGNATURE_DOMAIN,
      payload: {
        accountId: 'account-1',
        nonce: 'nonce-1',
        peerId: 'peer-1',
        publicKeyMultibase: 'libp2p-pub:key-1',
      },
    }));
  });

  it('builds the exact v2 connection grant bytes', () => {
    expect(new TextDecoder().decode(buildDeviceConnectionGrantMessage({
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2', 'peer-3'],
      protocols: ['/memeloop/rpc/2.0.0', '/memeloop/sync/2.0.0'],
      rpcMethodScope: { mode: 'ids', ids: ['memeloop.agent.get', 'memeloop.chat.send'] },
      conversationScope: { mode: 'ids', ids: ['conversation-1'] },
      definitionScope: { mode: 'all' },
      issuedAt: 1_000,
      expiresAt: 2_000,
    }))).toBe(JSON.stringify({
      domain: DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
      payload: {
        accountId: 'account-1',
        allowedPeerIds: ['peer-2', 'peer-3'],
        conversationScope: { ids: ['conversation-1'], mode: 'ids' },
        definitionScope: { mode: 'all' },
        expiresAt: 2_000,
        issuedAt: 1_000,
        issuer: 'memeloop-cloud',
        protocols: ['/memeloop/rpc/2.0.0', '/memeloop/sync/2.0.0'],
        rpcMethodScope: { ids: ['memeloop.agent.get', 'memeloop.chat.send'], mode: 'ids' },
        subjectPeerId: 'peer-1',
      },
    }));
  });

  it('builds the exact v2 relay reservation bytes', () => {
    expect(new TextDecoder().decode(buildDeviceRelayReservationTokenMessage({
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      peerId: 'peer-1',
      relayMultiaddrs: ['/dns4/relay.example/tcp/443/wss/p2p/relay'],
      bootstrapMultiaddrs: ['/dns4/bootstrap.example/tcp/443/wss/p2p/bootstrap'],
      issuedAt: 1_000,
      expiresAt: 2_000,
    }))).toBe(JSON.stringify({
      domain: DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
      payload: {
        accountId: 'account-1',
        bootstrapMultiaddrs: ['/dns4/bootstrap.example/tcp/443/wss/p2p/bootstrap'],
        expiresAt: 2_000,
        issuedAt: 1_000,
        issuer: 'memeloop-cloud',
        peerId: 'peer-1',
        relayMultiaddrs: ['/dns4/relay.example/tcp/443/wss/p2p/relay'],
      },
    }));
  });

  it('rejects ambiguous or non-canonical relay address sets', () => {
    const token = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      peerId: 'peer-1',
      relayMultiaddrs: ['/dns4/a.example/tcp/443/wss', '/dns4/b.example/tcp/443/wss'],
      bootstrapMultiaddrs: [],
      issuedAt: 1_000,
      expiresAt: 2_000,
      signature: 'signature',
    };
    expect(hasCanonicalDeviceRelayReservationTokenClaims(token)).toBe(true);
    expect(hasCanonicalDeviceRelayReservationTokenClaims({
      ...token,
      relayMultiaddrs: [...token.relayMultiaddrs].reverse(),
    })).toBe(false);
    expect(hasCanonicalDeviceRelayReservationTokenClaims({
      ...token,
      relayMultiaddrs: [token.relayMultiaddrs[0], token.relayMultiaddrs[0]],
    })).toBe(false);
    expect(() =>
      buildDeviceRelayReservationTokenMessage({
        ...token,
        relayMultiaddrs: ['address\nexpiresAt=999999'],
      })
    ).toThrow('invalid device relay reservation token claims');
  });

  it('does not admit delimiter collisions in binding claims', () => {
    const common = { publicKeyMultibase: 'key', nonce: 'nonce' };
    expect(buildDeviceBindingMessage({
      ...common,
      accountId: 'account\npeerId=attacker',
      peerId: 'peer',
    })).not.toEqual(buildDeviceBindingMessage({
      ...common,
      accountId: 'account',
      peerId: 'attacker\npeerId=peer',
    }));
  });

  it('allows only explicitly scoped protocols and RPC resources', () => {
    const grant = scopedGrant();

    expect(deviceConnectionGrantAllowsProtocol(grant, '/memeloop/sync/2.0.0')).toBe(true);
    expect(deviceConnectionGrantAllowsProtocol(grant, '/memeloop/orchestration/2.0.0')).toBe(false);
    expect(deviceConnectionGrantAllowsRpc(grant, {
      method: 'memeloop.chat.send',
      conversationId: 'conversation-1',
      definitionId: 'definition-1',
    })).toBe(true);
    expect(deviceConnectionGrantAllowsRpc(grant, {
      method: 'memeloop.chat.send',
      conversationId: 'conversation-2',
      definitionId: 'definition-1',
    })).toBe(false);
    expect(deviceConnectionGrantAllowsRpc(grant, {
      method: 'memeloop.chat.delete',
      conversationId: 'conversation-1',
    })).toBe(false);
    expect(deviceConnectionGrantAllowsRpc(scopedGrant({ rpcMethodScope: { mode: 'all' } }), {
      method: '',
    })).toBe(false);
  });

  it('requires explicit structured scopes and distinguishes none from all', () => {
    const missing = scopedGrant({
      conversationScope: { mode: 'none' },
      definitionScope: { mode: 'none' },
    });
    expect(deviceConnectionGrantAllowsRpc(missing, {
      method: 'memeloop.chat.send',
      conversationId: 'conversation-1',
    })).toBe(false);
    expect(deviceConnectionGrantAllowsRpc(missing, {
      method: 'memeloop.chat.send',
      definitionId: 'definition-1',
    })).toBe(false);

    const all = scopedGrant({
      rpcMethodScope: { mode: 'all' },
      conversationScope: { mode: 'all' },
      definitionScope: { mode: 'all' },
    });
    expect(deviceConnectionGrantAllowsRpc(all, {
      method: 'any.method',
      conversationId: 'any-conversation',
      definitionId: 'any-definition',
    })).toBe(true);
  });

  it('rejects non-canonical, ambiguous, and unbounded grant scopes', () => {
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant())).toBe(true);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      protocols: ['/memeloop/sync/2.0.0', '/memeloop/rpc/2.0.0'],
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      rpcMethodScope: { mode: 'ids', ids: ['method', 'method'] },
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      conversationScope: { mode: 'ids', ids: [] },
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      definitionScope: { mode: 'ids', ids: ['definition-1\nexpiresAt=999999'] },
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      conversationScope: {
        mode: 'ids',
        ids: Array.from({ length: 257 }, (_, index) => `conversation-${String(index).padStart(3, '0')}`),
      },
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims({
      ...scopedGrant(),
      protocols: undefined,
      rpcMethodScope: undefined,
    } as unknown as DeviceConnectionGrant)).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      conversationScope: { mode: 'all', ids: ['conversation-1'] } as never,
    }))).toBe(false);
  });

  it('requires exact claims and bounded grant lifetimes', () => {
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      issuedAt: 1_000,
      expiresAt: 1_000 + DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
    }))).toBe(true);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      issuedAt: 1_000,
      expiresAt: 1_001 + DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims(scopedGrant({
      issuedAt: 1_000,
      expiresAt: 1_000,
    }))).toBe(false);
    expect(hasCanonicalDeviceConnectionGrantClaims({
      ...scopedGrant(),
      attackerControlled: true,
    } as DeviceConnectionGrant)).toBe(false);
  });

  it('bounds relay reservation token lifetime', () => {
    const token = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      peerId: 'peer-1',
      relayMultiaddrs: ['/dns4/relay.example/tcp/443/wss'],
      bootstrapMultiaddrs: [],
      issuedAt: 1_000,
      expiresAt: 1_000 + DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
      signature: 'signature',
    };
    expect(hasCanonicalDeviceRelayReservationTokenClaims(token)).toBe(true);
    expect(hasCanonicalDeviceRelayReservationTokenClaims({
      ...token,
      expiresAt: token.expiresAt + 1,
    })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { LocalTrustDeviceAuthorizer } from '../localTrustDeviceAuthorizer.js';
import type { TrustedDeviceRecord } from '../types.js';

function trustedDevice(overrides: Partial<TrustedDeviceRecord> = {}): TrustedDeviceRecord {
  return {
    peerId: 'peer-a',
    publicKeyMultibase: 'libp2p-pub:test',
    deviceName: 'device-a',
    platform: 'cli',
    trustMode: 'local-pairing',
    createdAt: 1,
    ...overrides,
  };
}

describe('LocalTrustDeviceAuthorizer', () => {
  it('allows pairing protocol from unknown peers', async () => {
    const authorizer = new LocalTrustDeviceAuthorizer();

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'unknown-peer',
      protocol: '/memeloop/pairing/2.0.0',
    })).resolves.toBe(true);
  });

  it('rejects business protocols from unknown peers', async () => {
    const authorizer = new LocalTrustDeviceAuthorizer();

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'unknown-peer',
      protocol: '/memeloop/sync/2.0.0',
    })).resolves.toBe(false);
  });

  it('allows business protocols from trusted peers', async () => {
    const authorizer = new LocalTrustDeviceAuthorizer({ trustedDevices: [trustedDevice()] });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'peer-a',
      protocol: '/memeloop/rpc/2.0.0',
    })).resolves.toBe(true);
  });

  it('does not treat cloud-account directory records as local trust', async () => {
    const authorizer = new LocalTrustDeviceAuthorizer({
      trustedDevices: [trustedDevice({ trustMode: 'cloud-account' })],
    });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'peer-a',
      protocol: '/memeloop/rpc/2.0.0',
    })).resolves.toBe(false);
  });

  it.each([0, 2])('rejects peers revoked at timestamp %s for pairing and business protocols', async revokedAt => {
    const authorizer = new LocalTrustDeviceAuthorizer({ trustedDevices: [trustedDevice({ revokedAt })] });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'peer-a',
      protocol: '/memeloop/pairing/2.0.0',
    })).resolves.toBe(false);

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'peer-a',
      protocol: '/memeloop/rpc/2.0.0',
    })).resolves.toBe(false);
  });
});

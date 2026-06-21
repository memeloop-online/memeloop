import { generateKeyPairFromSeed, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { toString } from 'uint8arrays';
import { describe, expect, it } from 'vitest';

import { CloudDeviceAuthorizer } from '../cloudDeviceAuthorizer.js';
import { buildDeviceConnectionGrantMessage, createDeviceIdentity } from '../libp2pDeviceNetworkService.js';
import type { DeviceConnectionGrant, TrustedDeviceRecord } from '../types.js';

async function createGrant(input: {
  subjectPeerId: string;
  allowedPeerId: string;
  issuedAt?: number;
  expiresAt?: number;
}): Promise<{ grant: DeviceConnectionGrant; publicKeyMultibase: string }> {
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(8));
  const publicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
  const unsignedGrant = {
    issuer: 'memeloop-cloud' as const,
    accountId: 'account-1',
    subjectPeerId: input.subjectPeerId,
    allowedPeerIds: [input.allowedPeerId],
    issuedAt: input.issuedAt ?? 1_000,
    expiresAt: input.expiresAt ?? 60_000,
  };
  return {
    publicKeyMultibase,
    grant: {
      ...unsignedGrant,
      signature: toString(await privateKey.sign(buildDeviceConnectionGrantMessage(unsignedGrant)), 'base64url'),
    },
  };
}

function trustedDevice(overrides: Partial<TrustedDeviceRecord> = {}): TrustedDeviceRecord {
  return {
    peerId: 'trusted-peer',
    publicKeyMultibase: 'libp2p-pub:test',
    deviceName: 'Trusted Peer',
    platform: 'cli',
    trustMode: 'cloud-account',
    createdAt: 1,
    ...overrides,
  };
}

describe('CloudDeviceAuthorizer', () => {
  it('allows trusted devices from the local trust store', async () => {
    const local = await createDeviceIdentity('desktop', 'local');
    const { publicKeyMultibase } = await createGrant({
      subjectPeerId: 'remote-peer',
      allowedPeerId: local.peerId,
    });
    const authorizer = new CloudDeviceAuthorizer({
      localPeerId: local.peerId,
      grantVerificationPublicKeyMultibase: publicKeyMultibase,
      getTrustedDevice: (peerId) => peerId === 'trusted-peer' ? trustedDevice() : undefined,
    });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'trusted-peer',
      protocol: '/memeloop/sync/1.0.0',
    })).resolves.toBe(true);
  });

  it('allows inbound streams with a valid Cloud grant', async () => {
    const local = await createDeviceIdentity('desktop', 'local');
    const remote = await createDeviceIdentity('cli', 'remote');
    const { grant, publicKeyMultibase } = await createGrant({
      subjectPeerId: remote.peerId,
      allowedPeerId: local.peerId,
    });
    const authorizer = new CloudDeviceAuthorizer({
      localPeerId: local.peerId,
      grantVerificationPublicKeyMultibase: publicKeyMultibase,
      now: () => 2_000,
    });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: remote.peerId,
      protocol: '/memeloop/agent/1.0.0',
      direction: 'inbound',
      presentedGrant: grant,
    })).resolves.toBe(true);
  });

  it('allows outbound streams with a valid Cloud grant issued to the local peer', async () => {
    const local = await createDeviceIdentity('desktop', 'local');
    const remote = await createDeviceIdentity('cli', 'remote');
    const { grant, publicKeyMultibase } = await createGrant({
      subjectPeerId: local.peerId,
      allowedPeerId: remote.peerId,
    });
    const authorizer = new CloudDeviceAuthorizer({
      localPeerId: local.peerId,
      grantVerificationPublicKeyMultibase: publicKeyMultibase,
      now: () => 2_000,
    });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: remote.peerId,
      protocol: '/memeloop/rpc/1.0.0',
      direction: 'outbound',
      presentedGrant: grant,
    })).resolves.toBe(true);
  });

  it('rejects revoked devices and mismatched grants', async () => {
    const local = await createDeviceIdentity('desktop', 'local');
    const remote = await createDeviceIdentity('cli', 'remote');
    const { grant, publicKeyMultibase } = await createGrant({
      subjectPeerId: remote.peerId,
      allowedPeerId: 'different-peer',
    });
    const authorizer = new CloudDeviceAuthorizer({
      localPeerId: local.peerId,
      grantVerificationPublicKeyMultibase: publicKeyMultibase,
      getTrustedDevice: (peerId) => peerId === 'trusted-peer' ? trustedDevice({ revokedAt: 2 }) : undefined,
      now: () => 2_000,
    });

    await expect(authorizer.canOpenProtocol({
      remotePeerId: 'trusted-peer',
      protocol: '/memeloop/sync/1.0.0',
    })).resolves.toBe(false);

    await expect(authorizer.canOpenProtocol({
      remotePeerId: remote.peerId,
      protocol: '/memeloop/sync/1.0.0',
      direction: 'inbound',
      presentedGrant: grant,
    })).resolves.toBe(false);
  });
});

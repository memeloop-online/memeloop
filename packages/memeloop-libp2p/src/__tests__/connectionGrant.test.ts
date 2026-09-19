import { describe, expect, it } from 'vitest';

import type { DeviceConnectionGrant, DeviceRelayReservationToken } from 'memeloop';
import {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  createDeviceIdentity,
  decodePublicKeyMultibase,
  DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
  DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
  DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
  DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
  DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
  verifyDeviceConnectionGrant,
  verifyDeviceRelayReservationToken,
} from '../libp2pDeviceNetworkService.js';

function replaceCurrentSignatureDomainWithLegacy(message: Uint8Array): Uint8Array {
  const decoded = new TextDecoder().decode(message);
  return new TextEncoder().encode(decoded.replace(/-v2/u, `-v${String(1)}`));
}

async function signGrant(input: {
  grant: Omit<DeviceConnectionGrant, 'signature'>;
  signingPublicKeyMultibase: string;
  legacyDomain?: boolean;
}): Promise<DeviceConnectionGrant> {
  const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const seed = new Uint8Array(32).fill(7);
  const privateKey = await generateKeyPairFromSeed('Ed25519', seed);
  expect(await decodePublicKeyMultibase(input.signingPublicKeyMultibase)).toEqual(privateKey.publicKey);
  const message = buildDeviceConnectionGrantMessage(input.grant);
  return {
    ...input.grant,
    signature: toString(
      await privateKey.sign(
        input.legacyDomain ? replaceCurrentSignatureDomainWithLegacy(message) : message,
      ),
      'base64url',
    ),
  };
}

async function signRelayToken(input: {
  token: Omit<DeviceRelayReservationToken, 'signature'>;
  signingPublicKeyMultibase: string;
  legacyDomain?: boolean;
}): Promise<DeviceRelayReservationToken> {
  const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const seed = new Uint8Array(32).fill(7);
  const privateKey = await generateKeyPairFromSeed('Ed25519', seed);
  expect(await decodePublicKeyMultibase(input.signingPublicKeyMultibase)).toEqual(privateKey.publicKey);
  const message = buildDeviceRelayReservationTokenMessage(input.token);
  return {
    ...input.token,
    signature: toString(
      await privateKey.sign(
        input.legacyDomain ? replaceCurrentSignatureDomainWithLegacy(message) : message,
      ),
      'base64url',
    ),
  };
}

describe('device connection grant verification', () => {
  it('verifies a signed grant for the expected subject and allowed peer', async () => {
    const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
    const { toString } = await import('uint8arrays');
    const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(7));
    const { publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const verificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
    const subject = await createDeviceIdentity('cli', 'subject');
    const allowed = await createDeviceIdentity('desktop', 'allowed');
    const grant = await signGrant({
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      grant: {
        issuer: 'memeloop-cloud',
        accountId: 'account-1',
        subjectPeerId: subject.peerId,
        allowedPeerIds: [allowed.peerId],
        protocols: ['/memeloop/rpc/2.0.0'],
        rpcMethodScope: { mode: 'all' },
        conversationScope: { mode: 'all' },
        definitionScope: { mode: 'all' },
        issuedAt: 1_000,
        expiresAt: 60_000,
      },
    });

    await expect(verifyDeviceConnectionGrant({
      grant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(true);
  });

  it('uses v2 grant domains and rejects legacy-domain signatures', async () => {
    const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { toString } = await import('uint8arrays');
    const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(7));
    const verificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
    const subject = await createDeviceIdentity('cli', 'subject');
    const allowed = await createDeviceIdentity('desktop', 'allowed');
    const unsignedGrant: Omit<DeviceConnectionGrant, 'signature'> = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      subjectPeerId: subject.peerId,
      allowedPeerIds: [allowed.peerId],
      protocols: ['/memeloop/rpc/2.0.0'],
      rpcMethodScope: { mode: 'all' },
      conversationScope: { mode: 'all' },
      definitionScope: { mode: 'all' },
      issuedAt: 1_000,
      expiresAt: 60_000,
    };
    expect(JSON.parse(
      new TextDecoder().decode(buildDeviceConnectionGrantMessage(unsignedGrant)),
    )).toMatchObject({ domain: DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN });
    const legacyGrant = await signGrant({
      grant: unsignedGrant,
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      legacyDomain: true,
    });
    await expect(verifyDeviceConnectionGrant({
      grant: legacyGrant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    const unsignedToken = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      peerId: subject.peerId,
      relayMultiaddrs: ['/dns4/relay.memeloop.test/tcp/443/wss/p2p/12D3KooWRelay'],
      bootstrapMultiaddrs: ['/dns4/bootstrap.memeloop.test/tcp/443/wss/p2p/12D3KooWBootstrap'],
      issuedAt: 1_000,
      expiresAt: 60_000,
    };
    expect(JSON.parse(
      new TextDecoder().decode(buildDeviceRelayReservationTokenMessage(unsignedToken)),
    )).toMatchObject({ domain: DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN });
    const legacyToken = await signRelayToken({
      token: unsignedToken,
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      legacyDomain: true,
    });
    await expect(verifyDeviceRelayReservationToken({
      token: legacyToken,
      verificationPublicKeyMultibase,
      peerId: subject.peerId,
      now: 2_000,
    })).resolves.toBe(false);
  });

  it('rejects grants with mismatched peers, expired timestamps, or tampered signatures', async () => {
    const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { toString } = await import('uint8arrays');
    const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(7));
    const verificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
    const subject = await createDeviceIdentity('cli', 'subject');
    const allowed = await createDeviceIdentity('desktop', 'allowed');
    const grant = await signGrant({
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      grant: {
        issuer: 'memeloop-cloud',
        accountId: 'account-1',
        subjectPeerId: subject.peerId,
        allowedPeerIds: [allowed.peerId],
        protocols: ['/memeloop/rpc/2.0.0'],
        rpcMethodScope: { mode: 'all' },
        conversationScope: { mode: 'all' },
        definitionScope: { mode: 'all' },
        issuedAt: 1_000,
        expiresAt: 60_000,
      },
    });

    await expect(verifyDeviceConnectionGrant({
      grant,
      verificationPublicKeyMultibase,
      subjectPeerId: 'wrong-subject',
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceConnectionGrant({
      grant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: 'wrong-allowed',
      now: 2_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceConnectionGrant({
      grant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 60_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceConnectionGrant({
      grant: { ...grant, allowedPeerIds: [allowed.peerId, 'tampered-peer'] },
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceConnectionGrant({
      grant: { ...grant, protocols: ['/memeloop/sync/2.0.0'] },
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    const legacyUnscopedMessage = new TextEncoder().encode([
      DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
      'issuer=memeloop-cloud',
      'accountId=account-1',
      `subjectPeerId=${subject.peerId}`,
      `allowedPeerIds=${allowed.peerId}`,
      'issuedAt=1000',
      'expiresAt=60000',
    ].join('\n'));
    await expect(verifyDeviceConnectionGrant({
      grant: {
        ...grant,
        signature: toString(await privateKey.sign(legacyUnscopedMessage), 'base64url'),
      },
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    const { signature: signedCanonicalGrantSignature, ...unsignedGrant } = grant;
    expect(signedCanonicalGrantSignature).not.toBe('');
    await expect(signGrant({
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      grant: {
        ...unsignedGrant,
        rpcMethodScope: { mode: 'ids', ids: ['same.method', 'same.method'] },
      },
    })).rejects.toThrow('invalid device connection grant claims');
  });

  it('verifies relay admission tokens and rejects invalid variants', async () => {
    const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { toString } = await import('uint8arrays');
    const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(7));
    const verificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
    const device = await createDeviceIdentity('cli', 'relay client');
    const token = await signRelayToken({
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
      token: {
        issuer: 'memeloop-cloud',
        accountId: 'account-1',
        peerId: device.peerId,
        relayMultiaddrs: ['/dns4/relay.memeloop.test/tcp/443/wss/p2p/12D3KooWRelay'],
        bootstrapMultiaddrs: ['/dns4/bootstrap.memeloop.test/tcp/443/wss/p2p/12D3KooWBootstrap'],
        issuedAt: 1_000,
        expiresAt: 60_000,
      },
    });

    await expect(verifyDeviceRelayReservationToken({
      token,
      verificationPublicKeyMultibase,
      peerId: device.peerId,
      now: 2_000,
    })).resolves.toBe(true);

    await expect(verifyDeviceRelayReservationToken({
      token: { ...token, relayMultiaddrs: [...token.relayMultiaddrs, '/ip4/127.0.0.1/tcp/1'] },
      verificationPublicKeyMultibase,
      peerId: device.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceRelayReservationToken({
      token,
      verificationPublicKeyMultibase,
      peerId: 'wrong-peer',
      now: 2_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceRelayReservationToken({
      token,
      verificationPublicKeyMultibase,
      peerId: device.peerId,
      now: 60_000,
    })).resolves.toBe(false);

    await expect(verifyDeviceRelayReservationToken({
      token: { ...token, issuedAt: 70_000 },
      verificationPublicKeyMultibase,
      peerId: device.peerId,
      now: 2_000,
    })).resolves.toBe(false);

    const wrongPrivateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(8));
    const wrongVerificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(wrongPrivateKey.publicKey), 'base64url')}`;
    await expect(verifyDeviceRelayReservationToken({
      token,
      verificationPublicKeyMultibase: wrongVerificationPublicKeyMultibase,
      peerId: device.peerId,
      now: 2_000,
    })).resolves.toBe(false);
  });

  it('accepts exact time boundaries and rejects future or overlong credentials', async () => {
    const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { toString } = await import('uint8arrays');
    const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(7));
    const verificationPublicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
    const subject = await createDeviceIdentity('cli', 'subject');
    const allowed = await createDeviceIdentity('desktop', 'allowed');
    const now = 1_000_000;
    const grantClaims: Omit<DeviceConnectionGrant, 'signature'> = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      subjectPeerId: subject.peerId,
      allowedPeerIds: [allowed.peerId],
      protocols: ['/memeloop/rpc/2.0.0'],
      rpcMethodScope: { mode: 'all' as const },
      conversationScope: { mode: 'all' as const },
      definitionScope: { mode: 'all' as const },
      issuedAt: now + DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
      expiresAt: now + DEVICE_GRANT_MAX_CLOCK_SKEW_MS + DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
    };
    const boundaryGrant = await signGrant({
      grant: grantClaims,
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    });
    await expect(verifyDeviceConnectionGrant({
      grant: boundaryGrant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now,
    })).resolves.toBe(true);

    const futureGrant = await signGrant({
      grant: {
        ...grantClaims,
        issuedAt: grantClaims.issuedAt + 1,
        expiresAt: grantClaims.expiresAt + 1,
      },
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    });
    await expect(verifyDeviceConnectionGrant({
      grant: futureGrant,
      verificationPublicKeyMultibase,
      subjectPeerId: subject.peerId,
      allowedPeerId: allowed.peerId,
      now,
    })).resolves.toBe(false);
    await expect(signGrant({
      grant: { ...grantClaims, expiresAt: grantClaims.expiresAt + 1 },
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    })).rejects.toThrow('invalid device connection grant claims');

    const relayClaims: Omit<DeviceRelayReservationToken, 'signature'> = {
      issuer: 'memeloop-cloud' as const,
      accountId: 'account-1',
      peerId: subject.peerId,
      relayMultiaddrs: ['/dns4/relay.memeloop.test/tcp/443/wss/p2p/12D3KooWRelay'],
      bootstrapMultiaddrs: [] as string[],
      issuedAt: now + DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
      expiresAt: now + DEVICE_GRANT_MAX_CLOCK_SKEW_MS + DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
    };
    const boundaryRelay = await signRelayToken({
      token: relayClaims,
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    });
    await expect(verifyDeviceRelayReservationToken({
      token: boundaryRelay,
      verificationPublicKeyMultibase,
      peerId: subject.peerId,
      now,
    })).resolves.toBe(true);
    const futureRelay = await signRelayToken({
      token: {
        ...relayClaims,
        issuedAt: relayClaims.issuedAt + 1,
        expiresAt: relayClaims.expiresAt + 1,
      },
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    });
    await expect(verifyDeviceRelayReservationToken({
      token: futureRelay,
      verificationPublicKeyMultibase,
      peerId: subject.peerId,
      now,
    })).resolves.toBe(false);
    await expect(signRelayToken({
      token: { ...relayClaims, expiresAt: relayClaims.expiresAt + 1 },
      signingPublicKeyMultibase: verificationPublicKeyMultibase,
    })).rejects.toThrow('invalid device relay reservation token claims');
  });
});

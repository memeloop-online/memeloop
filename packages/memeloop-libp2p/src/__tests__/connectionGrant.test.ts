import { describe, expect, it } from 'vitest';

import type { DeviceConnectionGrant, DeviceRelayReservationToken } from 'memeloop';
import {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  createDeviceIdentity,
  decodePublicKeyMultibase,
  verifyDeviceConnectionGrant,
  verifyDeviceRelayReservationToken,
} from '../libp2pDeviceNetworkService.js';

async function signGrant(input: {
  grant: Omit<DeviceConnectionGrant, 'signature'>;
  signingPublicKeyMultibase: string;
}): Promise<DeviceConnectionGrant> {
  const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const seed = new Uint8Array(32).fill(7);
  const privateKey = await generateKeyPairFromSeed('Ed25519', seed);
  expect(await decodePublicKeyMultibase(input.signingPublicKeyMultibase)).toEqual(privateKey.publicKey);
  return {
    ...input.grant,
    signature: toString(await privateKey.sign(buildDeviceConnectionGrantMessage(input.grant)), 'base64url'),
  };
}

async function signRelayToken(input: {
  token: Omit<DeviceRelayReservationToken, 'signature'>;
  signingPublicKeyMultibase: string;
}): Promise<DeviceRelayReservationToken> {
  const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const seed = new Uint8Array(32).fill(7);
  const privateKey = await generateKeyPairFromSeed('Ed25519', seed);
  expect(await decodePublicKeyMultibase(input.signingPublicKeyMultibase)).toEqual(privateKey.publicKey);
  return {
    ...input.token,
    signature: toString(await privateKey.sign(buildDeviceRelayReservationTokenMessage(input.token)), 'base64url'),
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
});

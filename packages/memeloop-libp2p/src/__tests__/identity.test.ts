import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { describe, expect, it } from 'vitest';

import {
  buildDeviceBindingMessage,
  createDeviceIdentity,
  createSignedDevicePairingInvite,
  decodePublicKeyMultibase,
  DEVICE_BINDING_SIGNATURE_DOMAIN,
  parseVerifiedDevicePairingInvite,
  signDeviceBinding,
  verifyDeviceBinding,
} from '../libp2pDeviceNetworkService.js';

function replaceCurrentSignatureDomainWithLegacy(message: Uint8Array): Uint8Array {
  const decoded = new TextDecoder().decode(message);
  return new TextEncoder().encode(decoded.replace(/-v2\n/u, `-v${String(1)}\n`));
}

describe('libp2p device network identity', () => {
  it('creates a PeerId that matches the stored public key', async () => {
    const identity = await createDeviceIdentity('cli', 'test-device');
    const publicKey = await decodePublicKeyMultibase(identity.publicKeyMultibase);

    expect(identity.peerId).toBe(peerIdFromPublicKey(publicKey).toString());
  });

  it('signs and verifies cloud device binding requests', async () => {
    const identity = await createDeviceIdentity('cli', 'test-device');
    const signature = await signDeviceBinding({
      identity,
      accountId: 'account-1',
      nonce: 'nonce-1',
    });

    await expect(verifyDeviceBinding({
      accountId: 'account-1',
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      cloudNonce: 'nonce-1',
      signature,
    })).resolves.toBe(true);
  });

  it('uses the v2 binding domain and rejects a legacy-domain signature', async () => {
    const { privateKeyFromRaw } = await import('@libp2p/crypto/keys');
    const { fromString, toString } = await import('uint8arrays');
    const identity = await createDeviceIdentity('cli', 'test-device');
    const unsigned = buildDeviceBindingMessage({
      accountId: 'account-1',
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      nonce: 'nonce-1',
    });
    expect(new TextDecoder().decode(unsigned).split('\n', 1)[0]).toBe(
      DEVICE_BINDING_SIGNATURE_DOMAIN,
    );

    const privateKey = privateKeyFromRaw(
      fromString(identity.privateKeyRawSeedBase64Url, 'base64url'),
    );
    const legacySignature = toString(
      await privateKey.sign(replaceCurrentSignatureDomainWithLegacy(unsigned)),
      'base64url',
    );
    await expect(verifyDeviceBinding({
      accountId: 'account-1',
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      cloudNonce: 'nonce-1',
      signature: legacySignature,
    })).resolves.toBe(false);
  });

  it('rejects bindings whose PeerId does not match the public key', async () => {
    const identity = await createDeviceIdentity('cli', 'test-device');
    const otherIdentity = await createDeviceIdentity('cli', 'other-device');
    const signature = await signDeviceBinding({
      identity,
      accountId: 'account-1',
      nonce: 'nonce-1',
    });

    await expect(verifyDeviceBinding({
      accountId: 'account-1',
      peerId: otherIdentity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      cloudNonce: 'nonce-1',
      signature,
    })).resolves.toBe(false);
  });

  it('rejects bindings signed for a different nonce or account', async () => {
    const identity = await createDeviceIdentity('cli', 'test-device');
    const signature = await signDeviceBinding({
      identity,
      accountId: 'account-1',
      nonce: 'nonce-1',
    });

    await expect(verifyDeviceBinding({
      accountId: 'account-1',
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      cloudNonce: 'nonce-2',
      signature,
    })).resolves.toBe(false);

    await expect(verifyDeviceBinding({
      accountId: 'account-2',
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      cloudNonce: 'nonce-1',
      signature,
    })).resolves.toBe(false);
  });

  it('creates and verifies an identity-bound pairing invitation', async () => {
    const identity = await createDeviceIdentity('cli', 'test-device');
    const address = `/ip4/192.168.1.20/tcp/4001/ws/p2p/${identity.peerId}`;
    const invite = await createSignedDevicePairingInvite({
      identity,
      multiaddrs: [address],
      now: 1_700_000_000_000,
    });

    await expect(parseVerifiedDevicePairingInvite(JSON.stringify(invite), {
      now: 1_700_000_000_001,
    })).resolves.toEqual(invite);
    await expect(parseVerifiedDevicePairingInvite(
      JSON.stringify({
        ...invite,
        deviceName: 'tampered',
      }),
      {
        now: 1_700_000_000_001,
      },
    )).rejects.toThrow('identity verification');
  });
});

import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { describe, expect, it } from 'vitest';

import { createDeviceIdentity, decodePublicKeyMultibase, signDeviceBinding, verifyDeviceBinding } from '../libp2pDeviceNetworkService.js';

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
});

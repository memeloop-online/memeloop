import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { buildDeviceHeartbeatMessage, signDeviceHeartbeatMessage } from 'memeloop/device-network';
import { describe, expect, it } from 'vitest';

import {
  buildDeviceBindingMessage,
  createDeviceIdentity,
  createSignedDevicePairingInvite,
  decodePublicKeyMultibase,
  DEVICE_BINDING_SIGNATURE_DOMAIN,
  parseVerifiedDevicePairingInvite,
  signDeviceBinding,
  signDeviceIdentityPayload,
  signDevicePairingInvitePayload,
  verifyDeviceBinding,
} from '../libp2pDeviceNetworkService.js';

function replaceCurrentSignatureDomainWithLegacy(message: Uint8Array): Uint8Array {
  const decoded = new TextDecoder().decode(message);
  return new TextEncoder().encode(decoded.replace(
    DEVICE_BINDING_SIGNATURE_DOMAIN,
    DEVICE_BINDING_SIGNATURE_DOMAIN.replace(/-v2$/u, `-v${String(1)}`),
  ));
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
    expect(JSON.parse(new TextDecoder().decode(unsigned))).toMatchObject({
      domain: DEVICE_BINDING_SIGNATURE_DOMAIN,
    });

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

  it('signs portable heartbeat payloads for every raw-seed host platform', async () => {
    const { fromString } = await import('uint8arrays');

    for (const platform of ['cli', 'desktop', 'mobile', 'web'] as const) {
      const identity = await createDeviceIdentity(platform, `${platform}-device`);
      const heartbeat = await signDeviceHeartbeatMessage({
        peerId: identity.peerId,
        timestamp: 1_700_000_000_000,
        nonce: `${platform}-nonce`,
        capabilities: {
          tools: [],
          mcpServers: [],
          hasWiki: false,
          agentLoop: false,
          imChannels: [],
          wikis: [],
        },
        multiaddrs: [],
        relayReservations: [],
      }, payload => signDeviceIdentityPayload({ identity, payload }));
      const publicKey = await decodePublicKeyMultibase(identity.publicKeyMultibase);
      const { signature, ...unsigned } = heartbeat;

      expect(publicKey.verify(
        buildDeviceHeartbeatMessage(unsigned),
        fromString(signature, 'base64url'),
      )).toBe(true);
    }
  });

  it('keeps the pairing signer as a compatibility alias over the generic signer', async () => {
    const identity = await createDeviceIdentity('web', 'test-device');
    const payload = new TextEncoder().encode('portable-protocol-payload');

    await expect(signDevicePairingInvitePayload({ identity, payload })).resolves.toBe(
      await signDeviceIdentityPayload({ identity, payload }),
    );
  });

  it('does not export or emulate keychain and hardware-backed identity keys', async () => {
    const identity = await createDeviceIdentity('mobile', 'test-device');
    const keyReferenceOnlyIdentity = {
      ...identity,
      privateKeyRawSeedBase64Url: undefined,
      privateKeyRef: 'secure-enclave-key-reference',
    };

    await expect(signDeviceIdentityPayload({
      identity: keyReferenceOnlyIdentity,
      payload: new TextEncoder().encode('payload'),
    })).rejects.toThrow('unsupported_private_key_format');
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

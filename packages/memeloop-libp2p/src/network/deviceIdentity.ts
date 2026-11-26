import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id';
import type {
  DeviceAccountBindingRequest,
  DeviceConnectionGrantVerificationInput,
  DevicePairingInvite,
  DevicePlatform,
  DeviceRelayReservationTokenVerificationInput,
  LocalDeviceIdentity,
} from 'memeloop/device-network/portable';
import {
  buildDeviceBindingMessage,
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  createDevicePairingInvite,
  DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
  hasCanonicalDeviceConnectionGrantClaims,
  hasCanonicalDeviceRelayReservationTokenClaims,
  parseDevicePairingInvite,
} from 'memeloop/device-network/portable';

export interface RawSeedDeviceIdentity extends LocalDeviceIdentity {
  privateKeyRawSeedBase64Url: string;
}

export const PUBLIC_KEY_MULTIBASE_PREFIX = 'libp2p-pub:';

async function loadCryptoKeys() {
  return import('@libp2p/crypto/keys');
}

async function loadUint8arrays() {
  return import('uint8arrays');
}

export async function encodePublicKeyMultibase(publicKey: PublicKey): Promise<string> {
  const { publicKeyToProtobuf } = await loadCryptoKeys();
  const { toString } = await loadUint8arrays();
  const protobuf = publicKeyToProtobuf(publicKey);
  return `${PUBLIC_KEY_MULTIBASE_PREFIX}${toString(protobuf, 'base64url')}`;
}

export async function decodePublicKeyMultibase(multibase: string): Promise<PublicKey> {
  if (!multibase.startsWith(PUBLIC_KEY_MULTIBASE_PREFIX)) {
    throw new Error('unsupported_public_key_multibase_prefix');
  }
  const { publicKeyFromProtobuf } = await loadCryptoKeys();
  const { fromString } = await loadUint8arrays();
  const encoded = multibase.slice(PUBLIC_KEY_MULTIBASE_PREFIX.length);
  const protobuf = fromString(encoded, 'base64url');
  return publicKeyFromProtobuf(protobuf);
}

export async function createDeviceIdentity(
  platform: DevicePlatform,
  deviceName: string,
): Promise<RawSeedDeviceIdentity> {
  const { generateKeyPair } = await loadCryptoKeys();
  const { toString } = await loadUint8arrays();
  const privateKey = await generateKeyPair('Ed25519');
  const publicKey = privateKey.publicKey;
  return {
    peerId: peerIdFromPrivateKey(privateKey).toString(),
    publicKeyMultibase: await encodePublicKeyMultibase(publicKey),
    privateKeyRef: 'libp2p-raw-seed',
    privateKeyRawSeedBase64Url: toString(privateKey.raw, 'base64url'),
    createdAt: Date.now(),
    deviceName,
    platform,
  };
}

export async function privateKeyFromIdentity(identity: LocalDeviceIdentity): Promise<PrivateKey> {
  if (identity.privateKeyRawSeedBase64Url) {
    const { privateKeyFromRaw } = await loadCryptoKeys();
    const { fromString } = await loadUint8arrays();
    const raw = fromString(identity.privateKeyRawSeedBase64Url, 'base64url');
    return privateKeyFromRaw(raw);
  }
  throw new Error('unsupported_private_key_format');
}

export async function signDeviceBinding(input: {
  identity: LocalDeviceIdentity;
  accountId: string;
  nonce: string;
}): Promise<string> {
  const message = buildDeviceBindingMessage({
    accountId: input.accountId,
    peerId: input.identity.peerId,
    publicKeyMultibase: input.identity.publicKeyMultibase,
    nonce: input.nonce,
  });
  return signDeviceIdentityPayload({ identity: input.identity, payload: message });
}

/**
 * Sign arbitrary portable protocol bytes with a device identity after checking
 * that its raw Ed25519 seed derives both the pinned public key and PeerId.
 *
 * Security boundary: this helper intentionally supports only
 * `privateKeyRawSeedBase64Url`, which materializes the seed in JavaScript
 * memory and is suitable for the existing browser/mobile raw-seed identity
 * path. A host whose `privateKeyRef` points at a keychain, Secure Enclave, or
 * hardware key must inject its own signer and must not export that key here.
 */
export async function signDeviceIdentityPayload(input: {
  identity: LocalDeviceIdentity;
  payload: Uint8Array;
}): Promise<string> {
  const payload = input.payload.slice();
  const { toString } = await loadUint8arrays();
  const privateKey = await privateKeyFromIdentity(input.identity);
  if ((await encodePublicKeyMultibase(privateKey.publicKey)) !== input.identity.publicKeyMultibase) {
    throw new Error('device_identity_public_key_mismatch');
  }
  if (peerIdFromPrivateKey(privateKey).toString() !== input.identity.peerId) {
    throw new Error('device_identity_peer_id_mismatch');
  }
  return toString(await privateKey.sign(payload), 'base64url');
}

export async function verifyDevicePairingInviteIdentity(input: {
  invite: DevicePairingInvite;
  payload: Uint8Array;
}): Promise<boolean> {
  try {
    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.invite.publicKeyMultibase);
    if (peerIdFromPublicKey(publicKey).toString() !== input.invite.peerId) return false;
    return await publicKey.verify(input.payload, fromString(input.invite.signature, 'base64url'));
  } catch {
    return false;
  }
}

export async function createSignedDevicePairingInvite(input: {
  identity: LocalDeviceIdentity;
  multiaddrs: string[];
  now?: number;
  ttlMs?: number;
}): Promise<DevicePairingInvite> {
  return createDevicePairingInvite({
    peerId: input.identity.peerId,
    publicKeyMultibase: input.identity.publicKeyMultibase,
    displayName: input.identity.deviceName,
    multiaddrs: input.multiaddrs,
  }, {
    now: input.now,
    ttlMs: input.ttlMs,
    sign: async (payload) =>
      signDeviceIdentityPayload({
        identity: input.identity,
        payload,
      }),
  });
}

export function parseVerifiedDevicePairingInvite(
  serialized: string,
  options: { now?: number } = {},
): Promise<DevicePairingInvite> {
  return parseDevicePairingInvite(serialized, {
    now: options.now,
    verifyIdentity: verifyDevicePairingInviteIdentity,
  });
}

export async function verifyDeviceBinding(
  input: DeviceAccountBindingRequest & { accountId: string },
): Promise<boolean> {
  try {
    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.publicKeyMultibase);
    if (peerIdFromPublicKey(publicKey).toString() !== input.peerId) {
      return false;
    }
    const message = buildDeviceBindingMessage({
      accountId: input.accountId,
      peerId: input.peerId,
      publicKeyMultibase: input.publicKeyMultibase,
      nonce: input.cloudNonce,
    });
    const signature = fromString(input.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

export async function verifyDeviceConnectionGrant(
  input: DeviceConnectionGrantVerificationInput,
): Promise<boolean> {
  try {
    const now = input.now ?? Date.now();
    const { grant } = input;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (grant.issuer !== 'memeloop-cloud') return false;
    if (!hasCanonicalDeviceConnectionGrantClaims(grant)) return false;
    if (
      !Number.isSafeInteger(grant.issuedAt) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.issuedAt < 0 ||
      grant.expiresAt < 0
    ) return false;
    if (grant.issuedAt > grant.expiresAt) return false;
    if (grant.issuedAt - now > DEVICE_GRANT_MAX_CLOCK_SKEW_MS) return false;
    if (grant.expiresAt <= now) return false;
    if (input.subjectPeerId && grant.subjectPeerId !== input.subjectPeerId) return false;
    if (input.allowedPeerId && !grant.allowedPeerIds.includes(input.allowedPeerId)) return false;

    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.verificationPublicKeyMultibase);
    const message = buildDeviceConnectionGrantMessage({
      issuer: grant.issuer,
      accountId: grant.accountId,
      subjectPeerId: grant.subjectPeerId,
      allowedPeerIds: grant.allowedPeerIds,
      protocols: grant.protocols,
      rpcMethodScope: grant.rpcMethodScope,
      conversationScope: grant.conversationScope,
      definitionScope: grant.definitionScope,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
    const signature = fromString(grant.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

export async function verifyDeviceRelayReservationToken(
  input: DeviceRelayReservationTokenVerificationInput,
): Promise<boolean> {
  try {
    const now = input.now ?? Date.now();
    const { token } = input;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (token.issuer !== 'memeloop-cloud') return false;
    if (!hasCanonicalDeviceRelayReservationTokenClaims(token)) return false;
    if (
      !Number.isSafeInteger(token.issuedAt) ||
      !Number.isSafeInteger(token.expiresAt) ||
      token.issuedAt < 0 ||
      token.expiresAt < 0
    ) return false;
    if (token.issuedAt > token.expiresAt) return false;
    if (token.issuedAt - now > DEVICE_GRANT_MAX_CLOCK_SKEW_MS) return false;
    if (token.expiresAt <= now) return false;
    if (input.peerId && token.peerId !== input.peerId) return false;

    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.verificationPublicKeyMultibase);
    const message = buildDeviceRelayReservationTokenMessage({
      issuer: token.issuer,
      accountId: token.accountId,
      peerId: token.peerId,
      relayMultiaddrs: token.relayMultiaddrs,
      bootstrapMultiaddrs: token.bootstrapMultiaddrs,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
    });
    const signature = fromString(token.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

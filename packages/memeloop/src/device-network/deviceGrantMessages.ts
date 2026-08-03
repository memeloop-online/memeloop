import type { DeviceConnectionGrant, DeviceRelayReservationToken } from './types.js';

export const DEVICE_BINDING_SIGNATURE_DOMAIN = 'memeloop-device-binding-v2';
export const DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN = 'memeloop-device-connection-grant-v2';
export const DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN = 'memeloop-device-relay-admission-v2';

export function buildDeviceBindingMessage(input: {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  nonce: string;
}): Uint8Array {
  return new TextEncoder().encode([
    DEVICE_BINDING_SIGNATURE_DOMAIN,
    `accountId=${input.accountId}`,
    `peerId=${input.peerId}`,
    `publicKey=${input.publicKeyMultibase}`,
    `nonce=${input.nonce}`,
  ].join('\n'));
}

export function buildDeviceConnectionGrantMessage(
  grant: Omit<DeviceConnectionGrant, 'signature'>,
): Uint8Array {
  return new TextEncoder().encode([
    DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
    `issuer=${grant.issuer}`,
    `accountId=${grant.accountId}`,
    `subjectPeerId=${grant.subjectPeerId}`,
    `allowedPeerIds=${grant.allowedPeerIds.join(',')}`,
    `issuedAt=${grant.issuedAt}`,
    `expiresAt=${grant.expiresAt}`,
  ].join('\n'));
}

export function buildDeviceRelayReservationTokenMessage(
  token: Omit<DeviceRelayReservationToken, 'signature'>,
): Uint8Array {
  return new TextEncoder().encode([
    DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
    `issuer=${token.issuer}`,
    `accountId=${token.accountId}`,
    `peerId=${token.peerId}`,
    `relayMultiaddrs=${token.relayMultiaddrs.join(',')}`,
    `bootstrapMultiaddrs=${token.bootstrapMultiaddrs.join(',')}`,
    `issuedAt=${token.issuedAt}`,
    `expiresAt=${token.expiresAt}`,
  ].join('\n'));
}

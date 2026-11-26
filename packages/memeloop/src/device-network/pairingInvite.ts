import { canonicalJsonString, domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { Device } from './types.js';

export const DEVICE_PAIRING_INVITE_PROTOCOL = 'memeloop-device-pairing-v2';
export const DEVICE_PAIRING_INVITE_TTL_MS = 5 * 60_000;
export const DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS = 30_000;
const MAX_INVITE_LENGTH = 16 * 1024;
const MAX_ADDRESSES = 8;
const PAIRING_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 4,
  maxNodes: 64,
  maxStringCodeUnits: 4_096,
  maxStringBytes: 16 * 1_024,
  maxBytes: MAX_INVITE_LENGTH,
});

export interface DevicePairingInvite {
  protocol: typeof DEVICE_PAIRING_INVITE_PROTOCOL;
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  multiaddrs: string[];
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export type DevicePairingInviteUnsignedPayload = Omit<DevicePairingInvite, 'signature'>;

export interface DevicePairingInviteIdentityVerifierInput {
  invite: DevicePairingInvite;
  payload: Uint8Array;
}

export type DevicePairingInviteIdentityVerifier = (
  input: DevicePairingInviteIdentityVerifierInput,
) => boolean | Promise<boolean>;

export interface CreateDevicePairingInviteOptions {
  now?: number;
  ttlMs?: number;
  sign(payload: Uint8Array): Promise<string>;
}

export interface ParseDevicePairingInviteOptions {
  now?: number;
  /** Must bind publicKeyMultibase -> peerId and verify signature over payload. */
  verifyIdentity: DevicePairingInviteIdentityVerifier;
}

function requireText(value: string, name: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`invalid device pairing invite ${name}`);
  }
  return trimmed;
}

function validatePeerBoundAddress(address: string, peerId: string): boolean {
  if (
    address.length === 0 || address.length > 2_048 || address !== address.trim() ||
    !address.startsWith('/') || address.endsWith('/') || address.includes('//') ||
    containsAsciiControlOrSpace(address)
  ) return false;
  const parts = address.split('/');
  const peerIndexes: number[] = [];
  const circuitIndexes: number[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    if (!parts[index]) return false;
    if (parts[index] === 'p2p-circuit') circuitIndexes.push(index);
    if (parts[index] !== 'p2p') continue;
    const peerId = parts[index + 1];
    if (!peerId) return false;
    peerIndexes.push(index);
    index += 1;
  }
  const destinationIndex = peerIndexes.at(-1);
  if (destinationIndex !== parts.length - 2 || parts[destinationIndex + 1] !== peerId) {
    return false;
  }
  if (circuitIndexes.length === 0) return peerIndexes.length === 1;
  if (circuitIndexes.length !== 1 || peerIndexes.length !== 2) return false;
  return peerIndexes[0] < circuitIndexes[0] && circuitIndexes[0] < destinationIndex;
}

function containsAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

function validateAddresses(addresses: readonly string[], peerId: string): string[] {
  const unique = [...new Set(addresses.map((address) => address.trim()))].filter(Boolean);
  if (
    unique.length === 0 ||
    unique.length > MAX_ADDRESSES ||
    unique.some(address => !validatePeerBoundAddress(address, peerId))
  ) {
    throw new Error('device pairing invite requires structurally valid PeerId-bound multiaddrs');
  }
  return unique;
}

function validateLifetime(createdAt: number, expiresAt: number, now: number): void {
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(expiresAt) ||
    createdAt < 0 ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > DEVICE_PAIRING_INVITE_TTL_MS
  ) {
    throw new Error('invalid device pairing invite lifetime');
  }
  if (createdAt > now + DEVICE_PAIRING_INVITE_MAX_CLOCK_SKEW_MS) {
    throw new Error('device pairing invite is from the future');
  }
  if (expiresAt <= now) throw new Error('device pairing invite has expired');
}

function unsignedPayload(invite: DevicePairingInviteUnsignedPayload): DevicePairingInviteUnsignedPayload {
  const peerId = requireText(invite.peerId, 'peerId', 256);
  return {
    protocol: DEVICE_PAIRING_INVITE_PROTOCOL,
    peerId,
    publicKeyMultibase: requireText(invite.publicKeyMultibase, 'publicKeyMultibase', 4096),
    deviceName: requireText(invite.deviceName, 'deviceName', 256),
    multiaddrs: [...validateAddresses(invite.multiaddrs, peerId)].sort(),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

export function canonicalDevicePairingInviteBytes(
  invite: DevicePairingInviteUnsignedPayload,
): Uint8Array {
  const payload = unsignedPayload(invite);
  return domainSeparatedCanonicalJsonBytes(
    DEVICE_PAIRING_INVITE_PROTOCOL,
    payload,
    PAIRING_CANONICAL_LIMITS,
  );
}

export async function createDevicePairingInvite(
  device: Pick<Device, 'peerId' | 'displayName' | 'multiaddrs'> & {
    publicKeyMultibase: string;
  },
  options: CreateDevicePairingInviteOptions,
): Promise<DevicePairingInvite> {
  const createdAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEVICE_PAIRING_INVITE_TTL_MS;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('invalid device pairing invite lifetime');
  }
  const payload = unsignedPayload({
    protocol: DEVICE_PAIRING_INVITE_PROTOCOL,
    peerId: device.peerId,
    publicKeyMultibase: device.publicKeyMultibase,
    deviceName: device.displayName,
    multiaddrs: device.multiaddrs ?? [],
    createdAt,
    expiresAt: createdAt + ttlMs,
  });
  validateLifetime(payload.createdAt, payload.expiresAt, createdAt);
  const signature = requireText(
    await options.sign(canonicalDevicePairingInviteBytes(payload)),
    'signature',
    4096,
  );
  return { ...payload, signature };
}

export function encodeDevicePairingInvite(invite: DevicePairingInvite): string {
  const payload = unsignedPayload(invite);
  const signature = requireText(invite.signature, 'signature', 4096);
  return canonicalJsonString({ ...payload, signature }, PAIRING_CANONICAL_LIMITS);
}

export async function parseDevicePairingInvite(
  serialized: string,
  options: ParseDevicePairingInviteOptions,
): Promise<DevicePairingInvite> {
  if (!serialized || serialized.length > MAX_INVITE_LENGTH) {
    throw new Error('invalid device pairing invite length');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('device pairing invite is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid device pairing invite');
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    'protocol',
    'peerId',
    'publicKeyMultibase',
    'deviceName',
    'multiaddrs',
    'createdAt',
    'expiresAt',
    'signature',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some(key => !Object.hasOwn(record, key)) ||
    record.protocol !== DEVICE_PAIRING_INVITE_PROTOCOL ||
    typeof record.peerId !== 'string' ||
    typeof record.publicKeyMultibase !== 'string' ||
    typeof record.deviceName !== 'string' ||
    !Array.isArray(record.multiaddrs) ||
    record.multiaddrs.some((address) => typeof address !== 'string') ||
    typeof record.createdAt !== 'number' ||
    typeof record.expiresAt !== 'number' ||
    typeof record.signature !== 'string'
  ) {
    throw new Error('invalid device pairing invite');
  }
  validateLifetime(record.createdAt, record.expiresAt, options.now ?? Date.now());
  const payload = unsignedPayload({
    protocol: DEVICE_PAIRING_INVITE_PROTOCOL,
    peerId: record.peerId,
    publicKeyMultibase: record.publicKeyMultibase,
    deviceName: record.deviceName,
    multiaddrs: record.multiaddrs as string[],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
  const invite: DevicePairingInvite = {
    ...payload,
    signature: requireText(record.signature, 'signature', 4096),
  };
  if (
    !await options.verifyIdentity({
      invite,
      payload: canonicalDevicePairingInviteBytes(payload),
    })
  ) {
    throw new Error('device pairing invite identity verification failed');
  }
  return invite;
}

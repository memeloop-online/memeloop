import type { Device } from './types.js';

export const DEVICE_PAIRING_INVITE_PROTOCOL = 'memeloop-device-pairing-v1';
export const DEVICE_PAIRING_INVITE_TTL_MS = 5 * 60_000;
const MAX_INVITE_LENGTH = 16 * 1024;
const MAX_ADDRESSES = 8;

export interface DevicePairingInvite {
  protocol: typeof DEVICE_PAIRING_INVITE_PROTOCOL;
  peerId: string;
  deviceName: string;
  multiaddrs: string[];
  createdAt: number;
  expiresAt: number;
}

function requireText(value: string, name: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`invalid device pairing invite ${name}`);
  }
  return trimmed;
}

function validateAddresses(addresses: readonly string[]): string[] {
  const unique = [...new Set(addresses.map((address) => address.trim()))]
    .filter(Boolean);
  if (
    unique.length === 0 ||
    unique.length > MAX_ADDRESSES ||
    unique.some((address) =>
      address.length > 2048 ||
      !address.startsWith('/') ||
      (!address.includes('/ws') && !address.includes('/wss'))
    )
  ) {
    throw new Error('device pairing invite requires WebSocket multiaddrs');
  }
  return unique;
}

export function createDevicePairingInvite(
  device: Pick<Device, 'peerId' | 'displayName' | 'multiaddrs'>,
  options: { now?: number; ttlMs?: number } = {},
): DevicePairingInvite {
  const createdAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEVICE_PAIRING_INVITE_TTL_MS;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEVICE_PAIRING_INVITE_TTL_MS) {
    throw new Error('invalid device pairing invite lifetime');
  }
  return {
    protocol: DEVICE_PAIRING_INVITE_PROTOCOL,
    peerId: requireText(device.peerId, 'peerId', 256),
    deviceName: requireText(device.displayName, 'deviceName', 256),
    multiaddrs: validateAddresses(device.multiaddrs ?? []),
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
}

export function encodeDevicePairingInvite(invite: DevicePairingInvite): string {
  const validated = parseDevicePairingInvite(JSON.stringify(invite), {
    now: invite.createdAt,
  });
  return JSON.stringify(validated);
}

export function parseDevicePairingInvite(
  serialized: string,
  options: { now?: number } = {},
): DevicePairingInvite {
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
  if (
    record.protocol !== DEVICE_PAIRING_INVITE_PROTOCOL ||
    typeof record.peerId !== 'string' ||
    typeof record.deviceName !== 'string' ||
    !Array.isArray(record.multiaddrs) ||
    record.multiaddrs.some((address) => typeof address !== 'string') ||
    typeof record.createdAt !== 'number' ||
    typeof record.expiresAt !== 'number' ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= record.createdAt ||
    record.expiresAt - record.createdAt > DEVICE_PAIRING_INVITE_TTL_MS
  ) {
    throw new Error('invalid device pairing invite');
  }
  if (record.expiresAt <= (options.now ?? Date.now())) {
    throw new Error('device pairing invite has expired');
  }
  return {
    protocol: DEVICE_PAIRING_INVITE_PROTOCOL,
    peerId: requireText(record.peerId, 'peerId', 256),
    deviceName: requireText(record.deviceName, 'deviceName', 256),
    multiaddrs: validateAddresses(record.multiaddrs as string[]),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

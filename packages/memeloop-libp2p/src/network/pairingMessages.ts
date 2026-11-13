import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { sha256 } from '@noble/hashes/sha2.js';
import type { DeviceCapabilities, DevicePlatform } from 'memeloop/device-network/portable';
import { decodePublicKeyMultibase, PUBLIC_KEY_MULTIBASE_PREFIX } from './deviceIdentity.js';
import { strictPairingMultiaddrs } from './networkAddresses.js';
import {
  PAIRING_CLOCK_SKEW_MS,
  PAIRING_MAX_CAPABILITY_ITEMS,
  PAIRING_MAX_CAPABILITY_STRING_LENGTH,
  PAIRING_MAX_DEVICE_NAME_LENGTH,
  PAIRING_MAX_PEER_ID_LENGTH,
  PAIRING_MAX_PUBLIC_KEY_LENGTH,
  PAIRING_MAX_SESSION_ID_LENGTH,
  PAIRING_MAX_WIKI_PATH_LENGTH,
  PAIRING_MAX_WIKI_TITLE_LENGTH,
  PAIRING_MAX_WIKIS,
  PAIRING_NONCE_PATTERN,
  PAIRING_SESSION_ID_PATTERN,
  PAIRING_SESSION_TTL_MS,
} from './protocolConstants.js';

export interface PairingDeviceEnvelope {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
}

export interface PairingRequestMessage {
  type: 'memeloop-local-pairing-request-v2';
  sessionId: string;
  requestNonce: string;
  createdAt: number;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

export interface PairingResponseMessage {
  type: 'memeloop-local-pairing-response-v2';
  sessionId: string;
  requestNonce: string;
  responseNonce: string;
  accepted: true;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

export interface PairingAdmission {
  sessionId: string;
  remotePeerId: string;
  requestNonce: string;
  expiresAt: number;
}

export const LOCAL_PAIRING_CONFIRMATION_DOMAIN = 'memeloop-local-pairing-confirm-v2';

export function randomPairingNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'desktop' || value === 'mobile' || value === 'cli' || value === 'web';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyRecordKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isBoundedTrimmedString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    (pattern?.test(value) ?? true)
  );
}

function normalizePairingStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > PAIRING_MAX_CAPABILITY_ITEMS) return undefined;
  const unique = new Set<string>();
  for (const item of value) {
    if (!isBoundedTrimmedString(item, PAIRING_MAX_CAPABILITY_STRING_LENGTH)) return undefined;
    unique.add(item);
  }
  return [...unique].sort();
}

function normalizePairingCapabilities(value: unknown): DeviceCapabilities | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyRecordKeys(value, [
      'tools',
      'mcpServers',
      'hasWiki',
      'agentLoop',
      'imChannels',
      'wikis',
    ]) ||
    !Object.hasOwn(value, 'tools') ||
    !Object.hasOwn(value, 'mcpServers') ||
    !Object.hasOwn(value, 'hasWiki') ||
    !Object.hasOwn(value, 'imChannels') ||
    !Object.hasOwn(value, 'wikis') ||
    typeof value.hasWiki !== 'boolean' ||
    (value.agentLoop !== undefined && typeof value.agentLoop !== 'boolean')
  ) return undefined;
  const tools = normalizePairingStringArray(value.tools);
  const mcpServers = normalizePairingStringArray(value.mcpServers);
  const imChannels = normalizePairingStringArray(value.imChannels);
  if (!tools || !mcpServers || !imChannels || !Array.isArray(value.wikis)) return undefined;
  if (value.wikis.length > PAIRING_MAX_WIKIS) return undefined;
  const wikis: DeviceCapabilities['wikis'] = [];
  const wikiIds = new Set<string>();
  for (const wiki of value.wikis) {
    if (
      !isRecord(wiki) ||
      !hasOnlyRecordKeys(wiki, ['wikiId', 'title', 'pathHint']) ||
      !isBoundedTrimmedString(wiki.wikiId, PAIRING_MAX_CAPABILITY_STRING_LENGTH) ||
      (wiki.title !== undefined &&
        !isBoundedTrimmedString(wiki.title, PAIRING_MAX_WIKI_TITLE_LENGTH)) ||
      (wiki.pathHint !== undefined &&
        !isBoundedTrimmedString(wiki.pathHint, PAIRING_MAX_WIKI_PATH_LENGTH)) ||
      wikiIds.has(wiki.wikiId)
    ) return undefined;
    wikiIds.add(wiki.wikiId);
    wikis.push({
      wikiId: wiki.wikiId,
      ...(wiki.title === undefined ? {} : { title: wiki.title }),
      ...(wiki.pathHint === undefined ? {} : { pathHint: wiki.pathHint }),
    });
  }
  wikis.sort((left, right) => left.wikiId.localeCompare(right.wikiId));
  return {
    tools,
    mcpServers,
    hasWiki: value.hasWiki,
    agentLoop: value.agentLoop === true,
    imChannels,
    wikis,
  };
}

export function normalizePairingDevice(value: unknown): PairingDeviceEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyRecordKeys(value, [
      'peerId',
      'publicKeyMultibase',
      'deviceName',
      'platform',
      'capabilities',
      'multiaddrs',
    ]) ||
    Object.keys(value).length !== 6 ||
    !isBoundedTrimmedString(value.peerId, PAIRING_MAX_PEER_ID_LENGTH) ||
    !isBoundedTrimmedString(value.publicKeyMultibase, PAIRING_MAX_PUBLIC_KEY_LENGTH) ||
    !value.publicKeyMultibase.startsWith(PUBLIC_KEY_MULTIBASE_PREFIX) ||
    !isBoundedTrimmedString(value.deviceName, PAIRING_MAX_DEVICE_NAME_LENGTH) ||
    !isDevicePlatform(value.platform)
  ) return undefined;
  try {
    if (peerIdFromString(value.peerId).toString() !== value.peerId) return undefined;
  } catch {
    return undefined;
  }
  const capabilities = normalizePairingCapabilities(value.capabilities);
  if (!capabilities || !Array.isArray(value.multiaddrs)) return undefined;
  let multiaddrs: string[];
  try {
    multiaddrs = strictPairingMultiaddrs(value.peerId, value.multiaddrs);
  } catch {
    return undefined;
  }
  return {
    peerId: value.peerId,
    publicKeyMultibase: value.publicKeyMultibase,
    deviceName: value.deviceName,
    platform: value.platform,
    capabilities,
    multiaddrs,
  };
}

export function normalizePairingRequest(value: unknown, now: number): PairingRequestMessage | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !hasOnlyRecordKeys(value, [
      'type',
      'sessionId',
      'requestNonce',
      'createdAt',
      'expiresAt',
      'device',
    ]) ||
    value.type !== 'memeloop-local-pairing-request-v2' ||
    !isBoundedTrimmedString(
      value.sessionId,
      PAIRING_MAX_SESSION_ID_LENGTH,
      PAIRING_SESSION_ID_PATTERN,
    ) ||
    !isBoundedTrimmedString(value.requestNonce, 32, PAIRING_NONCE_PATTERN) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.createdAt as number) > now + PAIRING_CLOCK_SKEW_MS ||
    (value.createdAt as number) < now - PAIRING_SESSION_TTL_MS - PAIRING_CLOCK_SKEW_MS ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) <= (value.createdAt as number) ||
    (value.expiresAt as number) - (value.createdAt as number) > PAIRING_SESSION_TTL_MS
  ) return undefined;
  const device = normalizePairingDevice(value.device);
  if (!device) return undefined;
  return {
    type: value.type,
    sessionId: value.sessionId,
    requestNonce: value.requestNonce,
    createdAt: value.createdAt as number,
    expiresAt: value.expiresAt as number,
    device,
  };
}

export function isPairingRequest(value: unknown, now = Date.now()): value is PairingRequestMessage {
  return normalizePairingRequest(value, now) !== undefined;
}

export function normalizePairingResponse(value: unknown, now: number): PairingResponseMessage | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 7 ||
    !hasOnlyRecordKeys(value, [
      'type',
      'sessionId',
      'requestNonce',
      'responseNonce',
      'accepted',
      'expiresAt',
      'device',
    ]) ||
    value.type !== 'memeloop-local-pairing-response-v2' ||
    !isBoundedTrimmedString(
      value.sessionId,
      PAIRING_MAX_SESSION_ID_LENGTH,
      PAIRING_SESSION_ID_PATTERN,
    ) ||
    !isBoundedTrimmedString(value.requestNonce, 32, PAIRING_NONCE_PATTERN) ||
    !isBoundedTrimmedString(value.responseNonce, 32, PAIRING_NONCE_PATTERN) ||
    value.accepted !== true ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) > now + PAIRING_SESSION_TTL_MS + PAIRING_CLOCK_SKEW_MS
  ) return undefined;
  const device = normalizePairingDevice(value.device);
  if (!device) return undefined;
  return {
    type: value.type,
    sessionId: value.sessionId,
    requestNonce: value.requestNonce,
    responseNonce: value.responseNonce,
    accepted: true,
    expiresAt: value.expiresAt as number,
    device,
  };
}

export function isPairingResponse(value: unknown, now = Date.now()): value is PairingResponseMessage {
  return normalizePairingResponse(value, now) !== undefined;
}

export async function assertPairingDeviceIdentity(device: PairingDeviceEnvelope): Promise<void> {
  const publicKey = await decodePublicKeyMultibase(device.publicKeyMultibase);
  if (peerIdFromPublicKey(publicKey).toString() !== device.peerId) {
    throw new Error('pairing_public_key_peer_id_mismatch');
  }
}

export async function buildPairingConfirmCode(input: {
  initiator: PairingDeviceEnvelope;
  responder: PairingDeviceEnvelope;
  requestNonce: string;
  responseNonce: string;
}): Promise<string> {
  const text = [
    LOCAL_PAIRING_CONFIRMATION_DOMAIN,
    `initiatorPeerId=${input.initiator.peerId}`,
    `initiatorPublicKey=${input.initiator.publicKeyMultibase}`,
    `responderPeerId=${input.responder.peerId}`,
    `responderPublicKey=${input.responder.publicKeyMultibase}`,
    `requestNonce=${input.requestNonce}`,
    `responseNonce=${input.responseNonce}`,
  ].join('\n');
  const bytes = sha256(new TextEncoder().encode(text));
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return (value % 1_000_000).toString().padStart(6, '0');
}

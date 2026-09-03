import { domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { DeviceCapabilities } from './types.js';

/** Domain separator for device heartbeat proof-of-possession signatures. */
export const DEVICE_HEARTBEAT_SIGNATURE_DOMAIN = 'memeloop-device-heartbeat-v2';

/** The default amount of clock skew accepted on either side of a heartbeat timestamp. */
export const DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;

export const DEVICE_HEARTBEAT_LIMITS = Object.freeze({
  peerIdCharacters: 256,
  nonceCharacters: 256,
  signatureCharacters: 4_096,
  publicKeyCharacters: 4_096,
  capabilityItems: 128,
  capabilityItemCharacters: 512,
  wikiItems: 128,
  wikiIdCharacters: 512,
  wikiTitleCharacters: 512,
  wikiPathHintCharacters: 2_048,
  multiaddrs: 64,
  multiaddrCharacters: 2_048,
  relayReservations: 64,
  relayReservationCharacters: 4_096,
  canonicalPayloadBytes: 64 * 1_024,
});

export interface DeviceHeartbeatUnsignedMessage {
  peerId: string;
  timestamp: number;
  nonce: string;
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
  relayReservations: string[];
}

export interface DeviceHeartbeatMessage extends DeviceHeartbeatUnsignedMessage {
  signature: string;
}

export type DeviceHeartbeatSigner = (
  payload: Uint8Array,
) => string | Promise<string>;

export interface DeviceHeartbeatSignOptions {
  sign: DeviceHeartbeatSigner;
}

/**
 * A host-provided portable identity verifier. Implementations MUST both derive
 * (or otherwise validate) `peerId` from `publicKeyMultibase` and verify that
 * `signature` authenticates `payload` with that public key.
 */
export interface DeviceHeartbeatIdentityVerifierInput {
  peerId: string;
  publicKeyMultibase: string;
  payload: Uint8Array;
  signature: string;
}

export type DeviceHeartbeatIdentityVerifier = (
  input: DeviceHeartbeatIdentityVerifierInput,
) => boolean | Promise<boolean>;

export interface DeviceHeartbeatNonceConsumptionInput {
  peerId: string;
  publicKeyMultibase: string;
  timestamp: number;
  nonce: string;
}

/**
 * Atomically consumes a nonce. `true` means this call consumed it; `false`
 * means it was already used or otherwise cannot be accepted.
 */
export type DeviceHeartbeatNonceConsumer = (
  input: DeviceHeartbeatNonceConsumptionInput,
) => boolean | Promise<boolean>;

export interface VerifyDeviceHeartbeatOptions {
  /** Public key pinned by the registration record, never supplied by the heartbeat. */
  publicKeyMultibase: string;
  now?: number;
  maxClockSkewMs?: number;
  /** Preferred verifier name, matching the pairing identity-verifier contract. */
  verifyIdentity?: DeviceHeartbeatIdentityVerifier;
  /** Concise alias for hosts whose crypto adapter exposes `verify`. */
  verify?: DeviceHeartbeatIdentityVerifier;
  /** Required for acceptance so verification is fail-closed against replay. */
  consumeNonce?: DeviceHeartbeatNonceConsumer;
}

type NormalizedHeartbeat = DeviceHeartbeatUnsignedMessage;

const unsignedKeys = [
  'peerId',
  'timestamp',
  'nonce',
  'capabilities',
  'multiaddrs',
  'relayReservations',
] as const;

const capabilityKeys = [
  'tools',
  'mcpServers',
  'hasWiki',
  'agentLoop',
  'imChannels',
  'wikis',
] as const;

function invalid(field: string): never {
  throw new Error(`invalid device heartbeat ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(location);
}

function boundedText(value: unknown, field: string, maxCharacters: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxCharacters ||
    value !== value.trim()
  ) invalid(field);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) invalid(field);
  }
  return value;
}

function normalizedStringSet(
  value: unknown,
  field: string,
  maxItems: number,
  maxCharacters: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(field);
  const items = Array.from(value, item => boundedText(item, field, maxCharacters));
  if (new Set(items).size !== items.length) invalid(field);
  return items.sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCapabilities(value: unknown): DeviceCapabilities {
  if (!isRecord(value)) invalid('capabilities');
  assertExactKeys(value, capabilityKeys, 'capabilities');
  if (typeof value.hasWiki !== 'boolean') invalid('capabilities.hasWiki');
  if (value.agentLoop !== undefined && typeof value.agentLoop !== 'boolean') {
    invalid('capabilities.agentLoop');
  }
  if (!Array.isArray(value.wikis) || value.wikis.length > DEVICE_HEARTBEAT_LIMITS.wikiItems) {
    invalid('capabilities.wikis');
  }

  const wikis = Array.from(value.wikis, (item) => {
    if (!isRecord(item)) invalid('capabilities.wikis');
    assertExactKeys(item, ['wikiId', 'title', 'pathHint'], 'capabilities.wikis');
    const wiki = {
      wikiId: boundedText(
        item.wikiId,
        'capabilities.wikis.wikiId',
        DEVICE_HEARTBEAT_LIMITS.wikiIdCharacters,
      ),
      ...(item.title === undefined
        ? {}
        : {
          title: boundedText(
            item.title,
            'capabilities.wikis.title',
            DEVICE_HEARTBEAT_LIMITS.wikiTitleCharacters,
          ),
        }),
      ...(item.pathHint === undefined
        ? {}
        : {
          pathHint: boundedText(
            item.pathHint,
            'capabilities.wikis.pathHint',
            DEVICE_HEARTBEAT_LIMITS.wikiPathHintCharacters,
          ),
        }),
    };
    return wiki;
  });
  const wikiIds = wikis.map(wiki => wiki.wikiId);
  if (new Set(wikiIds).size !== wikiIds.length) invalid('capabilities.wikis');
  wikis.sort((left, right) =>
    compareText(left.wikiId, right.wikiId) ||
    compareText(left.title ?? '', right.title ?? '') ||
    compareText(left.pathHint ?? '', right.pathHint ?? '')
  );

  return {
    tools: normalizedStringSet(
      value.tools,
      'capabilities.tools',
      DEVICE_HEARTBEAT_LIMITS.capabilityItems,
      DEVICE_HEARTBEAT_LIMITS.capabilityItemCharacters,
    ),
    mcpServers: normalizedStringSet(
      value.mcpServers,
      'capabilities.mcpServers',
      DEVICE_HEARTBEAT_LIMITS.capabilityItems,
      DEVICE_HEARTBEAT_LIMITS.capabilityItemCharacters,
    ),
    hasWiki: value.hasWiki,
    ...(value.agentLoop === undefined ? {} : { agentLoop: value.agentLoop }),
    imChannels: normalizedStringSet(
      value.imChannels,
      'capabilities.imChannels',
      DEVICE_HEARTBEAT_LIMITS.capabilityItems,
      DEVICE_HEARTBEAT_LIMITS.capabilityItemCharacters,
    ),
    wikis,
  };
}

function normalizeUnsignedMessage(value: unknown): NormalizedHeartbeat {
  if (!isRecord(value)) invalid('message');
  assertExactKeys(value, unsignedKeys, 'message');
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
    invalid('timestamp');
  }
  return {
    peerId: boundedText(
      value.peerId,
      'peerId',
      DEVICE_HEARTBEAT_LIMITS.peerIdCharacters,
    ),
    timestamp: value.timestamp as number,
    nonce: boundedText(
      value.nonce,
      'nonce',
      DEVICE_HEARTBEAT_LIMITS.nonceCharacters,
    ),
    capabilities: normalizeCapabilities(value.capabilities),
    multiaddrs: normalizedStringSet(
      value.multiaddrs,
      'multiaddrs',
      DEVICE_HEARTBEAT_LIMITS.multiaddrs,
      DEVICE_HEARTBEAT_LIMITS.multiaddrCharacters,
    ),
    relayReservations: normalizedStringSet(
      value.relayReservations,
      'relayReservations',
      DEVICE_HEARTBEAT_LIMITS.relayReservations,
      DEVICE_HEARTBEAT_LIMITS.relayReservationCharacters,
    ),
  };
}

function canonicalBytes(message: NormalizedHeartbeat): Uint8Array {
  try {
    return domainSeparatedCanonicalJsonBytes(
      DEVICE_HEARTBEAT_SIGNATURE_DOMAIN,
      message,
      {
        maxDepth: 8,
        maxNodes: 2_048,
        maxStringCodeUnits: DEVICE_HEARTBEAT_LIMITS.relayReservationCharacters,
        maxStringBytes: DEVICE_HEARTBEAT_LIMITS.relayReservationCharacters * 4,
        maxBytes: DEVICE_HEARTBEAT_LIMITS.canonicalPayloadBytes,
      },
    );
  } catch {
    invalid('payload');
  }
}

/** Build the deterministic, domain-separated bytes authenticated by a heartbeat signature. */
export function buildDeviceHeartbeatMessage(
  message: DeviceHeartbeatUnsignedMessage,
): Uint8Array {
  return canonicalBytes(normalizeUnsignedMessage(message));
}

/** Validate, canonicalize, and sign a heartbeat without requiring Node APIs. */
export async function signDeviceHeartbeatMessage(
  message: DeviceHeartbeatUnsignedMessage,
  options: DeviceHeartbeatSignOptions | DeviceHeartbeatSigner,
): Promise<DeviceHeartbeatMessage> {
  const normalized = normalizeUnsignedMessage(message);
  const sign = typeof options === 'function' ? options : options.sign;
  if (typeof sign !== 'function') invalid('signer');
  const signature = boundedText(
    await sign(canonicalBytes(normalized)),
    'signature',
    DEVICE_HEARTBEAT_LIMITS.signatureCharacters,
  );
  return { ...normalized, signature };
}

/**
 * Verify identity binding, signature, freshness, and atomic nonce consumption.
 * Any malformed input, adapter error, or missing replay store fails closed.
 */
export async function verifyDeviceHeartbeatMessage(
  message: DeviceHeartbeatMessage,
  options: VerifyDeviceHeartbeatOptions,
): Promise<boolean> {
  try {
    if (!isRecord(message)) return false;
    assertExactKeys(message, [...unsignedKeys, 'signature'], 'message');
    const signature = boundedText(
      message.signature,
      'signature',
      DEVICE_HEARTBEAT_LIMITS.signatureCharacters,
    );
    const unsigned: DeviceHeartbeatUnsignedMessage = {
      peerId: message.peerId,
      timestamp: message.timestamp,
      nonce: message.nonce,
      capabilities: message.capabilities,
      multiaddrs: message.multiaddrs,
      relayReservations: message.relayReservations,
    };
    const normalized = normalizeUnsignedMessage(unsigned);
    const publicKeyMultibase = boundedText(
      options.publicKeyMultibase,
      'publicKeyMultibase',
      DEVICE_HEARTBEAT_LIMITS.publicKeyCharacters,
    );
    const now = options.now ?? Date.now();
    const maxClockSkewMs = options.maxClockSkewMs ??
      DEVICE_HEARTBEAT_DEFAULT_MAX_CLOCK_SKEW_MS;
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(maxClockSkewMs) ||
      maxClockSkewMs < 0 ||
      Math.abs(normalized.timestamp - now) > maxClockSkewMs
    ) return false;

    const verifyIdentity = options.verifyIdentity ?? options.verify;
    if (typeof verifyIdentity !== 'function' || typeof options.consumeNonce !== 'function') {
      return false;
    }
    const payload = canonicalBytes(normalized);
    if (
      !await verifyIdentity({
        peerId: normalized.peerId,
        publicKeyMultibase,
        payload,
        signature,
      })
    ) return false;

    return await options.consumeNonce({
      peerId: normalized.peerId,
      publicKeyMultibase,
      timestamp: normalized.timestamp,
      nonce: normalized.nonce,
    });
  } catch {
    return false;
  }
}

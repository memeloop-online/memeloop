import { domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { DeviceConnectionGrant, DeviceConnectionGrantStringScope, DeviceRelayReservationToken, MemeLoopProtocol } from './types.js';

export const DEVICE_BINDING_SIGNATURE_DOMAIN = 'memeloop-device-binding-v2';
export const DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN = 'memeloop-device-connection-grant-v2';
export const DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN = 'memeloop-device-relay-admission-v2';
export const DEVICE_CONNECTION_GRANT_MAX_PEERS = 256;
export const DEVICE_CONNECTION_GRANT_MAX_RPC_METHODS = 128;
export const DEVICE_CONNECTION_GRANT_MAX_RESOURCE_IDS = 256;
export const DEVICE_CONNECTION_GRANT_MAX_SCOPE_VALUE_LENGTH = 512;
export const DEVICE_CONNECTION_GRANT_MAX_TTL_MS = 10 * 60_000;
export const DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS = 40 * 60_000;
export const DEVICE_GRANT_MAX_CLOCK_SKEW_MS = 30_000;
export const DEVICE_RELAY_RESERVATION_MAX_ADDRESSES = 64;
export const DEVICE_RELAY_RESERVATION_MAX_ADDRESS_LENGTH = 2_048;

const DEVICE_SIGNATURE_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 2_048,
  maxStringCodeUnits: 4_096,
  maxStringBytes: 16 * 1_024,
  maxBytes: 1_048_576,
});

const DEVICE_PROTOCOLS: ReadonlySet<string> = new Set<MemeLoopProtocol>([
  '/memeloop/orchestration/2.0.0',
  '/memeloop/pairing/2.0.0',
  '/memeloop/relay-admission/2.0.0',
  '/memeloop/rpc/2.0.0',
  '/memeloop/sync/2.0.0',
]);

export function buildDeviceBindingMessage(input: {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  nonce: string;
}): Uint8Array {
  return domainSeparatedCanonicalJsonBytes(
    DEVICE_BINDING_SIGNATURE_DOMAIN,
    input,
    DEVICE_SIGNATURE_LIMITS,
  );
}

export function buildDeviceConnectionGrantMessage(
  grant: Omit<DeviceConnectionGrant, 'signature'>,
): Uint8Array {
  if (!hasCanonicalDeviceConnectionGrantClaims({ ...grant, signature: 'validation-signature' })) {
    throw new Error('invalid device connection grant claims');
  }
  return domainSeparatedCanonicalJsonBytes(
    DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
    grant,
    DEVICE_SIGNATURE_LIMITS,
  );
}

/** True only for the one canonical, bounded encoding accepted by v2 verifiers. */
export function hasCanonicalDeviceConnectionGrantClaims(
  value: unknown,
): value is DeviceConnectionGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    hasOnlyKeys(grant, [
      'issuer',
      'accountId',
      'subjectPeerId',
      'allowedPeerIds',
      'protocols',
      'rpcMethodScope',
      'conversationScope',
      'definitionScope',
      'issuedAt',
      'expiresAt',
      'signature',
    ]) &&
    grant.issuer === 'memeloop-cloud' &&
    canonicalScopeValue(grant.accountId) &&
    canonicalScopeValue(grant.subjectPeerId) &&
    canonicalStringList(grant.allowedPeerIds, {
      maxEntries: DEVICE_CONNECTION_GRANT_MAX_PEERS,
    }) &&
    canonicalStringList(grant.protocols, {
      maxEntries: DEVICE_PROTOCOLS.size,
      allowedValues: DEVICE_PROTOCOLS,
    }) &&
    canonicalScope(grant.rpcMethodScope, {
      maxEntries: DEVICE_CONNECTION_GRANT_MAX_RPC_METHODS,
    }) &&
    canonicalScope(grant.conversationScope, {
      maxEntries: DEVICE_CONNECTION_GRANT_MAX_RESOURCE_IDS,
    }) &&
    canonicalScope(grant.definitionScope, {
      maxEntries: DEVICE_CONNECTION_GRANT_MAX_RESOURCE_IDS,
    }) &&
    validLifetime(
      grant.issuedAt,
      grant.expiresAt,
      DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
    ) &&
    canonicalScopeValue(grant.signature)
  );
}

function canonicalScopeValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= DEVICE_CONNECTION_GRANT_MAX_SCOPE_VALUE_LENGTH &&
    hasPairedUtf16(value) && !value.includes(',') && !value.includes('\n') &&
    !value.includes('\r');
}

export function deviceConnectionGrantAllowsProtocol(
  grant: DeviceConnectionGrant,
  protocol: MemeLoopProtocol,
): boolean {
  return hasCanonicalDeviceConnectionGrantClaims(grant) && grant.protocols.includes(protocol);
}

export function deviceConnectionGrantAllowsRpc(
  grant: DeviceConnectionGrant,
  input: { method: string; conversationId?: string; definitionId?: string },
): boolean {
  if (!deviceConnectionGrantAllowsProtocol(grant, '/memeloop/rpc/2.0.0')) return false;
  if (!canonicalScopeValue(input.method)) return false;
  if (input.conversationId !== undefined && !canonicalScopeValue(input.conversationId)) return false;
  if (input.definitionId !== undefined && !canonicalScopeValue(input.definitionId)) return false;
  if (!scopeAllows(grant.rpcMethodScope, input.method)) return false;
  if (input.conversationId !== undefined && !scopeAllows(grant.conversationScope, input.conversationId)) {
    return false;
  }
  if (input.definitionId !== undefined && !scopeAllows(grant.definitionScope, input.definitionId)) {
    return false;
  }
  return true;
}

function scopeAllows(scope: DeviceConnectionGrantStringScope, value: string): boolean {
  return scope.mode === 'all' || (scope.mode === 'ids' && scope.ids.includes(value));
}

function canonicalScope(value: unknown, options: CanonicalStringListOptions): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.mode === 'none' || scope.mode === 'all') {
    return Object.keys(scope).length === 1;
  }
  return scope.mode === 'ids' && Object.keys(scope).length === 2 &&
    Object.hasOwn(scope, 'ids') && canonicalStringList(scope.ids, options) &&
    (scope.ids as unknown[]).length > 0;
}

interface CanonicalStringListOptions {
  maxEntries: number;
  allowedValues?: ReadonlySet<string>;
}

function canonicalStringList(value: unknown, options: CanonicalStringListOptions): boolean {
  if (!Array.isArray(value) || value.length > options.maxEntries) return false;
  let previous: string | undefined;
  for (const entry of value) {
    if (
      !canonicalScopeValue(entry) ||
      (options.allowedValues && !options.allowedValues.has(entry)) ||
      (previous !== undefined && previous >= entry)
    ) return false;
    previous = entry;
  }
  return true;
}

export function buildDeviceRelayReservationTokenMessage(
  token: Omit<DeviceRelayReservationToken, 'signature'>,
): Uint8Array {
  if (
    !hasCanonicalDeviceRelayReservationTokenClaims({
      ...token,
      signature: 'validation-signature',
    })
  ) {
    throw new Error('invalid device relay reservation token claims');
  }
  return domainSeparatedCanonicalJsonBytes(
    DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
    token,
    DEVICE_SIGNATURE_LIMITS,
  );
}

/** Reject ambiguous/unbounded relay claims before signing or verification. */
export function hasCanonicalDeviceRelayReservationTokenClaims(
  value: unknown,
): value is DeviceRelayReservationToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return hasOnlyKeys(token, [
    'issuer',
    'accountId',
    'peerId',
    'relayMultiaddrs',
    'bootstrapMultiaddrs',
    'issuedAt',
    'expiresAt',
    'signature',
  ]) && token.issuer === 'memeloop-cloud' && canonicalScopeValue(token.accountId) &&
    canonicalScopeValue(token.peerId) && validLifetime(
      token.issuedAt,
      token.expiresAt,
      DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
    ) &&
    canonicalAddressList(token.relayMultiaddrs, false) &&
    canonicalAddressList(token.bootstrapMultiaddrs, true) &&
    canonicalScopeValue(token.signature);
}

function canonicalAddressList(value: unknown, allowEmpty: boolean): boolean {
  if (!Array.isArray(value) || value.length > DEVICE_RELAY_RESERVATION_MAX_ADDRESSES) {
    return false;
  }
  if (!allowEmpty && value.length === 0) return false;
  let previous: string | undefined;
  for (const address of value) {
    if (
      typeof address !== 'string' || address.length === 0 ||
      address.length > DEVICE_RELAY_RESERVATION_MAX_ADDRESS_LENGTH ||
      address !== address.trim() || !hasPairedUtf16(address) || !address.startsWith('/') ||
      containsAsciiControlOrSpace(address) ||
      (previous !== undefined && previous >= address)
    ) return false;
    previous = address;
  }
  return true;
}

function validLifetime(issuedAt: unknown, expiresAt: unknown, maxTtlMs: number): boolean {
  return Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
    (issuedAt as number) >= 0 && (expiresAt as number) > (issuedAt as number) &&
    (expiresAt as number) - (issuedAt as number) <= maxTtlMs;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every(key => allowedKeys.has(key)) &&
    allowed.every(key => Object.hasOwn(record, key));
}

function hasPairedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

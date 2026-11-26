import { peerIdFromString } from '@libp2p/peer-id';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';
import type { DeviceRelayReservationToken } from 'memeloop/device-network/portable';
import { strictMultiaddrs } from './networkAddresses.js';
import type { RelayReservationVerificationOptions } from './networkTypes.js';
import { DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS, DEFAULT_RELAY_RESERVATION_TTL_MS, RELAY_ADMISSION_RESPONSE_TYPE } from './protocolConstants.js';
import type { RelayAdmissionResponseMessage } from './relayTypes.js';

export function isRelayAdmissionResponse(value: unknown): value is RelayAdmissionResponseMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === RELAY_ADMISSION_RESPONSE_TYPE && typeof record.ok === 'boolean';
}

export function relayCircuitMultiaddr(address: string): Multiaddr {
  const parsed = multiaddr(address);
  return address.includes('/p2p-circuit') ? parsed : parsed.encapsulate('/p2p-circuit');
}

export function validateRelayReservationVerificationOptions(
  options: RelayReservationVerificationOptions | undefined,
): void {
  if (!options) return;
  const reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
  const reservationSafetyMarginMs = options.reservationSafetyMarginMs ??
    DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new Error('invalid_relay_reservation_ttl');
  }
  if (!Number.isSafeInteger(reservationSafetyMarginMs) || reservationSafetyMarginMs < 0) {
    throw new Error('invalid_relay_reservation_safety_margin');
  }
  if (!Number.isSafeInteger(reservationTtlMs + reservationSafetyMarginMs)) {
    throw new Error('invalid_relay_reservation_lifetime');
  }
}

export function relayTokenCoversReservation(
  token: DeviceRelayReservationToken,
  now: number,
  reservationTtlMs: number,
  reservationSafetyMarginMs: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(token.issuedAt) &&
    Number.isSafeInteger(token.expiresAt) &&
    token.issuedAt <= token.expiresAt &&
    token.expiresAt > now &&
    token.expiresAt - now >= reservationTtlMs + reservationSafetyMarginMs
  );
}

export function relayTokenAudiencePeerId(addresses: unknown): string | undefined {
  const relayMultiaddrs = strictMultiaddrs(addresses);
  if (!relayMultiaddrs || relayMultiaddrs.length === 0) return undefined;
  let audiencePeerId: string | undefined;
  for (const address of relayMultiaddrs) {
    const components = multiaddr(address).getComponents();
    if (components.some((component) => component.name === 'p2p-circuit')) return undefined;
    const peerComponents = components.filter((component) => component.name === 'p2p');
    if (peerComponents.length !== 1 || components.at(-1) !== peerComponents[0]) return undefined;
    const peerId = peerComponents[0]?.value;
    if (!peerId) return undefined;
    try {
      if (peerIdFromString(peerId).toString() !== peerId) return undefined;
    } catch {
      return undefined;
    }
    audiencePeerId ??= peerId;
    if (peerId !== audiencePeerId) return undefined;
  }
  return audiencePeerId;
}

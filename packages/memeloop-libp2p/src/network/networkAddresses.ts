import { peerIdFromString } from '@libp2p/peer-id';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';
import { CLOUD_DIRECTORY_MAX_ADDRESS_LENGTH, CLOUD_DIRECTORY_MAX_ADDRESSES, PAIRING_MAX_MULTIADDR_LENGTH, PAIRING_MAX_MULTIADDRS } from './protocolConstants.js';

export function strictMultiaddrs(addresses: unknown): string[] | undefined {
  if (!Array.isArray(addresses)) return undefined;
  const parsed: string[] = [];
  for (const address of addresses) {
    if (typeof address !== 'string' || address.length === 0 || address !== address.trim()) {
      return undefined;
    }
    try {
      multiaddr(address);
      parsed.push(address);
    } catch {
      return undefined;
    }
  }
  return parsed;
}

/**
 * Cloud directory addresses are executable dial targets, not display data.
 * Require every address to terminate in the advertised destination PeerId so
 * a compromised/stale directory response cannot redirect an authenticated RPC
 * or sync request to another libp2p identity. Relay circuit addresses may have
 * an earlier relay PeerId; the final component must still be the destination.
 */
export function strictPeerBoundMultiaddrs(peerId: string, addresses: readonly string[]): string[] {
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('non_canonical_peer_id');
  } catch {
    throw new Error('invalid_cloud_directory_peer_id');
  }
  if (addresses.length > CLOUD_DIRECTORY_MAX_ADDRESSES) {
    throw new Error('too_many_cloud_directory_addresses');
  }

  const unique = new Set<string>();
  for (const address of addresses) {
    if (
      typeof address !== 'string' ||
      address.length === 0 ||
      address.length > CLOUD_DIRECTORY_MAX_ADDRESS_LENGTH ||
      address !== address.trim()
    ) {
      throw new Error('invalid_cloud_directory_address');
    }
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(address);
    } catch {
      throw new Error('invalid_cloud_directory_address');
    }
    const components = parsed.getComponents();
    const finalComponent = components.at(-1);
    if (finalComponent?.name !== 'p2p' || finalComponent.value !== peerId) {
      throw new Error('cloud_directory_address_peer_id_mismatch');
    }
    unique.add(parsed.toString());
  }
  return [...unique].sort();
}

/**
 * Pairing envelopes are untrusted discovery input. Every executable address
 * must terminate in the Noise-authenticated device PeerId. Circuit relay
 * addresses may contain a relay PeerId earlier in the path, but the invited
 * device must remain the final `/p2p` component.
 */
export function strictPairingMultiaddrs(peerId: string, addresses: readonly unknown[]): string[] {
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('non_canonical_peer_id');
  } catch {
    throw new Error('invalid_pairing_peer_id');
  }
  if (addresses.length > PAIRING_MAX_MULTIADDRS) {
    throw new Error('too_many_pairing_addresses');
  }
  const unique = new Set<string>();
  for (const address of addresses) {
    if (
      typeof address !== 'string' ||
      address.length === 0 ||
      address.length > PAIRING_MAX_MULTIADDR_LENGTH ||
      address !== address.trim()
    ) throw new Error('invalid_pairing_address');
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(address);
    } catch {
      throw new Error('invalid_pairing_address');
    }
    const finalComponent = parsed.getComponents().at(-1);
    if (finalComponent?.name !== 'p2p' || finalComponent.value !== peerId) {
      throw new Error('pairing_address_peer_id_mismatch');
    }
    const canonical = parsed.toString();
    if (unique.has(canonical)) throw new Error('duplicate_pairing_address');
    unique.add(canonical);
  }
  return [...unique];
}

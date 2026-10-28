import type { AddressSorter } from '@libp2p/interface';
import { circuitRelayAddressesLast, loopbackAddressLast, publicAddressesFirst, reliableTransportsFirst } from '@libp2p/utils';

/** Keep libp2p's normal ordering except for a destination that already worked. */
export function preferredDialAddressSorter(isPreferred?: (address: string) => boolean): AddressSorter {
  return (a, b) => {
    const preferredA = isPreferred?.(a.multiaddr.toString()) ?? false;
    const preferredB = isPreferred?.(b.multiaddr.toString()) ?? false;
    if (preferredA !== preferredB) return preferredA ? -1 : 1;
    return loopbackAddressLast(a.multiaddr, b.multiaddr) ||
      publicAddressesFirst(a.multiaddr, b.multiaddr) ||
      circuitRelayAddressesLast(a.multiaddr, b.multiaddr) ||
      (a.isCertified === b.isCertified ? 0 : a.isCertified ? -1 : 1) ||
      reliableTransportsFirst(a.multiaddr, b.multiaddr);
  };
}

import { createBrowserLibp2p } from './browserLibp2pFactory.js';
import { type Libp2pDeviceNetworkServiceOptions as PortableOptions, PortableLibp2pDeviceNetworkService } from './portableLibp2pDeviceNetworkService.js';

export * from './portableLibp2pDeviceNetworkService.js';

export type BrowserLibp2pDeviceNetworkServiceOptions = Omit<PortableOptions, 'nodeFactory'>;

/** Browser/React-Native adapter with no Node TCP, net, or mDNS dependency. */
export class BrowserLibp2pDeviceNetworkService extends PortableLibp2pDeviceNetworkService {
  public constructor(options: BrowserLibp2pDeviceNetworkServiceOptions) {
    super({
      ...options,
      listen: options.listen ?? { addresses: [] },
      enableMdns: false,
      nodeFactory: createBrowserLibp2p,
    });
  }
}

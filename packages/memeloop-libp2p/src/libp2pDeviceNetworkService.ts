import { createNodeLibp2p } from './nodeLibp2pFactory.js';
import { type Libp2pDeviceNetworkServiceOptions as PortableOptions, PortableLibp2pDeviceNetworkService } from './portableLibp2pDeviceNetworkService.js';

export * from './portableLibp2pDeviceNetworkService.js';

export type Libp2pDeviceNetworkServiceOptions = Omit<PortableOptions, 'nodeFactory'>;

/** Node host adapter with TCP, WebSocket, circuit-relay, and mDNS transports. */
export class Libp2pDeviceNetworkService extends PortableLibp2pDeviceNetworkService {
  public constructor(options: Libp2pDeviceNetworkServiceOptions) {
    super({ ...options, nodeFactory: createNodeLibp2p });
  }
}

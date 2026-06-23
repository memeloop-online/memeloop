import { type DeviceAuthorizer, type DeviceCapabilities, type DeviceRpcHandler, type DeviceTrustStore, type IAgentStorage, Libp2pDeviceNetworkService } from 'memeloop';

import type { CliDeviceIdentity } from './identity.js';
import { FileDeviceTrustStore } from './trustStore.js';

export { DeviceCloudClient } from './cloudClient.js';
export { getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './identity.js';
export type { CliDeviceIdentity } from './identity.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustStore?: DeviceTrustStore;
  authorizer?: DeviceAuthorizer;
  syncStorage?: IAgentStorage;
  rpcHandler?: DeviceRpcHandler;
}): Libp2pDeviceNetworkService {
  const trustStore = input.trustStore ?? new FileDeviceTrustStore();
  return new Libp2pDeviceNetworkService({
    identity: input.identity,
    capabilities: input.capabilities,
    trustStore,
    authorizer: input.authorizer,
    enableMdns: true,
    syncStorage: input.syncStorage,
    rpcHandler: input.rpcHandler,
  });
}

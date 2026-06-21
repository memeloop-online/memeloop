import { Libp2pDeviceNetworkService, type DeviceCapabilities } from 'memeloop';

import type { CliDeviceIdentity } from './identity.js';

export { DeviceCloudClient } from './cloudClient.js';
export { getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './identity.js';
export type { CliDeviceIdentity } from './identity.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
}): Libp2pDeviceNetworkService {
  return new Libp2pDeviceNetworkService({
    identity: input.identity,
    capabilities: input.capabilities,
    enableMdns: true,
  });
}

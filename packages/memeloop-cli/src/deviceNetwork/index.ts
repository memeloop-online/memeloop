import { type DeviceCapabilities, Libp2pDeviceNetworkService } from 'memeloop';

import type { CliDeviceIdentity } from './identity.js';
import { FileDeviceTrustStore } from './trustStore.js';

export { DeviceCloudClient } from './cloudClient.js';
export { getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './identity.js';
export type { CliDeviceIdentity } from './identity.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
}): Libp2pDeviceNetworkService {
  const trustStore = new FileDeviceTrustStore();
  return new Libp2pDeviceNetworkService({
    identity: input.identity,
    capabilities: input.capabilities,
    trustStore,
    enableMdns: true,
  });
}

import { type DeviceCapabilities, MemoryDeviceNetworkService } from 'memeloop';

import type { CliDeviceIdentity } from './identity.js';

export { DeviceCloudClient } from './cloudClient.js';
export { getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './identity.js';
export type { CliDeviceIdentity } from './identity.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
}): MemoryDeviceNetworkService {
  return new MemoryDeviceNetworkService({
    identity: input.identity,
    capabilities: input.capabilities,
  });
}

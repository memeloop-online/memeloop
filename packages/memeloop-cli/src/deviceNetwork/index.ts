import { Libp2pDeviceNetworkService } from '@memeloop/libp2p';
import type { DeviceAuthorizer, DeviceCapabilities, DeviceRpcHandler, DeviceTrustStore, IAgentStorage } from 'memeloop';
import type { CliDeviceIdentity } from './identity.js';
import { FileDeviceTrustStore } from './trustStore.js';

export {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  CloudDeviceAuthorizer,
  createDeviceIdentity,
  decodePublicKeyMultibase,
  Libp2pDeviceNetworkService,
  signDeviceBinding as signLibp2pDeviceBinding,
  verifyDeviceBinding,
  verifyDeviceConnectionGrant,
  verifyDeviceRelayReservationToken,
} from '@memeloop/libp2p';
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

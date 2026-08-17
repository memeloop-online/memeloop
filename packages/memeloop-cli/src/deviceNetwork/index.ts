import { Libp2pDeviceNetworkService } from '@memeloop/libp2p';
import type { DeviceAuthorizer, DeviceCapabilities, DeviceOrchestrationStreamHandler, DeviceRpcHandler, DeviceSyncStateStore, DeviceTrustStore, IAgentStorage } from 'memeloop';
import type { CliDeviceIdentity } from './identity.js';
import { FileDeviceTrustStore } from './trustStore.js';

export {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  CloudDeviceAuthorizer,
  createDeviceIdentity,
  createSignedDevicePairingInvite,
  decodePublicKeyMultibase,
  Libp2pDeviceNetworkService,
  signDeviceBinding as signLibp2pDeviceBinding,
  verifyDeviceBinding,
  verifyDeviceConnectionGrant,
  verifyDevicePairingInviteIdentity,
  verifyDeviceRelayReservationToken,
} from '@memeloop/libp2p';
export { locallyPairedRecord, MutableDeviceAuthorizer } from './authorizer.js';
export { DeviceCloudClient, normalizeDeviceCloudConfiguration } from './cloudClient.js';
export { CliCloudConnection, hasValidDirectDeviceAddress } from './cloudConnection.js';
export type { CliCloudConnectionOptions, CliCloudNetworkAdapter } from './cloudConnection.js';
export { syncCliCloudDirectory } from './cloudDirectory.js';
export type { CliCloudDirectoryNetwork } from './cloudDirectory.js';
export { getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './identity.js';
export type { CliDeviceIdentity, DeviceIdentitySecretStore, LoadOrCreateDeviceIdentityOptions } from './identity.js';
export { createOrdinaryPeerOrchestrationHandler, ordinaryPeerNamespace } from './ordinaryPeerOrchestration.js';
export { pairWithInviteFile } from './pairingInviteFile.js';
export type { PairingInviteEvidence, PairingInviteNetwork } from './pairingInviteFile.js';
export { FileDeviceSyncStateStore } from './syncStateStore.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustStore?: DeviceTrustStore;
  authorizer?: DeviceAuthorizer;
  syncStorage?: IAgentStorage;
  syncStateStore?: DeviceSyncStateStore;
  rpcHandler?: DeviceRpcHandler;
  orchestrationHandler?: DeviceOrchestrationStreamHandler;
}): Libp2pDeviceNetworkService {
  const trustStore = input.trustStore ?? new FileDeviceTrustStore();
  return new Libp2pDeviceNetworkService({
    identity: input.identity,
    capabilities: input.capabilities,
    trustStore,
    authorizer: input.authorizer,
    enableMdns: true,
    syncStorage: input.syncStorage,
    syncStateStore: input.syncStateStore,
    rpcHandler: input.rpcHandler,
    orchestrationHandler: input.orchestrationHandler,
  });
}

import { Libp2pDeviceNetworkService } from '@memeloop/libp2p';
import type { DeviceAuthorizer, DeviceCapabilities, DeviceOrchestrationStreamHandler, DeviceRpcHandler, DeviceTrustStore, FullAgentStorage } from 'memeloop';
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
export { authorizeAgentRuntimeRpcWithDeviceAuthorizer, locallyPairedRecord, MutableDeviceAuthorizer } from './authorizer.js';
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
export { FileDeviceTrustStore, getDefaultDeviceTrustStorePath } from './trustStore.js';
export type { CliCloudDirectorySnapshotTrustStore } from './trustStore.js';

export function createCliDeviceNetworkService(input: {
  identity: CliDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustStore?: DeviceTrustStore;
  authorizer?: DeviceAuthorizer;
  syncStorage?: FullAgentStorage;
  rpcHandler?: DeviceRpcHandler;
  resolveRunGrantResources?: (
    runId: string,
    remotePeerId: string,
  ) => Promise<
    {
      requestPeerId: string;
      conversationId: string;
      definitionId: string;
    } | undefined
  >;
  orchestrationHandler?: DeviceOrchestrationStreamHandler;
  getRelayAdmissionVerificationPublicKeyMultibase?: () => string | undefined;
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
    resolveRunGrantResources: input.resolveRunGrantResources,
    orchestrationHandler: input.orchestrationHandler,
    ...(input.getRelayAdmissionVerificationPublicKeyMultibase
      ? {
        relayReservationVerification: {
          getVerificationPublicKeyMultibase: input.getRelayAdmissionVerificationPublicKeyMultibase,
        },
      }
      : {}),
  });
}

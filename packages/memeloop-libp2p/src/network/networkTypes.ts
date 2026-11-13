import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type {
  DeviceAuthorizer,
  DeviceCapabilities,
  DeviceNetworkListenOptions,
  DeviceOrchestrationStreamHandler,
  DeviceRpcHandler,
  DeviceTrustStore,
  FullAgentStorage,
  LocalDeviceIdentity,
  TrustedDeviceRecord,
} from 'memeloop/device-network/portable';

export interface Libp2pDeviceNetworkServiceOptions {
  identity: LocalDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustedDevices?: TrustedDeviceRecord[];
  trustStore?: DeviceTrustStore;
  authorizer?: DeviceAuthorizer;
  listen?: DeviceNetworkListenOptions;
  bootstrapMultiaddrs?: string[];
  enableCircuitRelay?: boolean;
  enableMdns?: boolean;
  autoDialDiscoveredPeers?: boolean;
  syncStorage?: FullAgentStorage;
  rpcHandler?: DeviceRpcHandler;
  /**
   * Resolve a run to its durable, authenticated owner and resources. Cloud
   * grants cannot authorize run-id-only RPCs without this binding.
   */
  resolveRunGrantResources?: (
    runId: string,
    remotePeerId: string,
  ) => Promise<DeviceRpcRunGrantResources | undefined>;
  orchestrationHandler?: DeviceOrchestrationStreamHandler;
  relayReservationVerification?: RelayReservationVerificationOptions;
  nodeFactory: Libp2pNodeFactory;
}

export interface DeviceRpcRunGrantResources {
  requestPeerId: string;
  conversationId: string;
  definitionId: string;
}

export interface RelayReservationVerificationOptions {
  /** Return the currently pinned Cloud grant/admission verification key. */
  getVerificationPublicKeyMultibase: () => string | undefined;
  /** Must match the private relay's full circuit reservation lifetime. */
  reservationTtlMs?: number;
  /** Extra token lifetime required beyond the relay reservation lifetime. */
  reservationSafetyMarginMs?: number;
  now?: () => number;
}

export interface Libp2pNodeFactoryOptions {
  /** Prefer a retained successful pairing route over newly advertised addresses. */
  isPreferredDialAddress?: (address: string) => boolean;
  /** Destinations explicitly selected for pairing or belonging to a trusted peer. */
  isExplicitDialAddress?: (address: string) => boolean;
  bootstrapMultiaddrs: string[];
  enableCircuitRelay: boolean;
  enableMdns: boolean;
  listen: DeviceNetworkListenOptions;
  privateKey: PrivateKey;
}

export type Libp2pNodeFactory = (options: Libp2pNodeFactoryOptions) => Promise<Libp2p>;

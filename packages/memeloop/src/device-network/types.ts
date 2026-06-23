import type { ChatMessage } from '../conversation/index.js';
import type { ConversationMeta, VersionVector } from '../sync/protocol.js';

export type DevicePlatform = 'desktop' | 'mobile' | 'cli';
export type DeviceTrustMode = 'local-pairing' | 'cloud-account';
export type DeviceReachabilityState = 'nearby' | 'online' | 'offline' | 'connecting';
export type DeviceNetworkPath = 'lan' | 'direct' | 'relay';
export type DeviceProtocolDirection = 'inbound' | 'outbound';
export type PairingSessionDirection = 'inbound' | 'outbound';
export type PairingSessionStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export type MemeLoopProtocol =
  | '/memeloop/rpc/1.0.0'
  | '/memeloop/sync/1.0.0'
  | '/memeloop/agent/1.0.0'
  | '/memeloop/pairing/1.0.0';

export interface DeviceCapabilities {
  tools: string[];
  mcpServers: string[];
  hasWiki: boolean;
  imChannels: string[];
  wikis: Array<{
    wikiId: string;
    title?: string;
    pathHint?: string;
  }>;
}

export interface LocalDeviceIdentity {
  peerId: string;
  publicKeyMultibase: string;
  privateKeyRef: string;
  privateKeyPkcs8Base64Url?: string;
  privateKeyRawSeedBase64Url?: string;
  createdAt: number;
  deviceName: string;
  platform: DevicePlatform;
}

export interface DeviceNetworkListenOptions {
  addresses: string[];
  announce?: string[];
}

export interface DeviceReachability {
  state: DeviceReachabilityState;
  paths: DeviceNetworkPath[];
}

export interface Device {
  peerId: string;
  displayName: string;
  platform: DevicePlatform;
  trustMode: DeviceTrustMode;
  reachability: DeviceReachability;
  capabilities: DeviceCapabilities;
  multiaddrs?: string[];
  lastSeen?: number;
}

export interface TrustedDeviceRecord {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  trustMode: DeviceTrustMode;
  accountId?: string;
  createdAt: number;
  lastSeen?: number;
  revokedAt?: number;
}

export interface DeviceTrustStore {
  loadTrustedDevices(): Promise<TrustedDeviceRecord[]>;
  saveTrustedDevice(record: TrustedDeviceRecord): Promise<void>;
  removeTrustedDevice(peerId: string): Promise<void>;
}

export interface DeviceAccountBindingRequest {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  cloudNonce: string;
  signature: string;
}

export interface CloudDeviceRecord {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
  relayReservations: string[];
  lastSeen: number;
  revokedAt?: number;
}

export interface DeviceConnectionGrant {
  issuer: 'memeloop-cloud';
  accountId: string;
  subjectPeerId: string;
  allowedPeerIds: string[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface DeviceConnectionGrantVerificationInput {
  grant: DeviceConnectionGrant;
  verificationPublicKeyMultibase: string;
  subjectPeerId?: string;
  allowedPeerId?: string;
  now?: number;
}

export interface PairingSession {
  sessionId: string;
  localPeerId: string;
  remotePeerId: string;
  remotePublicKeyMultibase: string;
  remoteDeviceName: string;
  remotePlatform: DevicePlatform;
  remoteCapabilities: DeviceCapabilities;
  remoteMultiaddrs: string[];
  direction: PairingSessionDirection;
  status: PairingSessionStatus;
  confirmCode: string;
  createdAt: number;
  expiresAt: number;
}

export interface LocalPairingRequestOptions {
  multiaddrs?: string[];
}

export interface SyncResult {
  ok: boolean;
  peerId: string;
  syncedAt: number;
}

export interface MemeLoopDuplexStream {
  source: AsyncIterable<Uint8Array>;
  sink(source: AsyncIterable<Uint8Array>): Promise<void>;
  close(): Promise<void>;
}

export interface DeviceAuthorizer {
  canOpenProtocol(input: {
    remotePeerId: string;
    protocol: MemeLoopProtocol;
    direction?: DeviceProtocolDirection;
    presentedGrant?: DeviceConnectionGrant;
  }): Promise<boolean>;
}

export interface CloudDeviceClient {
  listDevices(): Promise<CloudDeviceRecord[]>;
  getConnectionGrantPublicKey(): Promise<{ issuer: string; publicKeyMultibase: string }>;
  createConnectionGrant(input: {
    subjectPeerId: string;
    allowedPeerIds: string[];
  }): Promise<DeviceConnectionGrant>;
  createBindingNonce(): Promise<{ nonce: string; accountId: string; expiresAt: string }>;
  registerDevice(
    input: DeviceAccountBindingRequest & {
      identity: LocalDeviceIdentity;
      capabilities: DeviceCapabilities;
      multiaddrs: string[];
      relayReservations: string[];
    },
  ): Promise<{ ok: boolean; peerId: string }>;
  heartbeat(input: {
    peerId: string;
    capabilities: DeviceCapabilities;
    multiaddrs: string[];
    relayReservations: string[];
  }): Promise<{ ok: boolean }>;
}

export interface DeviceNetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLocalDevice(): Promise<Device>;
  listDevices(): Promise<Device[]>;
  observeDevices(listener: (devices: Device[]) => void): () => void;
  listPairingSessions(): Promise<PairingSession[]>;
  observePairingSessions(listener: (sessions: PairingSession[]) => void): () => void;
  requestLocalPairing(peerId: string, options?: LocalPairingRequestOptions): Promise<PairingSession>;
  acceptPairing(sessionId: string): Promise<void>;
  rejectPairing(sessionId: string): Promise<void>;
  removeTrustedDevice(peerId: string): Promise<void>;
  openStream(
    peerId: string,
    protocol: MemeLoopProtocol,
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<MemeLoopDuplexStream>;
  sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<T>;
  syncWithDevice(peerId: string, presentedGrant?: DeviceConnectionGrant): Promise<SyncResult>;

  /** Configure Cloud connection. When set, syncCloudDevices() and CloudDeviceAuthorizer become available. */
  configureCloud?(config: { cloudUrl: string; accessToken: string }): void;
  /** Fetch devices from Cloud directory and persist into local trust store. Returns synced devices. */
  syncCloudDevices?(): Promise<CloudDeviceRecord[]>;
}

export interface ExchangeVersionVectorResult {
  remoteVersion: VersionVector;
  missingForRemote: ConversationMeta[];
}

export interface AttachmentBlob {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  size: number;
}

export interface DeviceSyncTransport {
  listPeers(): Promise<Device[]>;
  exchangeVersionVector(peerId: string, localVersion: VersionVector): Promise<ExchangeVersionVectorResult>;
  pullMissingMetadata(peerId: string, sinceVersion: VersionVector): Promise<ConversationMeta[]>;
  pullMissingMessages(peerId: string, conversationId: string, knownMessageIds: string[]): Promise<ChatMessage[]>;
  pullAttachmentBlob(peerId: string, contentHash: string): Promise<AttachmentBlob | null>;
}

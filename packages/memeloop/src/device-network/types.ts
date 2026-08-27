import type { ConversationEvent, ConversationEventCursor } from '../conversation/index.js';
import type { MessageVersionFrontier, MessageVersionFrontierCursor, MessageVersionFrontierPage } from '../storage/ports.js';
import type { SyncIoOptions } from '../sync/chatSyncEngine.js';
import type { ConversationEventSyncPage, VersionRange } from '../sync/protocol.js';

export type DevicePlatform = 'desktop' | 'mobile' | 'cli' | 'web';
export type DeviceTrustMode = 'local-pairing' | 'cloud-account';
export type DeviceReachabilityState = 'nearby' | 'online' | 'offline' | 'connecting';
export type DeviceNetworkPath = 'lan' | 'direct' | 'relay';
export type DeviceProtocolDirection = 'inbound' | 'outbound';
export type PairingSessionDirection = 'inbound' | 'outbound';
export type PairingSessionStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/** Generation-scoped authority for a final synchronous host or persistence write. */
export interface DeviceCloudCommitFence {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  throwIfStale(): void;
  commitSynchronous<Result>(
    operation: () => Result extends PromiseLike<unknown> ? never : Result,
  ): boolean;
}

export type MemeLoopProtocol =
  | '/memeloop/rpc/2.0.0'
  | '/memeloop/sync/2.0.0'
  | '/memeloop/pairing/2.0.0'
  | '/memeloop/orchestration/2.0.0'
  | '/memeloop/relay-admission/2.0.0';

export interface DeviceCapabilities {
  tools: string[];
  mcpServers: string[];
  hasWiki: boolean;
  agentLoop?: boolean;
  imChannels: string[];
  wikis: Array<{
    wikiId: string;
    title?: string;
    pathHint?: string;
  }>;
}

/** Device identity fields safe to disclose to Cloud and remote peers. */
export interface PublicDeviceIdentity {
  peerId: string;
  publicKeyMultibase: string;
  createdAt: number;
  deviceName: string;
  platform: DevicePlatform;
}

/** Host-local identity. Private-key material must never cross an adapter boundary. */
export interface LocalDeviceIdentity extends PublicDeviceIdentity {
  privateKeyRef: string;
  privateKeyPkcs8Base64Url?: string;
  privateKeyRawSeedBase64Url?: string;
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
  trusted?: boolean;
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
  protocols: MemeLoopProtocol[];
  rpcMethodScope: DeviceConnectionGrantStringScope;
  conversationScope: DeviceConnectionGrantStringScope;
  definitionScope: DeviceConnectionGrantStringScope;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export type DeviceConnectionGrantStringScope =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'ids'; ids: string[] };

export interface DeviceConnectionGrantVerificationInput {
  grant: DeviceConnectionGrant;
  verificationPublicKeyMultibase: string;
  subjectPeerId?: string;
  allowedPeerId?: string;
  now?: number;
}

export interface DeviceRelayReservationToken {
  issuer: 'memeloop-cloud';
  accountId: string;
  peerId: string;
  relayMultiaddrs: string[];
  bootstrapMultiaddrs: string[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface DeviceRelayReservationTokenVerificationInput {
  token: DeviceRelayReservationToken;
  verificationPublicKeyMultibase: string;
  peerId?: string;
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
  /** Cancels dialing and the in-flight pairing frame exchange. */
  signal?: AbortSignal;
}

export interface SyncProgress {
  passes: number;
  peers: number;
  /** Bounded frontier metadata pages inspected while discovering transfer work. */
  frontierPages: number;
  /** Event/attachment transfer pages. */
  pages: number;
  events: number;
  bytes: number;
  elapsedMs: number;
}

export interface SyncContinuation {
  reason: 'pass-limit' | 'time-limit';
  /**
   * Continuations never carry an authoritative cursor. A later call resumes
   * from the durable event frontier, so cancellation or process restart cannot
   * skip acknowledged work.
   */
  resumeFrom: 'durable-frontier';
}

export interface SyncResult {
  /** The bounded operation itself succeeded, including an incomplete resumable result. */
  ok: true;
  peerId: string;
  syncedAt: number;
  complete: boolean;
  progress: SyncProgress;
  continuation?: SyncContinuation;
}

export type DeviceNetworkUnavailableCode =
  | 'device_network_pairing_unavailable'
  | 'device_network_stream_unavailable'
  | 'device_network_sync_unavailable';

/** Stable, non-secret error for an adapter that cannot perform a network operation. */
export class DeviceNetworkUnavailableError extends Error {
  public readonly code: DeviceNetworkUnavailableCode;

  constructor(code: DeviceNetworkUnavailableCode) {
    super(code);
    this.name = 'DeviceNetworkUnavailableError';
    this.code = code;
  }
}

export interface MemeLoopDuplexStream {
  source: AsyncIterable<Uint8Array>;
  sink(source: AsyncIterable<Uint8Array>): Promise<void>;
  close(): Promise<void>;
  abort(error: Error): void | Promise<void>;
  /** Aborts when the underlying remote stream disconnects or is reset. */
  signal?: AbortSignal;
}

export interface DeviceRpcHandlerInput {
  remotePeerId: string;
  method: string;
  parameters: unknown;
  presentedGrant?: DeviceConnectionGrant;
  /** Aborts when the authenticated transport request is cancelled or disconnected. */
  signal?: AbortSignal;
}

export type DeviceRpcHandler = (input: DeviceRpcHandlerInput) => Promise<unknown>;

export interface DeviceStreamOptions {
  presentedGrant?: DeviceConnectionGrant;
  signal?: AbortSignal;
}

export type AgentExecutionLocation = { kind: 'local' } | { kind: 'device'; peerId: string };

export type AgentExecutionState = 'idle' | 'running' | 'stopping';

export interface ConversationExecutionPlacement {
  conversationId: string;
  location: AgentExecutionLocation;
  state: AgentExecutionState;
  updatedAt: number;
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
  listDevices(signal?: AbortSignal): Promise<CloudDeviceRecord[]>;
  getConnectionGrantPublicKey(signal?: AbortSignal): Promise<{
    issuer: 'memeloop-cloud';
    publicKeyMultibase: string;
  }>;
  createConnectionGrant(input: {
    subjectPeerId: string;
    allowedPeerIds: string[];
    protocols: MemeLoopProtocol[];
    rpcMethodScope: DeviceConnectionGrantStringScope;
    conversationScope: DeviceConnectionGrantStringScope;
    definitionScope: DeviceConnectionGrantStringScope;
  }, signal?: AbortSignal): Promise<DeviceConnectionGrant>;
  createRelayReservation(
    input: { peerId: string },
    signal?: AbortSignal,
  ): Promise<DeviceRelayReservationToken>;
  createBindingNonce(signal?: AbortSignal): Promise<{
    nonce: string;
    accountId: string;
    expiresAt: string;
  }>;
  registerDevice(
    input: Pick<DeviceAccountBindingRequest, 'cloudNonce' | 'signature'> & {
      identity: PublicDeviceIdentity;
      capabilities: DeviceCapabilities;
      multiaddrs: string[];
      relayReservations: string[];
    },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; peerId: string }>;
  heartbeat(input: {
    peerId: string;
    timestamp: number;
    nonce: string;
    capabilities: DeviceCapabilities;
    multiaddrs: string[];
    relayReservations: string[];
    signature: string;
  }, signal?: AbortSignal): Promise<{ ok: boolean }>;
}

export interface DeviceNetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLocalDevice(): Promise<Device>;
  listDevices(): Promise<Device[]>;
  observeDevices(listener: (devices: Device[]) => void): () => void;
  listPairingSessions(): Promise<PairingSession[]>;
  observePairingSessions(listener: (sessions: PairingSession[]) => void): () => void;
  requestLocalPairing(
    peerId: string,
    options?: LocalPairingRequestOptions,
  ): Promise<PairingSession>;
  acceptPairing(sessionId: string): Promise<void>;
  rejectPairing(sessionId: string): Promise<void>;
  removeTrustedDevice(peerId: string): Promise<void>;
  openStream(
    peerId: string,
    protocol: MemeLoopProtocol,
    options?: DeviceStreamOptions,
  ): Promise<MemeLoopDuplexStream>;
  sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    options?: DeviceStreamOptions,
  ): Promise<T>;
  syncWithDevice(peerId: string, options?: DeviceSyncOptions): Promise<SyncResult>;

  /** Configure Cloud connection. When set, syncCloudDevices() and CloudDeviceAuthorizer become available. */
  configureCloud?(config: { cloudUrl: string; accessToken: string }): void;
  /** Apply a Cloud-signed private relay admission token and connect to advertised relay/bootstrap peers. */
  configureRelayReservation?(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void>;
  /** Fetch devices from Cloud directory and persist into local trust store. Returns synced devices. */
  syncCloudDevices?(): Promise<CloudDeviceRecord[]>;
}

export interface DeviceSyncOptions {
  presentedGrant?: DeviceConnectionGrant;
  /** Restrict synchronization to active conversations; undefined syncs all. */
  conversationIds?: string[];
  signal?: AbortSignal;
}

export interface ExchangeVersionFrontierPageResult {
  remotePage: MessageVersionFrontierPage;
  missingForRemote: VersionRange[];
}

export interface AttachmentChunk {
  data: Uint8Array;
  offset: number;
  totalSize: number;
  done: boolean;
  filename: string;
  mimeType: string;
}

export interface DeviceSyncTransport {
  listPeers(): Promise<Device[]>;
  exchangeVersionFrontierPage(
    peerId: string,
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: MessageVersionFrontierCursor | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
    options?: SyncIoOptions,
  ): Promise<ExchangeVersionFrontierPageResult>;
  pullMissingEvents(
    peerId: string,
    conversationId: string,
    ranges: VersionRange[],
    cursor?: ConversationEventCursor,
    options?: SyncIoOptions,
  ): Promise<ConversationEventSyncPage>;
  pullAttachmentChunk(
    peerId: string,
    conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: SyncIoOptions,
  ): Promise<AttachmentChunk | null>;
  pushEvents(peerId: string, events: ConversationEvent[], options?: SyncIoOptions): Promise<void>;
  pushAttachmentChunk(
    peerId: string,
    conversationId: string,
    contentHash: string,
    chunk: AttachmentChunk,
    options?: SyncIoOptions,
  ): Promise<void>;
}

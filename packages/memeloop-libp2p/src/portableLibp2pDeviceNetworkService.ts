import type { Libp2p, Listener, PeerId, PrivateKey, PublicKey, Stream } from '@libp2p/interface';
import { peerIdFromPrivateKey, peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';

import {
  AGENT_DEVICE_RPC_METHODS,
  assertCanonicalConversationEvents,
  attachmentChunkFromWire,
  attachmentChunkToWire,
  buildDeviceBindingMessage,
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  canonicalConversationEventBytes,
  ChatSyncEngine,
  conversationEventAttachmentReferences,
  createDevicePairingInvite,
  createJsonFrameReader,
  DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
  deviceConnectionGrantAllowsRpc,
  encodeJsonFrame,
  encodeJsonFrames,
  hasCanonicalDeviceConnectionGrantClaims,
  hasCanonicalDeviceRelayReservationTokenClaims,
  isAgentDeviceRpcMethod,
  isLibp2pRpcRequest,
  isLibp2pRpcResponse,
  isLibp2pSyncRequest,
  JsonFrameError,
  LIBP2P_RPC_REQUEST_TYPE,
  LIBP2P_RPC_RESPONSE_TYPE,
  LIBP2P_SYNC_RESPONSE_TYPE,
  Libp2pDeviceSyncTransport,
  LocalTrustDeviceAuthorizer,
  MAX_SYNC_ATTACHMENT_BYTES,
  MAX_SYNC_ATTACHMENT_CHUNK_BYTES,
  parseAgentDeviceRpcGrantResources,
  parseDevicePairingInvite,
  PeerNodeSyncAdapter,
  versionVectorKey,
} from 'memeloop/device-network/portable';
import type {
  ConversationEvent,
  ConversationEventCursor,
  ConversationEventPage,
  Device,
  DeviceAccountBindingRequest,
  DeviceAuthorizer,
  DeviceCapabilities,
  DeviceCloudCommitFence,
  DeviceConnectionGrant,
  DeviceConnectionGrantVerificationInput,
  DeviceNetworkListenOptions,
  DeviceNetworkService,
  DeviceOrchestrationStreamHandler,
  DevicePairingInvite,
  DevicePlatform,
  DeviceRelayReservationToken,
  DeviceRelayReservationTokenVerificationInput,
  DeviceRpcHandler,
  DeviceStreamOptions,
  DeviceSyncOptions,
  DeviceTrustStore,
  IAgentStorage,
  Libp2pSyncRequest,
  LocalDeviceIdentity,
  LocalPairingRequestOptions,
  MemeLoopDuplexStream,
  MemeLoopProtocol,
  PairingSession,
  SyncResult,
  TrustedDeviceRecord,
  VersionRange,
} from 'memeloop/device-network/portable';

export {
  buildDeviceBindingMessage,
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  DEVICE_BINDING_SIGNATURE_DOMAIN,
  DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
  DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
  DEVICE_GRANT_MAX_CLOCK_SKEW_MS,
  DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
  DEVICE_RELAY_RESERVATION_TOKEN_MAX_TTL_MS,
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
  syncStorage?: IAgentStorage;
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
  bootstrapMultiaddrs: string[];
  enableCircuitRelay: boolean;
  enableMdns: boolean;
  listen: DeviceNetworkListenOptions;
  privateKey: PrivateKey;
}

export type Libp2pNodeFactory = (options: Libp2pNodeFactoryOptions) => Promise<Libp2p>;

const emptyCapabilities: DeviceCapabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  agentLoop: false,
  imChannels: [],
  wikis: [],
};

const defaultListen: DeviceNetworkListenOptions = {
  addresses: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
};

const PAIRING_PROTOCOL: MemeLoopProtocol = '/memeloop/pairing/2.0.0';
const RPC_PROTOCOL: MemeLoopProtocol = '/memeloop/rpc/2.0.0';
const SYNC_PROTOCOL: MemeLoopProtocol = '/memeloop/sync/2.0.0';
const ORCHESTRATION_PROTOCOL: MemeLoopProtocol = '/memeloop/orchestration/2.0.0';
const RELAY_ADMISSION_PROTOCOL: MemeLoopProtocol = '/memeloop/relay-admission/2.0.0';
export const LIBP2P_DEVICE_NETWORK_FRAME_LIMITS = Object.freeze({
  pairing: Object.freeze({
    maxPayloadBytes: 64 * 1024,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
  }),
  relayAdmission: Object.freeze({
    maxPayloadBytes: 64 * 1024,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
  }),
  rpc: Object.freeze({
    maxPayloadBytes: 16 * 1024 * 1024,
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 30_000,
  }),
  sync: Object.freeze({
    maxPayloadBytes: 16 * 1024 * 1024,
    idleTimeoutMs: 15_000,
    totalTimeoutMs: 120_000,
  }),
});
const PAIRING_SESSION_TTL_MS = 5 * 60_000;
const PAIRING_CLOCK_SKEW_MS = 60_000;
const PAIRING_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.maxPayloadBytes;
const PAIRING_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.idleTimeoutMs;
const PAIRING_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.totalTimeoutMs;
const PAIRING_MAX_PENDING_GLOBAL = 128;
const PAIRING_MAX_PENDING_PER_PEER = 4;
const PAIRING_MAX_SESSION_ID_LENGTH = 512;
const PAIRING_MAX_PEER_ID_LENGTH = 256;
const PAIRING_MAX_PUBLIC_KEY_LENGTH = 4_096;
const PAIRING_MAX_DEVICE_NAME_LENGTH = 256;
const PAIRING_MAX_CAPABILITY_ITEMS = 256;
const PAIRING_MAX_CAPABILITY_STRING_LENGTH = 512;
const PAIRING_MAX_WIKIS = 128;
const PAIRING_MAX_WIKI_TITLE_LENGTH = 512;
const PAIRING_MAX_WIKI_PATH_LENGTH = 2_048;
const PAIRING_MAX_MULTIADDRS = 64;
const PAIRING_MAX_MULTIADDR_LENGTH = 2_048;
const PAIRING_NONCE_PATTERN = /^[\da-f]{32}$/u;
const PAIRING_SESSION_ID_PATTERN = /^[\w.:-]+$/u;
const RELAY_ADMISSION_DIAL_TIMEOUT_MS = PAIRING_IDLE_TIMEOUT_MS;
const RELAY_ADMISSION_DIAL_MAX_ATTEMPTS = 3;
const BOOTSTRAP_DIAL_TIMEOUT_MS = PAIRING_IDLE_TIMEOUT_MS;
const RPC_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.maxPayloadBytes;
const RPC_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.idleTimeoutMs;
const RPC_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.totalTimeoutMs;
const SYNC_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.maxPayloadBytes;
const SYNC_MESSAGE_PAGE_MAX_BYTES = SYNC_MESSAGE_MAX_BYTES - 64 * 1024;
const SYNC_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.idleTimeoutMs;
const SYNC_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.totalTimeoutMs;
export const DEVICE_SYNC_MAX_PASSES = 64;
const RELAY_ADMISSION_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.relayAdmission.maxPayloadBytes;
const RELAY_ADMISSION_REQUEST_TYPE = 'memeloop-relay-admission-request-v2';
const RELAY_ADMISSION_RESPONSE_TYPE = 'memeloop-relay-admission-response-v2';
const RELAY_RESERVATION_MAX_ATTEMPTS = 3;
const RELAY_RESERVATION_RETRY_DELAY_MS = 25;
const CLOUD_DIRECTORY_MAX_ADDRESSES = 64;
const CLOUD_DIRECTORY_MAX_ADDRESS_LENGTH = 2_048;
export const DEFAULT_RELAY_RESERVATION_TTL_MS = 5 * 60_000;
export const DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS = 60_000;
const abortedStreams = new WeakSet<Stream>();

function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('operation_aborted', { cause: signal.reason });
}

function elapsedMilliseconds(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

function linkedTimeoutController(
  externalSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(abortSignalError(externalSignal));
  };
  externalSignal.addEventListener('abort', onAbort, { once: true });
  if (externalSignal.aborted) onAbort();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortSignalError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('operation_failed', { cause: error }));
      },
    );
  });
}

async function abortableDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(abortSignalError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  signal.throwIfAborted();
}

function errorWithDiagnostics(code: string, diagnostics: string[]): Error {
  return new Error(code, {
    cause: new AggregateError(
      diagnostics.map((diagnostic) => new Error(diagnostic)),
      `${code}_diagnostics`,
    ),
  });
}

function abortLibp2pStreamOnce(stream: Stream, error: Error): void {
  if (abortedStreams.has(stream)) return;
  abortedStreams.add(stream);
  stream.abort(error);
}

async function closeLibp2pStreamBestEffort(
  stream: Stream,
  timeoutMs: number,
  timeoutCode: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
  try {
    await stream.close({ signal: controller.signal });
  } catch (error) {
    abortLibp2pStreamOnce(
      stream,
      controller.signal.aborted
        ? new Error(timeoutCode)
        : error instanceof Error
        ? error
        : new Error('stream_close_failed'),
    );
  } finally {
    clearTimeout(timeout);
  }
}

interface PairingDeviceEnvelope {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
}

interface PairingRequestMessage {
  type: 'memeloop-local-pairing-request-v2';
  sessionId: string;
  requestNonce: string;
  createdAt: number;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

interface PairingResponseMessage {
  type: 'memeloop-local-pairing-response-v2';
  sessionId: string;
  requestNonce: string;
  responseNonce: string;
  accepted: true;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

interface PairingAdmission {
  sessionId: string;
  remotePeerId: string;
  requestNonce: string;
  expiresAt: number;
}

interface RelayAdmissionRequestMessage {
  type: typeof RELAY_ADMISSION_REQUEST_TYPE;
  token: DeviceRelayReservationToken;
}

type RelayAdmissionResponseMessage =
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: true; peerId: string; expiresAt: number }
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: false; reason: string };

interface VerifiedRelayReservation {
  token: DeviceRelayReservationToken;
  relayMultiaddrs: string[];
  bootstrapMultiaddrs: string[];
  fence: DeviceCloudCommitFence;
}

interface RelayGenerationEffects {
  bootstrapMultiaddrs: Set<string>;
  relayMultiaddrs: Set<string>;
  listeners: Set<Listener>;
}

function emptyRelayGenerationEffects(): RelayGenerationEffects {
  return {
    bootstrapMultiaddrs: new Set(),
    relayMultiaddrs: new Set(),
    listeners: new Set(),
  };
}

export class PortableLibp2pDeviceNetworkService implements DeviceNetworkService {
  private libp2p?: Libp2p;
  private readonly capabilities: DeviceCapabilities;
  private readonly discoveredDevices = new Map<string, Device>();
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly bootstrapMultiaddrs = new Set<string>();
  private readonly authorizer: DeviceAuthorizer;
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly pairingAdmissions = new Map<string, PairingAdmission>();
  private readonly pairingChallenges = new Map<string, PairingAdmission>();
  private readonly pairingDiscoveredPeerIds = new Set<string>();
  private readonly listeners = new Set<(devices: Device[]) => void>();
  private readonly pairingListeners = new Set<(sessions: PairingSession[]) => void>();
  private readonly cloudDirectoryAddresses = new Map<string, string[]>();
  private verifiedRelayReservation?: VerifiedRelayReservation;
  private relayGenerationEffects: RelayGenerationEffects = emptyRelayGenerationEffects();

  constructor(private readonly options: Libp2pDeviceNetworkServiceOptions) {
    validateRelayReservationVerificationOptions(options.relayReservationVerification);
    this.capabilities = options.capabilities ?? emptyCapabilities;
    for (const record of options.trustedDevices ?? []) {
      this.trustedDevices.set(record.peerId, record);
    }
    for (const address of options.bootstrapMultiaddrs ?? []) {
      const trimmed = address.trim();
      if (trimmed) this.bootstrapMultiaddrs.add(trimmed);
    }
    this.authorizer = options.authorizer ??
      new LocalTrustDeviceAuthorizer({
        getTrustedDevice: (peerId) => this.trustedDevices.get(peerId),
      });
  }

  public async start(): Promise<void> {
    if (this.libp2p) return;
    await this.loadTrustedDevicesFromStore();
    const relayReservation = this.currentVerifiedRelayReservation();
    this.libp2p = await this.createNode(relayReservation);
    this.registerDiscoveryListeners(this.libp2p);
    await this.registerProtocolHandlers(this.libp2p);
    try {
      await this.libp2p.start();
      if (relayReservation) {
        const effects = await this.applyRelayReservation(
          relayReservation,
          relayReservation.fence.signal,
          relayReservation.fence,
        );
        relayReservation.fence.commitSynchronous(() => {
          this.relayGenerationEffects = effects;
        });
      }
    } catch (error) {
      await Promise.resolve(this.libp2p.stop()).catch(() => undefined);
      this.libp2p = undefined;
      throw error;
    }
    this.emitDevices();
  }

  public async stop(): Promise<void> {
    const node = this.libp2p;
    this.libp2p = undefined;
    try {
      if (node) await node.stop();
    } finally {
      const hadPairingSessions = this.pairingSessions.size > 0;
      this.pairingAdmissions.clear();
      this.pairingChallenges.clear();
      this.pairingSessions.clear();
      this.relayGenerationEffects = emptyRelayGenerationEffects();
      this.pairingDiscoveredPeerIds.clear();
      this.discoveredDevices.clear();
      if (hadPairingSessions) this.emitPairingSessions();
      this.emitDevices();
    }
  }

  public async getLocalDevice(): Promise<Device> {
    const node = this.requireNode();
    return {
      peerId: node.peerId.toString(),
      displayName: this.options.identity.deviceName,
      platform: this.options.identity.platform,
      trustMode: 'local-pairing',
      reachability: {
        state: node.status === 'started' ? 'online' : 'offline',
        paths: node.status === 'started' ? ['lan'] : [],
      },
      capabilities: this.capabilities,
      multiaddrs: this.getMultiaddrs(),
      lastSeen: Date.now(),
    };
  }

  public async listDevices(): Promise<Device[]> {
    return this.toVisibleDevices();
  }

  public observeDevices(listener: (devices: Device[]) => void): () => void {
    this.listeners.add(listener);
    void this.listDevices().then(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async listPairingSessions(): Promise<PairingSession[]> {
    this.refreshPairingSessionExpiry();
    return [...this.pairingSessions.values()];
  }

  public observePairingSessions(listener: (sessions: PairingSession[]) => void): () => void {
    this.pairingListeners.add(listener);
    void this.listPairingSessions().then(listener);
    return () => {
      this.pairingListeners.delete(listener);
    };
  }

  public async requestLocalPairing(
    peerId: string,
    options: LocalPairingRequestOptions = {},
  ): Promise<PairingSession> {
    const { signal } = options;
    if (signal?.aborted) throw abortSignalError(signal);
    const requestNonce = randomPairingNonce();
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_SESSION_TTL_MS;
    const request: PairingRequestMessage = {
      type: 'memeloop-local-pairing-request-v2',
      sessionId: `pairing-${createdAt}-${requestNonce}`,
      requestNonce,
      createdAt,
      expiresAt,
      device: this.localPairingDevice(),
    };
    const releaseAdmission = this.claimPairingAdmission({
      sessionId: request.sessionId,
      remotePeerId: peerId,
      requestNonce,
      expiresAt,
    });
    let stream: Stream | undefined;
    let removeAbortListener = (): void => {};
    try {
      stream = await this.requireNode().dialProtocol(
        this.pairingDialTarget(peerId, options),
        PAIRING_PROTOCOL,
        {
          runOnLimitedConnection: true,
          ...(signal ? { signal } : {}),
        },
      );
      if (signal) {
        const onAbort = (): void => {
          if (stream) abortLibp2pStreamOnce(stream, abortSignalError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
        if (signal.aborted) onAbort();
      }
      if (signal?.aborted) throw abortSignalError(signal);
      await writeJsonMessage(stream, request, PAIRING_MESSAGE_MAX_BYTES);
      const response = await readJsonMessage<PairingResponseMessage>(
        stream,
        PAIRING_MESSAGE_MAX_BYTES,
        PAIRING_IDLE_TIMEOUT_MS,
        PAIRING_TOTAL_TIMEOUT_MS,
        signal,
      );
      await stream.close(signal ? { signal } : undefined);
      removeAbortListener();
      if (signal?.aborted) throw abortSignalError(signal);
      const session = await this.sessionFromPairingResponse(peerId, request, response);
      this.requirePairingAdmission(request.sessionId);
      this.pairingSessions.set(session.sessionId, session);
      this.pairingChallenges.set(session.sessionId, {
        sessionId: session.sessionId,
        remotePeerId: session.remotePeerId,
        requestNonce,
        expiresAt: session.expiresAt,
      });
      const remoteDevice = normalizePairingDevice(response.device);
      if (!remoteDevice) throw new Error('invalid_pairing_response');
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, remoteDevice);
      this.emitPairingSessions();
      this.emitDevices();
      return session;
    } catch (error) {
      if (stream) {
        abortLibp2pStreamOnce(
          stream,
          error instanceof Error ? error : new Error('pairing_request_failed'),
        );
      }
      throw error;
    } finally {
      removeAbortListener();
      releaseAdmission();
    }
  }

  public async acceptPairing(sessionId: string): Promise<void> {
    const session = this.requirePairingSession(sessionId);
    if (session.expiresAt <= Date.now()) {
      this.deletePairingSession(sessionId);
      this.emitPairingSessions();
      throw new Error('pairing_session_expired');
    }
    if (session.status !== 'pending') throw new Error('pairing_session_not_pending');
    const trustedDevice: TrustedDeviceRecord = {
      peerId: session.remotePeerId,
      publicKeyMultibase: session.remotePublicKeyMultibase,
      deviceName: session.remoteDeviceName,
      platform: session.remotePlatform,
      trustMode: 'local-pairing',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.trustedDevices.set(session.remotePeerId, trustedDevice);
    await this.options.trustStore?.saveTrustedDevice(trustedDevice);
    session.status = 'accepted';
    this.updateDeviceTrust(session.remotePeerId, 'local-pairing', true);
    this.emitPairingSessions();
    this.emitDevices();
  }

  public async rejectPairing(sessionId: string): Promise<void> {
    this.refreshPairingSessionExpiry();
    const session = this.pairingSessions.get(sessionId);
    if (!session) return;
    session.status = 'rejected';
    this.emitPairingSessions();
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    this.trustedDevices.delete(peerId);
    await this.options.trustStore?.removeTrustedDevice(peerId);
    this.updateDeviceTrust(peerId, 'local-pairing', false);
    this.emitDevices();
  }

  public async openStream(
    peerId: string,
    protocol: MemeLoopProtocol,
    options: DeviceStreamOptions = {},
  ): Promise<MemeLoopDuplexStream> {
    const { presentedGrant, signal } = options;
    signal?.throwIfAborted();
    const authorized = await this.authorizer.canOpenProtocol({
      remotePeerId: peerId,
      protocol,
      direction: 'outbound',
      presentedGrant,
    });
    if (!authorized) throw new Error('device_not_trusted');
    const addresses = this.discoveredDevices.get(peerId)?.multiaddrs ?? [];
    const dialTarget = addresses.length > 0
      ? addresses.map((address) => multiaddr(address))
      : peerIdFromString(peerId);
    const stream = await this.requireNode().dialProtocol(dialTarget, protocol, {
      runOnLimitedConnection: true,
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) {
      abortLibp2pStreamOnce(stream, abortSignalError(signal));
      signal.throwIfAborted();
    }
    return this.wrapStream(stream, signal);
  }

  public async sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    options: DeviceStreamOptions = {},
  ): Promise<T> {
    const { presentedGrant } = options;
    const stream = await this.openStream(peerId, RPC_PROTOCOL, options);
    const request = {
      type: LIBP2P_RPC_REQUEST_TYPE,
      id: crypto.randomUUID(),
      method,
      params: parameters,
      grant: presentedGrant,
    };
    try {
      await writeStreamJson(stream, request);
      const response = await readStreamJson(stream);
      if (!isLibp2pRpcResponse(response)) throw new Error('invalid_rpc_response');
      if (response.id !== request.id) throw new Error('rpc_response_id_mismatch');
      if (!response.ok) throw new Error(response.error.code);
      return response.result as T;
    } catch (error) {
      if (options.signal?.aborted) {
        const abortError = abortSignalError(options.signal);
        await stream.abort(abortError);
        throw abortError;
      }
      if (error instanceof JsonFrameError) await stream.abort(error);
      throw error;
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  public async syncWithDevice(
    peerId: string,
    options: DeviceSyncOptions = {},
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    const externalSignal = options.signal ?? new AbortController().signal;
    externalSignal.throwIfAborted();
    const overall = linkedTimeoutController(
      externalSignal,
      SYNC_TOTAL_TIMEOUT_MS,
      'sync_total_timeout',
    );
    const progress = {
      passes: 0,
      peers: 0,
      frontierPages: 0,
      pages: 0,
      events: 0,
      bytes: 0,
      elapsedMs: 0,
    };
    const { presentedGrant } = options;
    try {
      const authorized = await raceWithAbortSignal(
        this.authorizer.canOpenProtocol({
          remotePeerId: peerId,
          protocol: '/memeloop/sync/2.0.0',
          direction: 'outbound',
          presentedGrant,
        }),
        overall.signal,
      );
      if (!authorized) throw new Error('device_not_trusted');
      externalSignal.throwIfAborted();
      if (!this.options.syncStorage) throw new Error('sync_storage_not_configured');
      const conversationIds = requestedConversationIdsForGrant(
        presentedGrant,
        options.conversationIds,
      );
      // A call owns its engine and AbortSignal. Reusing an in-flight engine across
      // Cloud configuration generations would make the first caller's signal win
      // ChatSyncEngine's pass coalescing and could let stale work outlive its
      // generation. Durable frontiers plus bounded discovery make a fresh engine
      // safe after cancellation or process restart.
      const engine = this.createDeviceSyncEngine(peerId, presentedGrant, conversationIds);
      while (progress.passes < DEVICE_SYNC_MAX_PASSES) {
        externalSignal.throwIfAborted();
        overall.signal.throwIfAborted();
        const pass = await raceWithAbortSignal(
          engine.syncOnce({ signal: overall.signal }),
          overall.signal,
        );
        progress.passes += 1;
        progress.peers += pass.progress.peers;
        progress.frontierPages += pass.progress.frontierPages;
        progress.pages += pass.progress.pages;
        progress.events += pass.progress.events;
        progress.bytes += pass.progress.bytes;
        if (pass.complete) {
          progress.elapsedMs = elapsedMilliseconds(startedAt);
          return {
            ok: true,
            peerId,
            syncedAt: Date.now(),
            complete: true,
            progress,
          };
        }
        if (!pass.continuation) throw new Error(`event_sync_incomplete:${peerId}`);
      }
      progress.elapsedMs = elapsedMilliseconds(startedAt);
      return {
        ok: true,
        peerId,
        syncedAt: Date.now(),
        complete: false,
        progress,
        continuation: {
          reason: 'pass-limit',
          resumeFrom: 'durable-frontier',
        },
      };
    } catch (error) {
      externalSignal.throwIfAborted();
      if (overall.signal.aborted) {
        progress.elapsedMs = elapsedMilliseconds(startedAt);
        return {
          ok: true,
          peerId,
          syncedAt: Date.now(),
          complete: false,
          progress,
          continuation: {
            reason: 'time-limit',
            resumeFrom: 'durable-frontier',
          },
        };
      }
      throw error;
    } finally {
      overall.dispose();
    }
  }

  protected createDeviceSyncEngine(
    peerId: string,
    presentedGrant: DeviceConnectionGrant | undefined,
    conversationIds: string[] | undefined,
  ): ChatSyncEngine {
    if (!this.options.syncStorage) throw new Error('sync_storage_not_configured');
    const transport = new Libp2pDeviceSyncTransport({
      nodeId: this.options.identity.peerId,
      deviceNetwork: this,
      grantProvider: async (remotePeerId) => remotePeerId === peerId ? presentedGrant : undefined,
    });
    const peer = new PeerNodeSyncAdapter(peerId, transport);
    return new ChatSyncEngine({
      nodeId: this.options.identity.peerId,
      storage: this.options.syncStorage,
      peers: () => [peer],
      failOnMessageSyncError: true,
      conversationIds,
    });
  }

  public getTrustedDevice(peerId: string): TrustedDeviceRecord | undefined {
    return this.trustedDevices.get(peerId);
  }

  public upsertTrustedDevice(record: TrustedDeviceRecord): void {
    this.trustedDevices.set(record.peerId, record);
    this.updateDeviceTrust(record.peerId, record.trustMode, true);
    this.emitDevices();
  }

  public upsertDiscoveredDevice(device: Device): void {
    const multiaddrs = strictPeerBoundMultiaddrs(device.peerId, device.multiaddrs ?? []);
    const trustedRecord = this.trustedDevices.get(device.peerId);
    this.discoveredDevices.set(device.peerId, {
      ...device,
      multiaddrs,
      displayName: trustedRecord?.deviceName ?? device.displayName,
      platform: trustedRecord?.platform ?? device.platform,
      trustMode: trustedRecord?.trustMode ?? device.trustMode,
      trusted: device.trusted ?? trustedRecord !== undefined,
      lastSeen: device.lastSeen ?? trustedRecord?.lastSeen,
    });
    this.emitDevices();
  }

  /** Portable Cloud live-directory capability consumed by the shared Core adapter. */
  public listCloudDeviceAddressPeerIds(): string[] {
    return [...this.cloudDirectoryAddresses.keys()];
  }

  /**
   * Store only addresses cryptographically attributable to the advertised
   * target PeerId. openStream dials this trusted multiaddr list directly, so
   * browser hosts do not depend on mDNS, a DHT, or a pre-populated peerStore.
   */
  public setCloudDeviceAddresses(peerId: string, addresses: readonly string[]): void {
    const multiaddrs = strictPeerBoundMultiaddrs(peerId, addresses);
    this.cloudDirectoryAddresses.set(peerId, multiaddrs);
    const current = this.discoveredDevices.get(peerId);
    if (current) this.discoveredDevices.set(peerId, { ...current, multiaddrs });
  }

  public removeCloudDeviceAddresses(peerId: string): void {
    this.cloudDirectoryAddresses.delete(peerId);
    const current = this.discoveredDevices.get(peerId);
    if (current?.trustMode === 'cloud-account') {
      this.discoveredDevices.set(peerId, { ...current, multiaddrs: [] });
    }
  }

  public upsertCloudDiscoveredDevice(device: Device): void {
    const multiaddrs = this.cloudDirectoryAddresses.get(device.peerId) ??
      strictPeerBoundMultiaddrs(device.peerId, device.multiaddrs ?? []);
    this.upsertDiscoveredDevice({ ...device, multiaddrs });
  }

  public removeCloudDiscoveredDevice(peerId: string): void {
    if (this.discoveredDevices.get(peerId)?.trustMode === 'cloud-account') {
      this.discoveredDevices.delete(peerId);
      this.emitDevices();
    }
  }

  public upsertCloudTrustedDevice(record: TrustedDeviceRecord): void {
    if (record.trustMode !== 'cloud-account') throw new Error('invalid_cloud_trust_record');
    this.upsertTrustedDevice(record);
  }

  public async removeCloudTrustedDevice(peerId: string): Promise<void> {
    if (this.trustedDevices.get(peerId)?.trustMode !== 'cloud-account') return;
    this.trustedDevices.delete(peerId);
    await this.options.trustStore?.removeTrustedDevice(peerId);
    this.updateDeviceTrust(peerId, 'cloud-account', false);
    this.emitDevices();
  }

  public async configureRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void> {
    if (signal !== fence.signal) throw new TypeError('relay_generation_signal_mismatch');
    signal.throwIfAborted();
    fence.throwIfStale();
    const verified = await this.verifyRelayReservation(token, signal, fence);
    signal.throwIfAborted();
    fence.throwIfStale();

    const previousEffects = this.relayGenerationEffects;
    fence.commitSynchronous(() => {
      this.verifiedRelayReservation = undefined;
      this.relayGenerationEffects = emptyRelayGenerationEffects();
    });
    // Rollback must finish even if this generation is cancelled while the
    // old listeners are closing. The coordinator serializes generations, so
    // the next generation cannot install replacements until this settles.
    await this.cleanupRelayGenerationEffects(previousEffects, new AbortController().signal);
    signal.throwIfAborted();
    fence.throwIfStale();

    let effects = emptyRelayGenerationEffects();
    try {
      if (this.libp2p) effects = await this.applyRelayReservation(verified, signal, fence);
      signal.throwIfAborted();
      fence.throwIfStale();
      const committed = fence.commitSynchronous(() => {
        // Cache only after verification and every external side effect have
        // completed under the same current generation.
        this.verifiedRelayReservation = verified;
        this.relayGenerationEffects = effects;
      });
      if (!committed) fence.throwIfStale();
    } catch (error) {
      await this.cleanupRelayGenerationEffects(effects, new AbortController().signal);
      throw error;
    }
  }

  /** Forget generation-owned relay credentials before the host tears down its listeners. */
  public async clearRelayReservation(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const effects = this.relayGenerationEffects;
    this.verifiedRelayReservation = undefined;
    this.relayGenerationEffects = emptyRelayGenerationEffects();
    await this.cleanupRelayGenerationEffects(
      effects,
      signal ?? new AbortController().signal,
    );
    signal?.throwIfAborted();
  }

  private async applyRelayReservation(
    verified: VerifiedRelayReservation,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<RelayGenerationEffects> {
    const effects = emptyRelayGenerationEffects();
    for (const address of verified.relayMultiaddrs) effects.relayMultiaddrs.add(address);
    try {
      signal.throwIfAborted();
      fence.throwIfStale();
      this.assertRelayReservationLifetime(verified.token);
      await this.admitRelayReservation(verified.token, signal, fence);
      signal.throwIfAborted();
      fence.throwIfStale();
      await this.reserveRelayListeners(verified.relayMultiaddrs, signal, fence, effects);
      const relayAddressSet = new Set(verified.relayMultiaddrs);
      await this.dialBootstrapPeers(
        verified.bootstrapMultiaddrs.filter((address) => !relayAddressSet.has(address)),
        signal,
        fence,
        effects,
      );
      signal.throwIfAborted();
      fence.throwIfStale();
      return effects;
    } catch (error) {
      await this.cleanupRelayGenerationEffects(effects, new AbortController().signal);
      throw error;
    }
  }

  public getMultiaddrs(): string[] {
    return this.libp2p?.getMultiaddrs().map((address) => address.toString()) ?? [];
  }

  private async createNode(
    relayReservation?: VerifiedRelayReservation,
  ): Promise<Libp2p> {
    const privateKey = await privateKeyFromIdentity(this.options.identity);
    const listen = this.options.listen ?? defaultListen;
    return await this.options.nodeFactory({
      privateKey,
      listen,
      bootstrapMultiaddrs: [
        ...new Set([
          ...this.bootstrapMultiaddrs,
          ...(relayReservation?.bootstrapMultiaddrs ?? []),
          ...(relayReservation?.relayMultiaddrs ?? []),
        ]),
      ],
      enableCircuitRelay: this.options.enableCircuitRelay !== false,
      enableMdns: this.options.enableMdns !== false,
    });
  }

  private async verifyRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<VerifiedRelayReservation> {
    signal.throwIfAborted();
    fence.throwIfStale();
    const verification = this.options.relayReservationVerification;
    if (!verification) throw new Error('relay_admission_verification_key_unavailable');
    const verificationPublicKeyMultibase = verification.getVerificationPublicKeyMultibase()?.trim();
    if (!verificationPublicKeyMultibase) {
      throw new Error('relay_admission_verification_key_unavailable');
    }
    const now = verification.now?.() ?? Date.now();
    const reservationTtlMs = verification.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      !relayTokenCoversReservation(
        token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) {
      throw new Error('relay_reservation_token_ttl_insufficient');
    }
    if (
      !(await verifyDeviceRelayReservationToken({
        token,
        verificationPublicKeyMultibase,
        peerId: this.options.identity.peerId,
        now,
      }))
    ) {
      throw new Error('invalid_relay_reservation_token');
    }
    signal.throwIfAborted();
    fence.throwIfStale();
    if (!relayTokenAudiencePeerId(token.relayMultiaddrs)) {
      throw new Error('relay_reservation_token_audience_invalid');
    }
    const bootstrapMultiaddrs = strictMultiaddrs(token.bootstrapMultiaddrs);
    if (!bootstrapMultiaddrs) throw new Error('relay_reservation_token_audience_invalid');
    return {
      token,
      relayMultiaddrs: [...token.relayMultiaddrs],
      bootstrapMultiaddrs,
      fence,
    };
  }

  private currentVerifiedRelayReservation(): VerifiedRelayReservation | undefined {
    const verified = this.verifiedRelayReservation;
    if (!verified) return undefined;
    if (!verified.fence.isCurrent() || verified.fence.signal.aborted) {
      this.verifiedRelayReservation = undefined;
      return undefined;
    }
    const verification = this.options.relayReservationVerification;
    const now = verification?.now?.() ?? Date.now();
    const reservationTtlMs = verification?.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification?.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      relayTokenCoversReservation(
        verified.token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) return verified;
    this.verifiedRelayReservation = undefined;
    return undefined;
  }

  private assertRelayReservationLifetime(token: DeviceRelayReservationToken): void {
    const verification = this.options.relayReservationVerification;
    const now = verification?.now?.() ?? Date.now();
    const reservationTtlMs = verification?.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification?.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      !relayTokenCoversReservation(
        token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) {
      if (this.verifiedRelayReservation?.token === token) {
        this.verifiedRelayReservation = undefined;
      }
      throw new Error('relay_reservation_token_ttl_insufficient');
    }
  }

  private async dialBootstrapPeers(
    addresses: string[],
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
    effects: RelayGenerationEffects,
  ): Promise<void> {
    const node = this.requireNode();
    for (const address of addresses) {
      signal.throwIfAborted();
      fence.throwIfStale();
      const controller = linkedTimeoutController(
        signal,
        BOOTSTRAP_DIAL_TIMEOUT_MS,
        'bootstrap_dial_timeout',
      );
      try {
        await node.dial(multiaddr(address), { signal: controller.signal });
        effects.bootstrapMultiaddrs.add(address);
        signal.throwIfAborted();
        fence.throwIfStale();
      } catch (error) {
        signal.throwIfAborted();
        fence.throwIfStale();
        // Bootstrap improves reachability but is not required once relay
        // admission/listening succeeded.
        void error;
      } finally {
        controller.dispose();
      }
    }
  }

  private async admitRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void> {
    const relayAddresses = token.relayMultiaddrs
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (relayAddresses.length === 0) return;
    const node = this.requireNode();
    const errors: string[] = [];
    for (const address of relayAddresses) {
      signal.throwIfAborted();
      fence.throwIfStale();
      let stream: Stream | undefined;
      const onAbort = (): void => {
        if (stream) abortLibp2pStreamOnce(stream, abortSignalError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        stream = await dialRelayAdmissionStream(node, address, signal, fence);
        signal.throwIfAborted();
        fence.throwIfStale();
        const request: RelayAdmissionRequestMessage = {
          type: RELAY_ADMISSION_REQUEST_TYPE,
          token,
        };
        await writeJsonMessage(stream, request, RELAY_ADMISSION_MESSAGE_MAX_BYTES);
        signal.throwIfAborted();
        fence.throwIfStale();
        const response = await readJsonMessage<RelayAdmissionResponseMessage>(
          stream,
          RELAY_ADMISSION_MESSAGE_MAX_BYTES,
          PAIRING_IDLE_TIMEOUT_MS,
          PAIRING_TOTAL_TIMEOUT_MS,
        );
        signal.throwIfAborted();
        fence.throwIfStale();
        await closeLibp2pStreamBestEffort(
          stream,
          PAIRING_IDLE_TIMEOUT_MS,
          'relay_admission_close_timeout',
        );
        signal.throwIfAborted();
        fence.throwIfStale();
        if (
          isRelayAdmissionResponse(response) &&
          response.ok &&
          response.peerId === token.peerId &&
          response.expiresAt === token.expiresAt
        ) return;
        const reason = isRelayAdmissionResponse(response) && !response.ok
          ? response.reason
          : 'invalid_relay_admission_response';
        errors.push(`${address}: ${reason}`);
      } catch (error) {
        if (stream) {
          abortLibp2pStreamOnce(
            stream,
            error instanceof Error ? error : new Error('relay_admission_failed'),
          );
        }
        errors.push(
          `${address}: ${error instanceof Error ? error.message : 'relay_admission_failed'}`,
        );
        signal.throwIfAborted();
        fence.throwIfStale();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    throw errorWithDiagnostics('relay_admission_failed', errors);
  }

  private async reserveRelayListeners(
    relayMultiaddrs: string[],
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
    effects: RelayGenerationEffects,
  ): Promise<void> {
    const relayAddresses = relayMultiaddrs
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (relayAddresses.length === 0) return;
    const transportManager = (this.requireNode() as unknown as Libp2pWithTransportManager)
      .components?.transportManager;
    if (!transportManager) throw new Error('relay_transport_manager_unavailable');
    const errors: string[] = [];
    for (const address of relayAddresses) {
      for (let attempt = 1; attempt <= RELAY_RESERVATION_MAX_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        fence.throwIfStale();
        const listenersBefore = new Set(transportManager.getListeners());
        try {
          await transportManager.listen([relayCircuitMultiaddr(address)]);
          for (const listener of transportManager.getListeners()) {
            if (!listenersBefore.has(listener)) effects.listeners.add(listener);
          }
          signal.throwIfAborted();
          fence.throwIfStale();
          return;
        } catch (error) {
          for (const listener of transportManager.getListeners()) {
            if (!listenersBefore.has(listener)) effects.listeners.add(listener);
          }
          signal.throwIfAborted();
          fence.throwIfStale();
          errors.push(
            `${address} (attempt ${attempt}/${RELAY_RESERVATION_MAX_ATTEMPTS}): ${error instanceof Error ? error.message : 'relay_reservation_failed'}`,
          );
          if (attempt < RELAY_RESERVATION_MAX_ATTEMPTS) {
            await abortableDelay(
              RELAY_RESERVATION_RETRY_DELAY_MS * attempt,
              signal,
            );
            fence.throwIfStale();
          }
        }
      }
    }
    throw errorWithDiagnostics('relay_reservation_failed', errors);
  }

  private async cleanupRelayGenerationEffects(
    effects: RelayGenerationEffects,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const node = this.libp2p;
    const transportManager = (node as unknown as Libp2pWithTransportManager | undefined)
      ?.components?.transportManager;
    const relayListenerAddresses = new Set(
      [...effects.relayMultiaddrs].map((address) => relayCircuitMultiaddr(address).toString()),
    );
    const listeners = new Set(effects.listeners);
    for (const listener of transportManager?.getListeners() ?? []) {
      if (
        listener.getAddrs().some((address) => relayListenerAddresses.has(address.toString()))
      ) listeners.add(listener);
    }
    for (const listener of listeners) {
      signal.throwIfAborted();
      await listener.close().catch(() => undefined);
      signal.throwIfAborted();
    }
    if (!node) return;
    for (
      const address of new Set([
        ...effects.relayMultiaddrs,
        ...effects.bootstrapMultiaddrs,
      ])
    ) {
      signal.throwIfAborted();
      await node.hangUp(multiaddr(address), { signal }).catch(() => undefined);
      signal.throwIfAborted();
    }
  }

  private async loadTrustedDevicesFromStore(): Promise<void> {
    const records = await this.options.trustStore?.loadTrustedDevices();
    for (const record of records ?? []) {
      this.trustedDevices.set(record.peerId, record);
    }
  }

  private registerDiscoveryListeners(node: Libp2p): void {
    node.addEventListener('peer:discovery', (event) => {
      const detail = event.detail;
      const peerId = detail.id.toString();
      const trustedRecord = this.trustedDevices.get(peerId);
      this.discoveredDevices.set(peerId, {
        peerId,
        displayName: trustedRecord?.deviceName ?? peerId,
        platform: trustedRecord?.platform ?? 'cli',
        trustMode: trustedRecord?.trustMode ?? 'local-pairing',
        trusted: trustedRecord !== undefined,
        reachability: {
          state: 'nearby',
          paths: ['lan'],
        },
        capabilities: emptyCapabilities,
        multiaddrs: detail.multiaddrs.map((address) => address.toString()),
        lastSeen: Date.now(),
      });
      this.emitDevices();
      if (this.options.autoDialDiscoveredPeers === true && detail.multiaddrs.length > 0) {
        void node.dial(detail.multiaddrs).catch(() => undefined);
      }
    });
    node.addEventListener('peer:connect', (event) => {
      this.markPeerOnline(event.detail);
    });
    node.addEventListener('peer:disconnect', (event) => {
      this.markPeerOffline(event.detail);
    });
  }

  private async registerProtocolHandlers(node: Libp2p): Promise<void> {
    const protocols: MemeLoopProtocol[] = [
      PAIRING_PROTOCOL,
      RPC_PROTOCOL,
      SYNC_PROTOCOL,
      ORCHESTRATION_PROTOCOL,
    ];
    await node.handle(
      protocols,
      async (stream, connection) => {
        const remotePeerId = connection.remotePeer.toString();
        if (stream.protocol === PAIRING_PROTOCOL) {
          if (
            !(await this.authorizer.canOpenProtocol({
              remotePeerId,
              protocol: PAIRING_PROTOCOL,
              direction: 'inbound',
            }))
          ) {
            abortLibp2pStreamOnce(stream, new Error('device_not_trusted'));
            return;
          }
          await this.handlePairingStream(stream, remotePeerId).catch((error: unknown) => {
            abortLibp2pStreamOnce(
              stream,
              error instanceof Error ? error : new Error('pairing_handler_failed'),
            );
          });
          return;
        }
        if (stream.protocol === SYNC_PROTOCOL) {
          await this.handleSyncStream(stream, remotePeerId);
          return;
        }
        if (stream.protocol === RPC_PROTOCOL) {
          await this.handleRpcStream(stream, remotePeerId);
          return;
        }
        if (stream.protocol === ORCHESTRATION_PROTOCOL) {
          if (!this.options.orchestrationHandler) {
            abortLibp2pStreamOnce(stream, new Error('orchestration_handler_not_configured'));
            return;
          }
          await this.options
            .orchestrationHandler({
              remotePeerId,
              stream: this.wrapStream(stream),
              authorize: (presentedGrant: DeviceConnectionGrant | undefined) =>
                this.authorizer.canOpenProtocol({
                  remotePeerId,
                  protocol: ORCHESTRATION_PROTOCOL,
                  direction: 'inbound',
                  presentedGrant,
                }),
            })
            .catch((error: unknown) => {
              abortLibp2pStreamOnce(
                stream,
                error instanceof Error ? error : new Error('orchestration_handler_failed'),
              );
            });
          return;
        }
        if (
          !(await this.authorizer.canOpenProtocol({
            remotePeerId,
            protocol: stream.protocol as MemeLoopProtocol,
            direction: 'inbound',
          }))
        ) {
          abortLibp2pStreamOnce(stream, new Error('device_not_trusted'));
          return;
        }
        abortLibp2pStreamOnce(stream, new Error('protocol_handler_not_registered'));
      },
      {
        runOnLimitedConnection: true,
      },
    );
  }

  private async handleRpcStream(stream: Stream, remotePeerId: string): Promise<void> {
    const requestAbort = new AbortController();
    let responseFinished = false;
    const onStreamClose = (event: Event): void => {
      if (responseFinished || requestAbort.signal.aborted) return;
      const closeEvent = event as Event & { error?: Error };
      requestAbort.abort(closeEvent.error ?? new Error('rpc_stream_closed'));
    };
    stream.addEventListener?.('close', onStreamClose, { once: true });
    let requestId = 'unknown';
    try {
      // Cloud authorization needs request.grant, which v2 carries inside this bounded frame.
      const request = await readJsonMessage<unknown>(
        stream,
        RPC_MESSAGE_MAX_BYTES,
        RPC_IDLE_TIMEOUT_MS,
        RPC_TOTAL_TIMEOUT_MS,
      );
      requestAbort.signal.throwIfAborted();
      if (!isLibp2pRpcRequest(request)) throw new Error('invalid_rpc_request');
      requestId = request.id;
      const authorized = await this.authorizer.canOpenProtocol({
        remotePeerId,
        protocol: RPC_PROTOCOL,
        direction: 'inbound',
        presentedGrant: request.grant,
      });
      if (!authorized) throw new Error('device_not_trusted');
      const grantResources = await rpcGrantResources({
        method: request.method,
        parameters: request.params,
        remotePeerId,
        presentedGrant: request.grant,
        resolveRunGrantResources: this.options.resolveRunGrantResources,
      });
      if (request.grant) {
        if (
          grantResources.requiresAllConversations &&
          request.grant.conversationScope.mode !== 'all'
        ) throw new Error('device_grant_rpc_scope_violation');
        if (
          grantResources.requiresAllDefinitions &&
          request.grant.definitionScope.mode !== 'all'
        ) throw new Error('device_grant_rpc_scope_violation');
        if (
          !deviceConnectionGrantAllowsRpc(request.grant, {
            method: request.method,
            ...(grantResources.conversationId
              ? { conversationId: grantResources.conversationId }
              : {}),
            ...(grantResources.definitionId ? { definitionId: grantResources.definitionId } : {}),
          })
        ) throw new Error('device_grant_rpc_scope_violation');
      }
      if (!this.options.rpcHandler) throw new Error('rpc_handler_not_configured');
      const result = await this.options.rpcHandler({
        remotePeerId,
        method: request.method,
        parameters: request.params,
        presentedGrant: request.grant,
        signal: requestAbort.signal,
      });
      requestAbort.signal.throwIfAborted();
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_RPC_RESPONSE_TYPE,
          id: request.id,
          ok: true,
          result,
        },
        RPC_MESSAGE_MAX_BYTES,
      );
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        await writeJsonMessage(
          stream,
          {
            type: LIBP2P_RPC_RESPONSE_TYPE,
            id: requestId,
            ok: false,
            error: { code: rpcErrorCode(error) },
          },
          RPC_MESSAGE_MAX_BYTES,
        ).catch(() => undefined);
      }
    } finally {
      responseFinished = true;
      stream.removeEventListener?.('close', onStreamClose);
      await stream.close().catch(() => undefined);
    }
  }

  private async handleSyncStream(stream: Stream, remotePeerId: string): Promise<void> {
    const requestAbort = new AbortController();
    let responseFinished = false;
    const onStreamClose = (event: Event): void => {
      if (responseFinished || requestAbort.signal.aborted) return;
      const closeEvent = event as Event & { error?: Error };
      requestAbort.abort(closeEvent.error ?? new Error('sync_stream_closed'));
    };
    stream.addEventListener?.('close', onStreamClose, { once: true });
    let requestId = 'unknown';
    try {
      // Cloud authorization needs request.grant, which v2 carries inside this bounded frame.
      const request = await readJsonMessage<unknown>(
        stream,
        SYNC_MESSAGE_MAX_BYTES,
        SYNC_IDLE_TIMEOUT_MS,
        SYNC_TOTAL_TIMEOUT_MS,
      );
      requestAbort.signal.throwIfAborted();
      if (!isLibp2pSyncRequest(request)) throw new Error('invalid_sync_request');
      requestId = request.id;
      const authorized = await this.authorizer.canOpenProtocol({
        remotePeerId,
        protocol: SYNC_PROTOCOL,
        direction: 'inbound',
        presentedGrant: request.grant,
      });
      if (!authorized) throw new Error('device_not_trusted');
      const result = await this.handleSyncRequest(request, requestAbort.signal);
      requestAbort.signal.throwIfAborted();
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_SYNC_RESPONSE_TYPE,
          id: request.id,
          ok: true,
          result,
        },
        SYNC_MESSAGE_MAX_BYTES,
      );
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        await writeJsonMessage(
          stream,
          {
            type: LIBP2P_SYNC_RESPONSE_TYPE,
            id: requestId,
            ok: false,
            error: { code: syncErrorCode(error) },
          },
          SYNC_MESSAGE_MAX_BYTES,
        ).catch(() => undefined);
      }
    } finally {
      responseFinished = true;
      stream.removeEventListener?.('close', onStreamClose);
      await stream.close().catch(() => undefined);
    }
  }

  private async handleSyncRequest(
    request: Libp2pSyncRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestSignal = signal ?? new AbortController().signal;
    requestSignal.throwIfAborted();
    const storage = this.options.syncStorage;
    if (!storage) throw new Error('sync_storage_not_configured');
    switch (request.method) {
      case 'exchangeVersionFrontierPage': {
        const parameters = objectParameter(request.params);
        assertOnlyParameterKeys(parameters, [
          'localFrontiers',
          'remoteAfter',
          'includeRemotePage',
          'conversationIds',
        ]);
        const conversationIds = conversationIdsForGrant(
          request.grant,
          conversationIdsParameter(request.params),
        );
        const localFrontiers = versionFrontierArrayParameter(parameters, 'localFrontiers');
        if (conversationIds && localFrontiers.some(frontier => !conversationIds.has(frontier.conversationId))) {
          throw new Error('device_grant_conversation_scope_violation');
        }
        const remoteAfter = versionFrontierCursorParameter(parameters, 'remoteAfter');
        const includeRemotePage = booleanParameter(parameters, 'includeRemotePage');
        if (!storage.getEventVersionFrontierPage || !storage.getEventVersionFrontiersForKeys) {
          throw new Error('sync_event_frontier_store_not_configured');
        }
        const remoteForLocal = signal
          ? await storage.getEventVersionFrontiersForKeys(localFrontiers, { signal })
          : await storage.getEventVersionFrontiersForKeys(localFrontiers);
        requestSignal.throwIfAborted();
        const remoteByKey = new Map(remoteForLocal.map(frontier => [
          versionVectorKey(frontier.conversationId, frontier.originNodeId),
          frontier.maxContiguousOriginSequence,
        ]));
        const missingForRemote = localFrontiers.flatMap(frontier => {
          const current = remoteByKey.get(versionVectorKey(
            frontier.conversationId,
            frontier.originNodeId,
          )) ?? 0;
          return frontier.maxContiguousOriginSequence > current
            ? [{
              conversationId: frontier.conversationId,
              originNodeId: frontier.originNodeId,
              fromExclusive: current,
              toInclusive: frontier.maxContiguousOriginSequence,
            }]
            : [];
        });
        const remotePage = includeRemotePage
          ? await storage.getEventVersionFrontierPage({
            limit: 128,
            ...(remoteAfter ? { after: remoteAfter } : {}),
            ...(conversationIds ? { conversationIds: [...conversationIds] } : {}),
            ...(signal ? { signal } : {}),
          })
          : { items: [] };
        assertValidStoredFrontierPage(remotePage, remoteAfter, includeRemotePage);
        return {
          remotePage,
          missingForRemote,
        };
      }
      case 'pullMissingEvents': {
        const parameters = objectParameter(request.params);
        assertOnlyParameterKeys(parameters, ['conversationId', 'ranges', 'cursor']);
        const conversationId = stringParameter(parameters, 'conversationId');
        conversationIdsForGrant(request.grant, new Set([conversationId]));
        const ranges = versionRangeArrayParameter(parameters, 'ranges');
        if (ranges.some(range => range.conversationId !== conversationId)) {
          throw new Error('invalid_sync_range_conversation');
        }
        const cursor = eventCursorParameter(parameters, 'cursor');
        if (!storage.getConversationEventPage) throw new Error('sync_event_store_not_configured');
        const page = await storage.getConversationEventPage(conversationId, {
          limit: 128,
          after: cursor,
          direction: 'forward',
          ranges,
          ...(signal ? { signal } : {}),
        });
        requestSignal.throwIfAborted();
        return boundedEventSyncPage(page, ranges, cursor);
      }
      case 'pullAttachmentChunk': {
        const parameters = objectParameter(request.params);
        assertOnlyParameterKeys(parameters, [
          'conversationId',
          'contentHash',
          'offset',
          'maxBytes',
        ]);
        const conversationId = stringParameter(parameters, 'conversationId');
        conversationIdsForGrant(request.grant, new Set([conversationId]));
        const contentHash = stringParameter(parameters, 'contentHash');
        const offset = nonNegativeIntegerParameter(parameters, 'offset');
        const maxBytes = positiveIntegerParameter(parameters, 'maxBytes');
        if (maxBytes > MAX_SYNC_ATTACHMENT_CHUNK_BYTES) {
          throw new Error('invalid_sync_attachment_chunk');
        }
        const referenced = signal
          ? await storage.conversationReferencesAttachment(conversationId, contentHash, { signal })
          : await storage.conversationReferencesAttachment(conversationId, contentHash);
        if (!referenced) {
          throw new Error('sync_attachment_not_referenced');
        }
        const reference = signal
          ? await storage.getAttachment(contentHash, { signal })
          : await storage.getAttachment(contentHash);
        if (
          !reference || reference.size > MAX_SYNC_ATTACHMENT_BYTES || offset > reference.size ||
          !storage.readAttachmentRange || !storage.verifyAttachment
        ) {
          throw new Error('sync_attachment_unavailable');
        }
        const verified = offset !== 0 || (signal
          ? await storage.verifyAttachment(contentHash, { signal })
          : await storage.verifyAttachment(contentHash));
        if (!verified) {
          throw new Error('sync_attachment_corrupt');
        }
        const data = signal
          ? await storage.readAttachmentRange(contentHash, offset, maxBytes, { signal })
          : await storage.readAttachmentRange(contentHash, offset, maxBytes);
        if (
          !data || data.byteLength > maxBytes ||
          (data.byteLength === 0 && offset !== reference.size)
        ) {
          throw new Error('sync_attachment_read_failed');
        }
        return attachmentChunkToWire({
          data,
          offset,
          totalSize: reference.size,
          done: offset + data.byteLength === reference.size,
          filename: reference.filename,
          mimeType: reference.mimeType,
        });
      }
      case 'pushAttachmentChunk': {
        const parameters = objectParameter(request.params);
        assertOnlyParameterKeys(parameters, ['conversationId', 'contentHash', 'chunk']);
        const conversationId = stringParameter(parameters, 'conversationId');
        conversationIdsForGrant(request.grant, new Set([conversationId]));
        const contentHash = stringParameter(parameters, 'contentHash');
        const chunk = await attachmentChunkFromWire(parameters.chunk);
        if (
          !chunk || !/^sha256:[\da-f]{64}$/iu.test(contentHash) ||
          !storage.stageAttachmentChunk || !storage.commitStagedAttachment
        ) {
          throw new Error('invalid_sync_attachment_chunk');
        }
        const reference = {
          contentHash,
          filename: chunk.filename,
          mimeType: chunk.mimeType,
          size: chunk.totalSize,
        };
        const nextOffset = signal
          ? await storage.stageAttachmentChunk(reference, chunk.offset, chunk.data, { signal })
          : await storage.stageAttachmentChunk(reference, chunk.offset, chunk.data);
        if (nextOffset !== chunk.offset + chunk.data.byteLength) {
          throw new Error('sync_attachment_cursor_mismatch');
        }
        if (chunk.done) {
          if (signal) await storage.commitStagedAttachment(contentHash, { signal });
          else await storage.commitStagedAttachment(contentHash);
        }
        return { nextOffset, complete: chunk.done };
      }
      case 'pushEvents': {
        const parameters = objectParameter(request.params);
        assertOnlyParameterKeys(parameters, ['events']);
        const events = canonicalEventBatchParameter(parameters.events);
        conversationIdsForGrant(
          request.grant,
          new Set(events.map(event => event.conversationId)),
        );
        for (const event of events) {
          for (const attachment of conversationEventAttachmentReferences(event)) {
            const reference = signal
              ? await storage.getAttachment(attachment.contentHash, { signal })
              : await storage.getAttachment(attachment.contentHash);
            if (
              !reference ||
              reference.size !== attachment.size ||
              reference.filename !== attachment.filename ||
              reference.mimeType !== attachment.mimeType ||
              !storage.verifyAttachment
            ) {
              throw new Error('sync_attachment_missing');
            }
            const verified = signal
              ? await storage.verifyAttachment(attachment.contentHash, { signal })
              : await storage.verifyAttachment(attachment.contentHash);
            if (!verified) throw new Error('sync_attachment_missing');
          }
        }
        if (!storage.insertEventsIfAbsent) throw new Error('sync_event_store_not_configured');
        requestSignal.throwIfAborted();
        await storage.insertEventsIfAbsent(events);
        requestSignal.throwIfAborted();
        return { accepted: events.length };
      }
    }
    throw new Error('unsupported_sync_method');
  }

  private pairingDialTarget(
    peerId: string,
    options: LocalPairingRequestOptions,
  ): PeerId | ReturnType<typeof multiaddr>[] {
    const addresses = options.multiaddrs ?? this.discoveredDevices.get(peerId)?.multiaddrs ?? [];
    if (addresses.length === 0) return peerIdFromString(peerId);
    return strictPairingMultiaddrs(peerId, addresses).map((address) => multiaddr(address));
  }

  private localPairingDevice(): PairingDeviceEnvelope {
    const device = normalizePairingDevice({
      peerId: this.options.identity.peerId,
      publicKeyMultibase: this.options.identity.publicKeyMultibase,
      deviceName: this.options.identity.deviceName,
      platform: this.options.identity.platform,
      capabilities: this.capabilities,
      multiaddrs: this.getMultiaddrs(),
    });
    if (!device) throw new Error('invalid_local_pairing_device');
    return device;
  }

  private async handlePairingStream(stream: Stream, remotePeerId: string): Promise<void> {
    let releaseAdmission = (): void => {};
    try {
      const rawRequest = await readJsonMessage<unknown>(
        stream,
        PAIRING_MESSAGE_MAX_BYTES,
        PAIRING_IDLE_TIMEOUT_MS,
        PAIRING_TOTAL_TIMEOUT_MS,
      );
      const now = Date.now();
      if (!isPairingRequest(rawRequest, now)) throw new Error('invalid_pairing_request');
      const request = normalizePairingRequest(rawRequest, now);
      if (!request) throw new Error('invalid_pairing_request');
      if (request.device.peerId !== remotePeerId) throw new Error('pairing_peer_id_mismatch');
      releaseAdmission = this.claimPairingAdmission({
        sessionId: request.sessionId,
        remotePeerId,
        requestNonce: request.requestNonce,
        expiresAt: request.expiresAt,
      });
      await assertPairingDeviceIdentity(request.device);
      this.requirePairingAdmission(request.sessionId);
      const responseNonce = randomPairingNonce();
      const localDevice = this.localPairingDevice();
      const expiresAt = Math.min(request.expiresAt, Date.now() + PAIRING_SESSION_TTL_MS);
      if (expiresAt <= Date.now()) throw new Error('pairing_request_expired');
      const session: PairingSession = {
        sessionId: request.sessionId,
        localPeerId: this.options.identity.peerId,
        remotePeerId: request.device.peerId,
        remotePublicKeyMultibase: request.device.publicKeyMultibase,
        remoteDeviceName: request.device.deviceName,
        remotePlatform: request.device.platform,
        remoteCapabilities: request.device.capabilities,
        remoteMultiaddrs: request.device.multiaddrs,
        direction: 'inbound',
        status: 'pending',
        confirmCode: await buildPairingConfirmCode({
          initiator: request.device,
          responder: localDevice,
          requestNonce: request.requestNonce,
          responseNonce,
        }),
        createdAt: Date.now(),
        expiresAt,
      };
      const response: PairingResponseMessage = {
        type: 'memeloop-local-pairing-response-v2',
        sessionId: request.sessionId,
        requestNonce: request.requestNonce,
        responseNonce,
        accepted: true,
        expiresAt,
        device: localDevice,
      };
      await writeJsonMessage(stream, response);
      await stream.close();
      this.requirePairingAdmission(request.sessionId);
      this.pairingSessions.set(session.sessionId, session);
      this.pairingChallenges.set(session.sessionId, {
        sessionId: session.sessionId,
        remotePeerId: session.remotePeerId,
        requestNonce: request.requestNonce,
        expiresAt,
      });
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, request.device);
      this.emitPairingSessions();
      this.emitDevices();
    } catch (error) {
      abortLibp2pStreamOnce(
        stream,
        error instanceof Error ? error : new Error('pairing_handler_failed'),
      );
      throw error;
    } finally {
      releaseAdmission();
    }
  }

  private async sessionFromPairingResponse(
    peerId: string,
    request: PairingRequestMessage,
    response: PairingResponseMessage,
  ): Promise<PairingSession> {
    const now = Date.now();
    if (!isPairingResponse(response, now)) throw new Error('invalid_pairing_response');
    const normalizedResponse = normalizePairingResponse(response, now);
    if (!normalizedResponse) throw new Error('invalid_pairing_response');
    if (normalizedResponse.sessionId !== request.sessionId) {
      throw new Error('pairing_session_mismatch');
    }
    if (normalizedResponse.requestNonce !== request.requestNonce) {
      throw new Error('pairing_nonce_mismatch');
    }
    if (normalizedResponse.device.peerId !== peerId) throw new Error('pairing_peer_id_mismatch');
    if (normalizedResponse.expiresAt > request.expiresAt) {
      throw new Error('pairing_response_expiry_mismatch');
    }
    await assertPairingDeviceIdentity(normalizedResponse.device);
    return {
      sessionId: request.sessionId,
      localPeerId: this.options.identity.peerId,
      remotePeerId: normalizedResponse.device.peerId,
      remotePublicKeyMultibase: normalizedResponse.device.publicKeyMultibase,
      remoteDeviceName: normalizedResponse.device.deviceName,
      remotePlatform: normalizedResponse.device.platform,
      remoteCapabilities: normalizedResponse.device.capabilities,
      remoteMultiaddrs: normalizedResponse.device.multiaddrs,
      direction: 'outbound',
      status: 'pending',
      confirmCode: await buildPairingConfirmCode({
        initiator: request.device,
        responder: normalizedResponse.device,
        requestNonce: request.requestNonce,
        responseNonce: normalizedResponse.responseNonce,
      }),
      createdAt: request.createdAt,
      expiresAt: normalizedResponse.expiresAt,
    };
  }

  private requirePairingSession(sessionId: string): PairingSession {
    const session = this.pairingSessions.get(sessionId);
    if (!session) throw new Error('pairing_session_not_found');
    return session;
  }

  private claimPairingAdmission(admission: PairingAdmission): () => void {
    this.refreshPairingSessionExpiry();
    if (
      this.pairingSessions.has(admission.sessionId) ||
      this.pairingAdmissions.has(admission.sessionId)
    ) {
      throw new Error('pairing_session_conflict');
    }
    const duplicateChallenge = [...this.pairingChallenges.values(), ...this.pairingAdmissions.values()]
      .some((current) =>
        current.remotePeerId === admission.remotePeerId &&
        current.requestNonce === admission.requestNonce
      );
    if (duplicateChallenge) throw new Error('pairing_nonce_conflict');

    const pendingSessions = [...this.pairingSessions.values()]
      .filter((session) => session.status === 'pending');
    if (pendingSessions.length + this.pairingAdmissions.size >= PAIRING_MAX_PENDING_GLOBAL) {
      throw new Error('pairing_pending_global_limit');
    }
    const peerPending = pendingSessions
      .filter((session) => session.remotePeerId === admission.remotePeerId).length;
    const peerAdmissions = [...this.pairingAdmissions.values()]
      .filter((current) => current.remotePeerId === admission.remotePeerId).length;
    if (peerPending + peerAdmissions >= PAIRING_MAX_PENDING_PER_PEER) {
      throw new Error('pairing_pending_peer_limit');
    }

    this.pairingAdmissions.set(admission.sessionId, admission);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.pairingAdmissions.get(admission.sessionId) === admission) {
        this.pairingAdmissions.delete(admission.sessionId);
      }
    };
  }

  private requirePairingAdmission(sessionId: string): PairingAdmission {
    const admission = this.pairingAdmissions.get(sessionId);
    if (!admission || admission.expiresAt <= Date.now()) {
      this.pairingAdmissions.delete(sessionId);
      throw new Error('pairing_admission_expired');
    }
    return admission;
  }

  private deletePairingSession(sessionId: string): void {
    const session = this.pairingSessions.get(sessionId);
    this.pairingSessions.delete(sessionId);
    this.pairingChallenges.delete(sessionId);
    if (session) this.cleanupPairingDiscoveredDevice(session.remotePeerId);
  }

  private refreshPairingSessionExpiry(): void {
    const now = Date.now();
    let changed = false;
    for (const [sessionId, session] of this.pairingSessions) {
      if (session.expiresAt <= now) {
        this.deletePairingSession(sessionId);
        changed = true;
      }
    }
    for (const [sessionId, admission] of this.pairingAdmissions) {
      if (admission.expiresAt <= now) this.pairingAdmissions.delete(sessionId);
    }
    for (const [sessionId, challenge] of this.pairingChallenges) {
      if (challenge.expiresAt <= now) this.pairingChallenges.delete(sessionId);
    }
    if (changed) this.emitPairingSessions();
  }

  private upsertDiscoveredDeviceFromPairing(peerId: string, device: PairingDeviceEnvelope): void {
    const current = this.discoveredDevices.get(peerId);
    if (!current) this.pairingDiscoveredPeerIds.add(peerId);
    this.discoveredDevices.set(peerId, {
      peerId,
      displayName: device.deviceName,
      platform: device.platform,
      trustMode: current?.trustMode ?? 'local-pairing',
      trusted: current?.trusted ?? this.trustedDevices.has(peerId),
      reachability: current?.reachability ?? {
        state: 'nearby',
        paths: device.multiaddrs.length > 0 ? ['lan'] : [],
      },
      capabilities: device.capabilities,
      multiaddrs: device.multiaddrs,
      lastSeen: Date.now(),
    });
  }

  private cleanupPairingDiscoveredDevice(peerId: string): void {
    if (
      !this.pairingDiscoveredPeerIds.has(peerId) ||
      this.trustedDevices.has(peerId) ||
      [...this.pairingSessions.values()].some((session) => session.remotePeerId === peerId)
    ) return;
    this.pairingDiscoveredPeerIds.delete(peerId);
    this.discoveredDevices.delete(peerId);
    this.emitDevices();
  }

  private wrapStream(stream: Stream, signal?: AbortSignal): MemeLoopDuplexStream {
    let removeAbortListener = (): void => {};
    const streamLifecycle = new AbortController();
    const onStreamClose = (event: Event): void => {
      if (streamLifecycle.signal.aborted) return;
      const closeEvent = event as Event & { error?: Error };
      streamLifecycle.abort(closeEvent.error ?? new Error('device_stream_closed'));
    };
    stream.addEventListener?.('close', onStreamClose, { once: true });
    const removeStreamCloseListener = (): void => {
      stream.removeEventListener?.('close', onStreamClose);
    };
    const abort = (error: Error): void => {
      removeAbortListener();
      removeStreamCloseListener();
      if (!streamLifecycle.signal.aborted) streamLifecycle.abort(error);
      abortLibp2pStreamOnce(stream, error);
    };
    if (signal) {
      const onAbort = (): void => {
        abort(abortSignalError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }
    const source = this.streamSource(stream);
    return {
      signal: streamLifecycle.signal,
      source: (async function* abortAwareSource() {
        try {
          yield* source;
        } finally {
          removeAbortListener();
        }
      })(),
      async sink(source) {
        for await (const chunk of source) {
          stream.send(chunk);
        }
        await stream.close();
      },
      close: async () => {
        try {
          await stream.close();
        } finally {
          removeAbortListener();
          removeStreamCloseListener();
        }
      },
      abort,
    };
  }

  private async *streamSource(stream: Stream): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      if (chunk instanceof Uint8Array) {
        yield chunk;
      } else {
        yield chunk.subarray();
      }
    }
  }

  private markPeerOnline(peerId: PeerId): void {
    const id = peerId.toString();
    const current = this.discoveredDevices.get(id);
    if (current) {
      current.reachability = { state: 'online', paths: current.reachability.paths };
      current.lastSeen = Date.now();
      this.emitDevices();
    }
  }

  private markPeerOffline(peerId: PeerId): void {
    const id = peerId.toString();
    const current = this.discoveredDevices.get(id);
    if (current) {
      current.reachability = { state: 'offline', paths: [] };
      current.lastSeen = Date.now();
      this.emitDevices();
    }
  }

  private updateDeviceTrust(
    peerId: string,
    trustMode: Device['trustMode'],
    trusted: boolean,
  ): void {
    const current = this.discoveredDevices.get(peerId);
    if (current) {
      this.discoveredDevices.set(peerId, {
        ...current,
        trustMode,
        trusted,
      });
    }
  }

  private toVisibleDevices(): Device[] {
    const visible = new Map(this.discoveredDevices);
    for (const record of this.trustedDevices.values()) {
      const current = visible.get(record.peerId);
      if (current) {
        visible.set(record.peerId, {
          ...current,
          displayName: record.deviceName,
          platform: record.platform,
          trustMode: record.trustMode,
          trusted: record.revokedAt === undefined,
          lastSeen: current.lastSeen ?? record.lastSeen,
        });
        continue;
      }
      if (record.revokedAt !== undefined) continue;
      visible.set(record.peerId, {
        peerId: record.peerId,
        displayName: record.deviceName,
        platform: record.platform,
        trustMode: record.trustMode,
        trusted: true,
        reachability: {
          state: 'offline',
          paths: [],
        },
        capabilities: emptyCapabilities,
        lastSeen: record.lastSeen,
      });
    }
    return [...visible.values()];
  }

  private emitDevices(): void {
    const devices = this.toVisibleDevices();
    for (const listener of this.listeners) listener(devices);
  }

  private emitPairingSessions(): void {
    const sessions = [...this.pairingSessions.values()];
    for (const listener of this.pairingListeners) listener(sessions);
  }

  private requireNode(): Libp2p {
    if (!this.libp2p) throw new Error('device_network_not_started');
    return this.libp2p;
  }
}

async function dialRelayAdmissionStream(
  node: Libp2p,
  address: string,
  signal: AbortSignal,
  fence: DeviceCloudCommitFence,
): Promise<Stream> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= RELAY_ADMISSION_DIAL_MAX_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    fence.throwIfStale();
    const controller = linkedTimeoutController(
      signal,
      RELAY_ADMISSION_DIAL_TIMEOUT_MS,
      'relay_admission_dial_timeout',
    );
    try {
      const stream = await node.dialProtocol(multiaddr(address), RELAY_ADMISSION_PROTOCOL, {
        signal: controller.signal,
      });
      signal.throwIfAborted();
      fence.throwIfStale();
      return stream;
    } catch (error) {
      signal.throwIfAborted();
      fence.throwIfStale();
      errors.push(
        `attempt ${attempt}/${RELAY_ADMISSION_DIAL_MAX_ATTEMPTS}: ${error instanceof Error ? error.message : 'relay_admission_dial_failed'}`,
      );
    } finally {
      controller.dispose();
    }
  }
  throw new Error(`relay_admission_dial_failed: ${errors.join('; ')}`);
}

export interface RawSeedDeviceIdentity extends LocalDeviceIdentity {
  privateKeyRawSeedBase64Url: string;
}

interface Libp2pWithTransportManager {
  components?: {
    transportManager?: {
      getListeners(): Listener[];
      listen(addresses: Multiaddr[]): Promise<void>;
    };
  };
}

const PUBLIC_KEY_MULTIBASE_PREFIX = 'libp2p-pub:';
export const LOCAL_PAIRING_CONFIRMATION_DOMAIN = 'memeloop-local-pairing-confirm-v2';

async function loadCryptoKeys() {
  return import('@libp2p/crypto/keys');
}

async function loadUint8arrays() {
  return import('uint8arrays');
}

function randomPairingNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function writeJsonMessage(
  stream: Stream,
  message: unknown,
  maxBytes: number = PAIRING_MESSAGE_MAX_BYTES,
): Promise<void> {
  stream.send(encodeJsonFrame(message, maxBytes));
}

async function readJsonMessage<T>(
  stream: Stream,
  maxBytes: number = PAIRING_MESSAGE_MAX_BYTES,
  idleTimeoutMs: number = PAIRING_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = PAIRING_TOTAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const source = (async function*(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  })();
  const reader = createJsonFrameReader(source, {
    maxPayloadBytes: maxBytes,
    idleTimeoutMs,
    totalTimeoutMs,
    signal,
    // Returning after the single request frame is intentional: the same
    // duplex stream remains open for the response. Protocol errors are
    // aborted explicitly in the catch below.
    abort: () => undefined,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done) throw new Error('json_message_missing');
    return result.value as T;
  } catch (error) {
    abortLibp2pStreamOnce(
      stream,
      error instanceof Error ? error : new Error('json_message_read_failed', { cause: error }),
    );
    throw error;
  } finally {
    void reader.return?.();
  }
}

async function writeStreamJson(
  stream: MemeLoopDuplexStream,
  message: unknown,
  maxBytes: number = RPC_MESSAGE_MAX_BYTES,
): Promise<void> {
  await stream.sink(encodeJsonFrames([message], maxBytes));
}

async function readStreamJson(
  stream: MemeLoopDuplexStream,
  maxBytes: number = RPC_MESSAGE_MAX_BYTES,
  idleTimeoutMs: number = RPC_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = RPC_TOTAL_TIMEOUT_MS,
): Promise<unknown> {
  const reader = createJsonFrameReader(stream.source, {
    maxPayloadBytes: maxBytes,
    idleTimeoutMs,
    totalTimeoutMs,
    abort: () => undefined,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done) throw new Error('rpc_response_missing');
    return result.value;
  } catch (error) {
    void stream.abort(
      error instanceof Error ? error : new Error('rpc_response_read_failed', { cause: error }),
    );
    throw error;
  } finally {
    void reader.return?.();
  }
}

function isRelayAdmissionResponse(value: unknown): value is RelayAdmissionResponseMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === RELAY_ADMISSION_RESPONSE_TYPE && typeof record.ok === 'boolean';
}

function relayCircuitMultiaddr(address: string): Multiaddr {
  const parsed = multiaddr(address);
  return address.includes('/p2p-circuit') ? parsed : parsed.encapsulate('/p2p-circuit');
}

function validateRelayReservationVerificationOptions(
  options: RelayReservationVerificationOptions | undefined,
): void {
  if (!options) return;
  const reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
  const reservationSafetyMarginMs = options.reservationSafetyMarginMs ??
    DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new Error('invalid_relay_reservation_ttl');
  }
  if (!Number.isSafeInteger(reservationSafetyMarginMs) || reservationSafetyMarginMs < 0) {
    throw new Error('invalid_relay_reservation_safety_margin');
  }
  if (!Number.isSafeInteger(reservationTtlMs + reservationSafetyMarginMs)) {
    throw new Error('invalid_relay_reservation_lifetime');
  }
}

function relayTokenCoversReservation(
  token: DeviceRelayReservationToken,
  now: number,
  reservationTtlMs: number,
  reservationSafetyMarginMs: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(token.issuedAt) &&
    Number.isSafeInteger(token.expiresAt) &&
    token.issuedAt <= token.expiresAt &&
    token.expiresAt > now &&
    token.expiresAt - now >= reservationTtlMs + reservationSafetyMarginMs
  );
}

function strictMultiaddrs(addresses: unknown): string[] | undefined {
  if (!Array.isArray(addresses)) return undefined;
  const parsed: string[] = [];
  for (const address of addresses) {
    if (typeof address !== 'string' || address.length === 0 || address !== address.trim()) {
      return undefined;
    }
    try {
      multiaddr(address);
      parsed.push(address);
    } catch {
      return undefined;
    }
  }
  return parsed;
}

/**
 * Cloud directory addresses are executable dial targets, not display data.
 * Require every address to terminate in the advertised destination PeerId so
 * a compromised/stale directory response cannot redirect an authenticated RPC
 * or sync request to another libp2p identity. Relay circuit addresses may have
 * an earlier relay PeerId; the final component must still be the destination.
 */
function strictPeerBoundMultiaddrs(peerId: string, addresses: readonly string[]): string[] {
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('non_canonical_peer_id');
  } catch {
    throw new Error('invalid_cloud_directory_peer_id');
  }
  if (addresses.length > CLOUD_DIRECTORY_MAX_ADDRESSES) {
    throw new Error('too_many_cloud_directory_addresses');
  }

  const unique = new Set<string>();
  for (const address of addresses) {
    if (
      typeof address !== 'string' ||
      address.length === 0 ||
      address.length > CLOUD_DIRECTORY_MAX_ADDRESS_LENGTH ||
      address !== address.trim()
    ) {
      throw new Error('invalid_cloud_directory_address');
    }
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(address);
    } catch {
      throw new Error('invalid_cloud_directory_address');
    }
    const components = parsed.getComponents();
    const finalComponent = components.at(-1);
    if (finalComponent?.name !== 'p2p' || finalComponent.value !== peerId) {
      throw new Error('cloud_directory_address_peer_id_mismatch');
    }
    unique.add(parsed.toString());
  }
  return [...unique].sort();
}

/**
 * Pairing envelopes are untrusted discovery input. Every executable address
 * must terminate in the Noise-authenticated device PeerId. Circuit relay
 * addresses may contain a relay PeerId earlier in the path, but the invited
 * device must remain the final `/p2p` component.
 */
function strictPairingMultiaddrs(peerId: string, addresses: readonly unknown[]): string[] {
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('non_canonical_peer_id');
  } catch {
    throw new Error('invalid_pairing_peer_id');
  }
  if (addresses.length > PAIRING_MAX_MULTIADDRS) {
    throw new Error('too_many_pairing_addresses');
  }
  const unique = new Set<string>();
  for (const address of addresses) {
    if (
      typeof address !== 'string' ||
      address.length === 0 ||
      address.length > PAIRING_MAX_MULTIADDR_LENGTH ||
      address !== address.trim()
    ) throw new Error('invalid_pairing_address');
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(address);
    } catch {
      throw new Error('invalid_pairing_address');
    }
    const finalComponent = parsed.getComponents().at(-1);
    if (finalComponent?.name !== 'p2p' || finalComponent.value !== peerId) {
      throw new Error('pairing_address_peer_id_mismatch');
    }
    const canonical = parsed.toString();
    if (unique.has(canonical)) throw new Error('duplicate_pairing_address');
    unique.add(canonical);
  }
  return [...unique].sort();
}

function relayTokenAudiencePeerId(addresses: unknown): string | undefined {
  const relayMultiaddrs = strictMultiaddrs(addresses);
  if (!relayMultiaddrs || relayMultiaddrs.length === 0) return undefined;
  let audiencePeerId: string | undefined;
  for (const address of relayMultiaddrs) {
    const components = multiaddr(address).getComponents();
    if (components.some((component) => component.name === 'p2p-circuit')) return undefined;
    const peerComponents = components.filter((component) => component.name === 'p2p');
    if (peerComponents.length !== 1 || components.at(-1) !== peerComponents[0]) return undefined;
    const peerId = peerComponents[0]?.value;
    if (!peerId) return undefined;
    try {
      if (peerIdFromString(peerId).toString() !== peerId) return undefined;
    } catch {
      return undefined;
    }
    audiencePeerId ??= peerId;
    if (peerId !== audiencePeerId) return undefined;
  }
  return audiencePeerId;
}

interface RpcGrantResources {
  conversationId?: string;
  definitionId?: string;
  requiresAllConversations?: boolean;
  requiresAllDefinitions?: boolean;
}

async function rpcGrantResources(input: {
  method: string;
  parameters: unknown;
  remotePeerId: string;
  presentedGrant?: DeviceConnectionGrant;
  resolveRunGrantResources?: Libp2pDeviceNetworkServiceOptions['resolveRunGrantResources'];
}): Promise<RpcGrantResources> {
  if (!isAgentDeviceRpcMethod(input.method)) {
    throw new Error(`rpc_method_not_found:${input.method}`);
  }
  const asserted = parseAgentDeviceRpcGrantResources(input.method, input.parameters);
  const resources: RpcGrantResources = {
    ...(asserted.conversationId === undefined
      ? {}
      : { conversationId: asserted.conversationId }),
    ...(asserted.definitionId === undefined ? {} : { definitionId: asserted.definitionId }),
    ...(input.method === AGENT_DEVICE_RPC_METHODS.listConversations ||
        (input.method === AGENT_DEVICE_RPC_METHODS.create && asserted.conversationId === undefined)
      ? { requiresAllConversations: true }
      : {}),
    ...(input.method === AGENT_DEVICE_RPC_METHODS.getDefinitions
      ? { requiresAllDefinitions: true }
      : {}),
  };
  if (input.presentedGrant) {
    if (
      resources.requiresAllConversations &&
      input.presentedGrant.conversationScope.mode !== 'all'
    ) throw new Error('device_grant_rpc_scope_violation');
    if (
      resources.requiresAllDefinitions &&
      input.presentedGrant.definitionScope.mode !== 'all'
    ) throw new Error('device_grant_rpc_scope_violation');
    if (
      !deviceConnectionGrantAllowsRpc(input.presentedGrant, {
        method: input.method,
        ...(resources.conversationId ? { conversationId: resources.conversationId } : {}),
        ...(resources.definitionId ? { definitionId: resources.definitionId } : {}),
      })
    ) throw new Error('device_grant_rpc_scope_violation');
  }
  if (!input.presentedGrant || asserted.runId === undefined) return resources;

  const resolved = await input.resolveRunGrantResources?.(asserted.runId, input.remotePeerId);
  if (!resolved) throw new Error('device_grant_run_scope_unavailable');
  assertRpcGrantResourceIdentifier(resolved.requestPeerId);
  assertRpcGrantResourceIdentifier(resolved.conversationId);
  assertRpcGrantResourceIdentifier(resolved.definitionId);
  if (resolved.requestPeerId !== input.remotePeerId) {
    throw new Error('device_grant_run_peer_mismatch');
  }
  if (
    asserted.conversationId !== undefined &&
    asserted.conversationId !== resolved.conversationId
  ) {
    throw new Error('device_grant_run_conversation_mismatch');
  }
  return {
    conversationId: resolved.conversationId,
    definitionId: resolved.definitionId,
  };
}

function assertRpcGrantResourceIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('device_grant_run_scope_invalid');
  }
}

function objectParameter(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_sync_params');
  }
  return value as Record<string, unknown>;
}

function assertOnlyParameterKeys(
  parameters: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  if (Object.keys(parameters).some(key => !keys.has(key))) {
    throw new Error('invalid_sync_params');
  }
}

const PUBLIC_RPC_ERROR_CODES = new Set([
  'device_grant_rpc_scope_violation',
  'device_grant_run_conversation_mismatch',
  'device_grant_run_definition_mismatch',
  'device_grant_run_peer_mismatch',
  'device_grant_run_scope_invalid',
  'device_grant_run_scope_unavailable',
  'device_not_trusted',
  'invalid_rpc_params',
  'invalid_rpc_request',
  'rpc_collection_scope_violation',
  'rpc_handler_not_configured',
  'rpc_method_not_found',
  'rpc_permission_denied',
  'rpc_resource_not_found',
]);

function rpcErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const unscopedCode = message.split(':', 1)[0] ?? '';
  return PUBLIC_RPC_ERROR_CODES.has(unscopedCode)
    ? unscopedCode
    : 'rpc_handler_failed';
}

function syncErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid canonical conversation event')) return 'invalid_sync_events';
  if (message.startsWith('Invalid typed JSON value')) return 'invalid_sync_response';
  return /^[a-z][a-z\d_]{0,63}$/u.test(message) ? message : 'sync_request_failed';
}

function canonicalEventBatchParameter(value: unknown): readonly ConversationEvent[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('invalid_sync_events');
  const events: readonly unknown[] = value;
  assertCanonicalConversationEvents(events);
  return events;
}

function isSyncIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    !Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

function stringParameter(parameters: Record<string, unknown>, key: string): string {
  const value = parameters[key];
  if (!isSyncIdentifier(value)) {
    throw new Error('invalid_sync_params');
  }
  return value;
}

function nonNegativeIntegerParameter(parameters: Record<string, unknown>, key: string): number {
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid_sync_params');
  }
  return value;
}

function positiveIntegerParameter(parameters: Record<string, unknown>, key: string): number {
  const value = nonNegativeIntegerParameter(parameters, key);
  if (value === 0) throw new Error('invalid_sync_params');
  return value;
}

function versionFrontierArrayParameter(
  parameters: Record<string, unknown>,
  key: string,
): Array<{
  conversationId: string;
  originNodeId: string;
  maxContiguousOriginSequence: number;
}> {
  const value = parameters[key];
  if (!Array.isArray(value) || value.length > 128) throw new Error('invalid_sync_frontiers');
  let previous: { conversationId: string; originNodeId: string } | undefined;
  return value.map(item => {
    const frontier = objectParameter(item);
    assertOnlyParameterKeys(frontier, [
      'conversationId',
      'originNodeId',
      'maxContiguousOriginSequence',
    ]);
    const conversationId = stringParameter(frontier, 'conversationId');
    const originNodeId = stringParameter(frontier, 'originNodeId');
    const maxContiguousOriginSequence = positiveIntegerParameter(
      frontier,
      'maxContiguousOriginSequence',
    );
    const cursor = { conversationId, originNodeId };
    if (previous && compareFrontierIdentity(cursor, previous) <= 0) {
      throw new Error('invalid_sync_frontier_order');
    }
    previous = cursor;
    return { ...cursor, maxContiguousOriginSequence };
  });
}

function versionFrontierCursorParameter(
  parameters: Record<string, unknown>,
  key: string,
): { conversationId: string; originNodeId: string } | undefined {
  if (parameters[key] === undefined) return undefined;
  const cursor = objectParameter(parameters[key]);
  assertOnlyParameterKeys(cursor, ['conversationId', 'originNodeId']);
  return {
    conversationId: stringParameter(cursor, 'conversationId'),
    originNodeId: stringParameter(cursor, 'originNodeId'),
  };
}

function assertValidStoredFrontierPage(
  value: unknown,
  previous: { conversationId: string; originNodeId: string } | undefined,
  expectedPage: boolean,
): void {
  const page = objectParameter(value);
  assertOnlyParameterKeys(page, ['items', 'nextCursor']);
  if (
    !Array.isArray(page.items) || page.items.length > 128 ||
    !expectedPage && (page.items.length > 0 || page.nextCursor !== undefined)
  ) {
    throw new Error('invalid_stored_frontier_page');
  }
  let last = previous;
  for (const item of page.items) {
    const frontier = objectParameter(item);
    assertOnlyParameterKeys(frontier, [
      'conversationId',
      'originNodeId',
      'maxContiguousOriginSequence',
    ]);
    const current = {
      conversationId: stringParameter(frontier, 'conversationId'),
      originNodeId: stringParameter(frontier, 'originNodeId'),
    };
    positiveIntegerParameter(frontier, 'maxContiguousOriginSequence');
    if (last && compareFrontierIdentity(current, last) <= 0) {
      throw new Error('invalid_stored_frontier_order');
    }
    last = current;
  }
  if (page.nextCursor === undefined) return;
  const cursor = versionFrontierCursorParameter(page, 'nextCursor');
  if (
    !cursor || !last || compareFrontierIdentity(cursor, last) !== 0 ||
    previous && compareFrontierIdentity(cursor, previous) <= 0
  ) {
    throw new Error('storage_frontier_cursor_did_not_advance');
  }
}

function compareFrontierIdentity(
  left: { conversationId: string; originNodeId: string },
  right: { conversationId: string; originNodeId: string },
): number {
  return compareUtf8Bytes(left.conversationId, right.conversationId) ||
    compareUtf8Bytes(left.originNodeId, right.originNodeId);
}

function booleanParameter(parameters: Record<string, unknown>, key: string): boolean {
  const value = parameters[key];
  if (typeof value !== 'boolean') throw new Error('invalid_sync_params');
  return value;
}

function versionRangeArrayParameter(
  parameters: Record<string, unknown>,
  key: string,
): VersionRange[] {
  const value = parameters[key];
  if (!Array.isArray(value) || value.length > 256) throw new Error('invalid_sync_ranges');
  return value.map(item => {
    const range = objectParameter(item);
    assertOnlyParameterKeys(range, [
      'conversationId',
      'originNodeId',
      'fromExclusive',
      'toInclusive',
    ]);
    const conversationId = range.conversationId;
    const originNodeId = range.originNodeId;
    const fromExclusive = range.fromExclusive;
    const toInclusive = range.toInclusive;
    if (
      !isSyncIdentifier(conversationId) ||
      !isSyncIdentifier(originNodeId) ||
      typeof fromExclusive !== 'number' || !Number.isSafeInteger(fromExclusive) || fromExclusive < 0 ||
      typeof toInclusive !== 'number' || !Number.isSafeInteger(toInclusive) || toInclusive < fromExclusive
    ) throw new Error('invalid_sync_range');
    return { conversationId, originNodeId, fromExclusive, toInclusive };
  });
}

function eventCursorParameter(
  parameters: Record<string, unknown>,
  key: string,
): ConversationEventCursor | undefined {
  if (parameters[key] === undefined) return undefined;
  const cursor = objectParameter(parameters[key]);
  assertOnlyParameterKeys(cursor, ['originNodeId', 'originSequence', 'eventId']);
  const originSequence = cursor.originSequence;
  if (
    typeof originSequence !== 'number' || !Number.isSafeInteger(originSequence) ||
    originSequence <= 0
  ) throw new Error('invalid_sync_cursor');
  return {
    originNodeId: stringParameter(cursor, 'originNodeId'),
    originSequence,
    eventId: stringParameter(cursor, 'eventId'),
  };
}

function storedEventCursor(event: ConversationEvent): ConversationEventCursor {
  return {
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    eventId: event.eventId,
  };
}

function compareEventCursor(
  left: ConversationEventCursor,
  right: ConversationEventCursor,
): number {
  return compareUtf8Bytes(left.originNodeId, right.originNodeId) ||
    left.originSequence - right.originSequence ||
    compareUtf8Bytes(left.eventId, right.eventId);
}

function sameEventCursor(
  cursor: ConversationEventCursor,
  previous: ConversationEventCursor | undefined,
): boolean {
  return previous !== undefined && compareEventCursor(cursor, previous) <= 0;
}

function boundedEventSyncPage(
  page: ConversationEventPage,
  ranges: VersionRange[],
  previousCursor: ConversationEventCursor | undefined,
): { items: ConversationEvent[]; nextCursor?: ConversationEventCursor } {
  if (!Array.isArray(page.items) || page.items.length > 128) {
    throw new Error('invalid_stored_event_page');
  }
  const items: ConversationEvent[] = [];
  let itemBytes = 2;
  let lastScannedCursor = previousCursor;
  let stoppedForBytes = false;
  for (const event of page.items) {
    try {
      assertCanonicalConversationEvents([event]);
    } catch {
      throw new Error('invalid_stored_conversation_event');
    }
    const cursor = storedEventCursor(event);
    const matches = ranges.some(range =>
      event.conversationId === range.conversationId &&
      event.originNodeId === range.originNodeId &&
      event.originSequence > range.fromExclusive &&
      event.originSequence <= range.toInclusive
    );
    if (matches) {
      const eventBytes = canonicalConversationEventBytes(event).byteLength + (items.length > 0 ? 1 : 0);
      if (itemBytes + eventBytes > SYNC_MESSAGE_PAGE_MAX_BYTES) {
        if (items.length === 0) throw new Error('sync_event_too_large');
        stoppedForBytes = true;
        break;
      }
      items.push(event);
      itemBytes += eventBytes;
    }
    lastScannedCursor = cursor;
  }

  const hasMore = stoppedForBytes || page.hasMoreAfter;
  if (!hasMore) return { items };
  if (!lastScannedCursor || sameEventCursor(lastScannedCursor, previousCursor)) {
    throw new Error('storage_event_cursor_did_not_advance');
  }
  return { items, nextCursor: lastScannedCursor };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8Bytes(left: string, right: string): number {
  if (left === right) return 0;
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function conversationIdsParameter(parameters: unknown): ReadonlySet<string> | undefined {
  const value = objectParameter(parameters).conversationIds;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new Error('invalid_sync_conversation_ids');
  const ids = new Set<string>();
  for (const item of value) {
    if (!isSyncIdentifier(item)) {
      throw new Error('invalid_sync_conversation_id');
    }
    ids.add(item);
  }
  return ids;
}

function conversationIdsForGrant(
  grant: DeviceConnectionGrant | undefined,
  requested: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (!grant) return requested;
  const scope = grant.conversationScope;
  if (scope.mode === 'none') {
    throw new Error('device_grant_conversation_scope_required');
  }
  if (scope.mode === 'all') return requested;
  const allowed = new Set(scope.ids);
  if (requested === undefined) return allowed;
  for (const conversationId of requested) {
    if (!allowed.has(conversationId)) {
      throw new Error('device_grant_conversation_scope_violation');
    }
  }
  return requested;
}

function requestedConversationIdsForGrant(
  grant: DeviceConnectionGrant | undefined,
  requested: readonly string[] | undefined,
): string[] | undefined {
  const requestedSet = requested === undefined ? undefined : new Set(requested);
  const scoped = conversationIdsForGrant(grant, requestedSet);
  return scoped === undefined ? undefined : [...scoped].sort(compareCodeUnits);
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'desktop' || value === 'mobile' || value === 'cli' || value === 'web';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyRecordKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isBoundedTrimmedString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    (pattern?.test(value) ?? true)
  );
}

function normalizePairingStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > PAIRING_MAX_CAPABILITY_ITEMS) return undefined;
  const unique = new Set<string>();
  for (const item of value) {
    if (!isBoundedTrimmedString(item, PAIRING_MAX_CAPABILITY_STRING_LENGTH)) return undefined;
    unique.add(item);
  }
  return [...unique].sort();
}

function normalizePairingCapabilities(value: unknown): DeviceCapabilities | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyRecordKeys(value, [
      'tools',
      'mcpServers',
      'hasWiki',
      'agentLoop',
      'imChannels',
      'wikis',
    ]) ||
    !Object.hasOwn(value, 'tools') ||
    !Object.hasOwn(value, 'mcpServers') ||
    !Object.hasOwn(value, 'hasWiki') ||
    !Object.hasOwn(value, 'imChannels') ||
    !Object.hasOwn(value, 'wikis') ||
    typeof value.hasWiki !== 'boolean' ||
    (value.agentLoop !== undefined && typeof value.agentLoop !== 'boolean')
  ) return undefined;
  const tools = normalizePairingStringArray(value.tools);
  const mcpServers = normalizePairingStringArray(value.mcpServers);
  const imChannels = normalizePairingStringArray(value.imChannels);
  if (!tools || !mcpServers || !imChannels || !Array.isArray(value.wikis)) return undefined;
  if (value.wikis.length > PAIRING_MAX_WIKIS) return undefined;
  const wikis: DeviceCapabilities['wikis'] = [];
  const wikiIds = new Set<string>();
  for (const wiki of value.wikis) {
    if (
      !isRecord(wiki) ||
      !hasOnlyRecordKeys(wiki, ['wikiId', 'title', 'pathHint']) ||
      !isBoundedTrimmedString(wiki.wikiId, PAIRING_MAX_CAPABILITY_STRING_LENGTH) ||
      (wiki.title !== undefined &&
        !isBoundedTrimmedString(wiki.title, PAIRING_MAX_WIKI_TITLE_LENGTH)) ||
      (wiki.pathHint !== undefined &&
        !isBoundedTrimmedString(wiki.pathHint, PAIRING_MAX_WIKI_PATH_LENGTH)) ||
      wikiIds.has(wiki.wikiId)
    ) return undefined;
    wikiIds.add(wiki.wikiId);
    wikis.push({
      wikiId: wiki.wikiId,
      ...(wiki.title === undefined ? {} : { title: wiki.title }),
      ...(wiki.pathHint === undefined ? {} : { pathHint: wiki.pathHint }),
    });
  }
  wikis.sort((left, right) => left.wikiId.localeCompare(right.wikiId));
  return {
    tools,
    mcpServers,
    hasWiki: value.hasWiki,
    agentLoop: value.agentLoop === true,
    imChannels,
    wikis,
  };
}

function normalizePairingDevice(value: unknown): PairingDeviceEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyRecordKeys(value, [
      'peerId',
      'publicKeyMultibase',
      'deviceName',
      'platform',
      'capabilities',
      'multiaddrs',
    ]) ||
    Object.keys(value).length !== 6 ||
    !isBoundedTrimmedString(value.peerId, PAIRING_MAX_PEER_ID_LENGTH) ||
    !isBoundedTrimmedString(value.publicKeyMultibase, PAIRING_MAX_PUBLIC_KEY_LENGTH) ||
    !value.publicKeyMultibase.startsWith(PUBLIC_KEY_MULTIBASE_PREFIX) ||
    !isBoundedTrimmedString(value.deviceName, PAIRING_MAX_DEVICE_NAME_LENGTH) ||
    !isDevicePlatform(value.platform)
  ) return undefined;
  try {
    if (peerIdFromString(value.peerId).toString() !== value.peerId) return undefined;
  } catch {
    return undefined;
  }
  const capabilities = normalizePairingCapabilities(value.capabilities);
  if (!capabilities || !Array.isArray(value.multiaddrs)) return undefined;
  let multiaddrs: string[];
  try {
    multiaddrs = strictPairingMultiaddrs(value.peerId, value.multiaddrs);
  } catch {
    return undefined;
  }
  return {
    peerId: value.peerId,
    publicKeyMultibase: value.publicKeyMultibase,
    deviceName: value.deviceName,
    platform: value.platform,
    capabilities,
    multiaddrs,
  };
}

function normalizePairingRequest(value: unknown, now: number): PairingRequestMessage | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !hasOnlyRecordKeys(value, [
      'type',
      'sessionId',
      'requestNonce',
      'createdAt',
      'expiresAt',
      'device',
    ]) ||
    value.type !== 'memeloop-local-pairing-request-v2' ||
    !isBoundedTrimmedString(
      value.sessionId,
      PAIRING_MAX_SESSION_ID_LENGTH,
      PAIRING_SESSION_ID_PATTERN,
    ) ||
    !isBoundedTrimmedString(value.requestNonce, 32, PAIRING_NONCE_PATTERN) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.createdAt as number) > now + PAIRING_CLOCK_SKEW_MS ||
    (value.createdAt as number) < now - PAIRING_SESSION_TTL_MS - PAIRING_CLOCK_SKEW_MS ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) <= (value.createdAt as number) ||
    (value.expiresAt as number) - (value.createdAt as number) > PAIRING_SESSION_TTL_MS
  ) return undefined;
  const device = normalizePairingDevice(value.device);
  if (!device) return undefined;
  return {
    type: value.type,
    sessionId: value.sessionId,
    requestNonce: value.requestNonce,
    createdAt: value.createdAt as number,
    expiresAt: value.expiresAt as number,
    device,
  };
}

function isPairingRequest(value: unknown, now = Date.now()): value is PairingRequestMessage {
  return normalizePairingRequest(value, now) !== undefined;
}

function normalizePairingResponse(value: unknown, now: number): PairingResponseMessage | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 7 ||
    !hasOnlyRecordKeys(value, [
      'type',
      'sessionId',
      'requestNonce',
      'responseNonce',
      'accepted',
      'expiresAt',
      'device',
    ]) ||
    value.type !== 'memeloop-local-pairing-response-v2' ||
    !isBoundedTrimmedString(
      value.sessionId,
      PAIRING_MAX_SESSION_ID_LENGTH,
      PAIRING_SESSION_ID_PATTERN,
    ) ||
    !isBoundedTrimmedString(value.requestNonce, 32, PAIRING_NONCE_PATTERN) ||
    !isBoundedTrimmedString(value.responseNonce, 32, PAIRING_NONCE_PATTERN) ||
    value.accepted !== true ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) > now + PAIRING_SESSION_TTL_MS + PAIRING_CLOCK_SKEW_MS
  ) return undefined;
  const device = normalizePairingDevice(value.device);
  if (!device) return undefined;
  return {
    type: value.type,
    sessionId: value.sessionId,
    requestNonce: value.requestNonce,
    responseNonce: value.responseNonce,
    accepted: true,
    expiresAt: value.expiresAt as number,
    device,
  };
}

function isPairingResponse(value: unknown, now = Date.now()): value is PairingResponseMessage {
  return normalizePairingResponse(value, now) !== undefined;
}

async function assertPairingDeviceIdentity(device: PairingDeviceEnvelope): Promise<void> {
  const publicKey = await decodePublicKeyMultibase(device.publicKeyMultibase);
  if (peerIdFromPublicKey(publicKey).toString() !== device.peerId) {
    throw new Error('pairing_public_key_peer_id_mismatch');
  }
}

async function buildPairingConfirmCode(input: {
  initiator: PairingDeviceEnvelope;
  responder: PairingDeviceEnvelope;
  requestNonce: string;
  responseNonce: string;
}): Promise<string> {
  const text = [
    LOCAL_PAIRING_CONFIRMATION_DOMAIN,
    `initiatorPeerId=${input.initiator.peerId}`,
    `initiatorPublicKey=${input.initiator.publicKeyMultibase}`,
    `responderPeerId=${input.responder.peerId}`,
    `responderPublicKey=${input.responder.publicKeyMultibase}`,
    `requestNonce=${input.requestNonce}`,
    `responseNonce=${input.responseNonce}`,
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return (value % 1_000_000).toString().padStart(6, '0');
}

export async function encodePublicKeyMultibase(publicKey: PublicKey): Promise<string> {
  const { publicKeyToProtobuf } = await loadCryptoKeys();
  const { toString } = await loadUint8arrays();
  const protobuf = publicKeyToProtobuf(publicKey);
  return `${PUBLIC_KEY_MULTIBASE_PREFIX}${toString(protobuf, 'base64url')}`;
}

export async function decodePublicKeyMultibase(multibase: string): Promise<PublicKey> {
  if (!multibase.startsWith(PUBLIC_KEY_MULTIBASE_PREFIX)) {
    throw new Error('unsupported_public_key_multibase_prefix');
  }
  const { publicKeyFromProtobuf } = await loadCryptoKeys();
  const { fromString } = await loadUint8arrays();
  const encoded = multibase.slice(PUBLIC_KEY_MULTIBASE_PREFIX.length);
  const protobuf = fromString(encoded, 'base64url');
  return publicKeyFromProtobuf(protobuf);
}

export async function createDeviceIdentity(
  platform: DevicePlatform,
  deviceName: string,
): Promise<RawSeedDeviceIdentity> {
  const { generateKeyPair } = await loadCryptoKeys();
  const { toString } = await loadUint8arrays();
  const privateKey = await generateKeyPair('Ed25519');
  const publicKey = privateKey.publicKey;
  return {
    peerId: peerIdFromPrivateKey(privateKey).toString(),
    publicKeyMultibase: await encodePublicKeyMultibase(publicKey),
    privateKeyRef: 'libp2p-raw-seed',
    privateKeyRawSeedBase64Url: toString(privateKey.raw, 'base64url'),
    createdAt: Date.now(),
    deviceName,
    platform,
  };
}

async function privateKeyFromIdentity(identity: LocalDeviceIdentity): Promise<PrivateKey> {
  if (identity.privateKeyRawSeedBase64Url) {
    const { privateKeyFromRaw } = await loadCryptoKeys();
    const { fromString } = await loadUint8arrays();
    const raw = fromString(identity.privateKeyRawSeedBase64Url, 'base64url');
    return privateKeyFromRaw(raw);
  }
  throw new Error('unsupported_private_key_format');
}

export async function signDeviceBinding(input: {
  identity: LocalDeviceIdentity;
  accountId: string;
  nonce: string;
}): Promise<string> {
  const message = buildDeviceBindingMessage({
    accountId: input.accountId,
    peerId: input.identity.peerId,
    publicKeyMultibase: input.identity.publicKeyMultibase,
    nonce: input.nonce,
  });
  return signDeviceIdentityPayload({ identity: input.identity, payload: message });
}

/**
 * Sign arbitrary portable protocol bytes with a device identity after checking
 * that its raw Ed25519 seed derives both the pinned public key and PeerId.
 *
 * Security boundary: this helper intentionally supports only
 * `privateKeyRawSeedBase64Url`, which materializes the seed in JavaScript
 * memory and is suitable for the existing browser/mobile raw-seed identity
 * path. A host whose `privateKeyRef` points at a keychain, Secure Enclave, or
 * hardware key must inject its own signer and must not export that key here.
 */
export async function signDeviceIdentityPayload(input: {
  identity: LocalDeviceIdentity;
  payload: Uint8Array;
}): Promise<string> {
  const payload = input.payload.slice();
  const { toString } = await loadUint8arrays();
  const privateKey = await privateKeyFromIdentity(input.identity);
  if ((await encodePublicKeyMultibase(privateKey.publicKey)) !== input.identity.publicKeyMultibase) {
    throw new Error('device_identity_public_key_mismatch');
  }
  if (peerIdFromPrivateKey(privateKey).toString() !== input.identity.peerId) {
    throw new Error('device_identity_peer_id_mismatch');
  }
  return toString(await privateKey.sign(payload), 'base64url');
}

/** Backward-compatible pairing name over the generic identity signer. */
export async function signDevicePairingInvitePayload(input: {
  identity: LocalDeviceIdentity;
  payload: Uint8Array;
}): Promise<string> {
  return signDeviceIdentityPayload(input);
}

export async function verifyDevicePairingInviteIdentity(input: {
  invite: DevicePairingInvite;
  payload: Uint8Array;
}): Promise<boolean> {
  try {
    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.invite.publicKeyMultibase);
    if (peerIdFromPublicKey(publicKey).toString() !== input.invite.peerId) return false;
    return await publicKey.verify(input.payload, fromString(input.invite.signature, 'base64url'));
  } catch {
    return false;
  }
}

export async function createSignedDevicePairingInvite(input: {
  identity: LocalDeviceIdentity;
  multiaddrs: string[];
  now?: number;
  ttlMs?: number;
}): Promise<DevicePairingInvite> {
  return createDevicePairingInvite({
    peerId: input.identity.peerId,
    publicKeyMultibase: input.identity.publicKeyMultibase,
    displayName: input.identity.deviceName,
    multiaddrs: input.multiaddrs,
  }, {
    now: input.now,
    ttlMs: input.ttlMs,
    sign: async (payload) =>
      signDevicePairingInvitePayload({
        identity: input.identity,
        payload,
      }),
  });
}

export function parseVerifiedDevicePairingInvite(
  serialized: string,
  options: { now?: number } = {},
): Promise<DevicePairingInvite> {
  return parseDevicePairingInvite(serialized, {
    now: options.now,
    verifyIdentity: verifyDevicePairingInviteIdentity,
  });
}

export async function verifyDeviceBinding(
  input: DeviceAccountBindingRequest & { accountId: string },
): Promise<boolean> {
  try {
    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.publicKeyMultibase);
    if (peerIdFromPublicKey(publicKey).toString() !== input.peerId) {
      return false;
    }
    const message = buildDeviceBindingMessage({
      accountId: input.accountId,
      peerId: input.peerId,
      publicKeyMultibase: input.publicKeyMultibase,
      nonce: input.cloudNonce,
    });
    const signature = fromString(input.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

export async function verifyDeviceConnectionGrant(
  input: DeviceConnectionGrantVerificationInput,
): Promise<boolean> {
  try {
    const now = input.now ?? Date.now();
    const { grant } = input;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (grant.issuer !== 'memeloop-cloud') return false;
    if (!hasCanonicalDeviceConnectionGrantClaims(grant)) return false;
    if (
      !Number.isSafeInteger(grant.issuedAt) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.issuedAt < 0 ||
      grant.expiresAt < 0
    ) return false;
    if (grant.issuedAt > grant.expiresAt) return false;
    if (grant.issuedAt - now > DEVICE_GRANT_MAX_CLOCK_SKEW_MS) return false;
    if (grant.expiresAt <= now) return false;
    if (input.subjectPeerId && grant.subjectPeerId !== input.subjectPeerId) return false;
    if (input.allowedPeerId && !grant.allowedPeerIds.includes(input.allowedPeerId)) return false;

    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.verificationPublicKeyMultibase);
    const message = buildDeviceConnectionGrantMessage({
      issuer: grant.issuer,
      accountId: grant.accountId,
      subjectPeerId: grant.subjectPeerId,
      allowedPeerIds: grant.allowedPeerIds,
      protocols: grant.protocols,
      rpcMethodScope: grant.rpcMethodScope,
      conversationScope: grant.conversationScope,
      definitionScope: grant.definitionScope,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
    const signature = fromString(grant.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

export async function verifyDeviceRelayReservationToken(
  input: DeviceRelayReservationTokenVerificationInput,
): Promise<boolean> {
  try {
    const now = input.now ?? Date.now();
    const { token } = input;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (token.issuer !== 'memeloop-cloud') return false;
    if (!hasCanonicalDeviceRelayReservationTokenClaims(token)) return false;
    if (
      !Number.isSafeInteger(token.issuedAt) ||
      !Number.isSafeInteger(token.expiresAt) ||
      token.issuedAt < 0 ||
      token.expiresAt < 0
    ) return false;
    if (token.issuedAt > token.expiresAt) return false;
    if (token.issuedAt - now > DEVICE_GRANT_MAX_CLOCK_SKEW_MS) return false;
    if (token.expiresAt <= now) return false;
    if (input.peerId && token.peerId !== input.peerId) return false;

    const { fromString } = await loadUint8arrays();
    const publicKey = await decodePublicKeyMultibase(input.verificationPublicKeyMultibase);
    const message = buildDeviceRelayReservationTokenMessage({
      issuer: token.issuer,
      accountId: token.accountId,
      peerId: token.peerId,
      relayMultiaddrs: token.relayMultiaddrs,
      bootstrapMultiaddrs: token.bootstrapMultiaddrs,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
    });
    const signature = fromString(token.signature, 'base64url');
    return await publicKey.verify(message, signature);
  } catch {
    return false;
  }
}

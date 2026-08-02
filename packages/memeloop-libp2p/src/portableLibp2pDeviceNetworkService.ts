import type { Libp2p, PeerId, PrivateKey, PublicKey, Stream } from '@libp2p/interface';
import { peerIdFromPrivateKey, peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';

import {
  ChatSyncEngine,
  computeMissingVersionRanges,
  createDevicePairingInvite,
  createJsonFrameReader,
  encodeJsonFrame,
  encodeJsonFrames,
  isLibp2pRpcRequest,
  isLibp2pRpcResponse,
  isLibp2pSyncRequest,
  JsonFrameError,
  LIBP2P_RPC_REQUEST_TYPE,
  LIBP2P_RPC_RESPONSE_TYPE,
  LIBP2P_SYNC_RESPONSE_TYPE,
  Libp2pDeviceSyncTransport,
  LocalTrustDeviceAuthorizer,
  parseDevicePairingInvite,
  PeerNodeSyncAdapter,
} from 'memeloop/device-network';
import type {
  AttachmentBlobWire,
  ConversationMeta,
  Device,
  DeviceAccountBindingRequest,
  DeviceAuthorizer,
  DeviceCapabilities,
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
  DeviceSyncStateStore,
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
  VersionVector,
} from 'memeloop/device-network';

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
  syncStateStore?: DeviceSyncStateStore;
  rpcHandler?: DeviceRpcHandler;
  orchestrationHandler?: DeviceOrchestrationStreamHandler;
  nodeFactory: Libp2pNodeFactory;
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
const PAIRING_SESSION_TTL_MS = 5 * 60_000;
const PAIRING_MESSAGE_MAX_BYTES = 64 * 1024;
const PAIRING_IDLE_TIMEOUT_MS = 2_000;
const PAIRING_TOTAL_TIMEOUT_MS = 10_000;
const RELAY_ADMISSION_DIAL_TIMEOUT_MS = PAIRING_IDLE_TIMEOUT_MS;
const RELAY_ADMISSION_DIAL_MAX_ATTEMPTS = 3;
const RPC_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
const RPC_IDLE_TIMEOUT_MS = 10_000;
const RPC_TOTAL_TIMEOUT_MS = 30_000;
const SYNC_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
const SYNC_IDLE_TIMEOUT_MS = 15_000;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;
const RELAY_ADMISSION_MESSAGE_MAX_BYTES = 64 * 1024;
const RELAY_ADMISSION_REQUEST_TYPE = 'memeloop-relay-admission-request-v2';
const RELAY_ADMISSION_RESPONSE_TYPE = 'memeloop-relay-admission-response-v2';
const RELAY_RESERVATION_MAX_ATTEMPTS = 3;
const RELAY_RESERVATION_RETRY_DELAY_MS = 25;
const abortedStreams = new WeakSet<Stream>();

function abortLibp2pStreamOnce(stream: Stream, error: Error): void {
  if (abortedStreams.has(stream)) return;
  abortedStreams.add(stream);
  stream.abort(error);
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

interface RelayAdmissionRequestMessage {
  type: typeof RELAY_ADMISSION_REQUEST_TYPE;
  token: DeviceRelayReservationToken;
}

type RelayAdmissionResponseMessage =
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: true; peerId: string; expiresAt: number }
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: false; reason: string };

export class PortableLibp2pDeviceNetworkService implements DeviceNetworkService {
  private libp2p?: Libp2p;
  private readonly capabilities: DeviceCapabilities;
  private readonly discoveredDevices = new Map<string, Device>();
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly bootstrapMultiaddrs = new Set<string>();
  private readonly authorizer: DeviceAuthorizer;
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly listeners = new Set<(devices: Device[]) => void>();
  private readonly pairingListeners = new Set<(sessions: PairingSession[]) => void>();

  constructor(private readonly options: Libp2pDeviceNetworkServiceOptions) {
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
    this.libp2p = await this.createNode();
    this.registerDiscoveryListeners(this.libp2p);
    await this.registerProtocolHandlers(this.libp2p);
    await this.libp2p.start();
    this.emitDevices();
  }

  public async stop(): Promise<void> {
    if (!this.libp2p) return;
    await this.libp2p.stop();
    this.libp2p = undefined;
    this.discoveredDevices.clear();
    this.emitDevices();
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
    const requestNonce = randomPairingNonce();
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_SESSION_TTL_MS;
    const request: PairingRequestMessage = {
      type: 'memeloop-local-pairing-request-v2',
      sessionId: `pairing-${this.options.identity.peerId}-${peerId}-${createdAt}-${requestNonce}`,
      requestNonce,
      createdAt,
      expiresAt,
      device: this.localPairingDevice(),
    };
    const stream = await this.requireNode().dialProtocol(
      this.pairingDialTarget(peerId, options),
      PAIRING_PROTOCOL,
    );
    try {
      await writeJsonMessage(stream, request, PAIRING_MESSAGE_MAX_BYTES);
      const response = await readJsonMessage<PairingResponseMessage>(
        stream,
        PAIRING_MESSAGE_MAX_BYTES,
        PAIRING_IDLE_TIMEOUT_MS,
        PAIRING_TOTAL_TIMEOUT_MS,
      );
      await stream.close();
      const session = await this.sessionFromPairingResponse(peerId, request, response);
      this.pairingSessions.set(session.sessionId, session);
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, response.device);
      this.emitPairingSessions();
      this.emitDevices();
      return session;
    } catch (error) {
      abortLibp2pStreamOnce(
        stream,
        error instanceof Error ? error : new Error('pairing_request_failed'),
      );
      throw error;
    }
  }

  public async acceptPairing(sessionId: string): Promise<void> {
    const session = this.requirePairingSession(sessionId);
    if (session.expiresAt < Date.now()) {
      session.status = 'expired';
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
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<MemeLoopDuplexStream> {
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
    });
    return this.wrapStream(stream);
  }

  public async sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<T> {
    const stream = await this.openStream(peerId, RPC_PROTOCOL, presentedGrant);
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
      if (!response.ok) throw new Error(response.error);
      return response.result as T;
    } catch (error) {
      if (error instanceof JsonFrameError) await stream.abort(error);
      throw error;
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  public async syncWithDevice(
    peerId: string,
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<SyncResult> {
    const authorized = await this.authorizer.canOpenProtocol({
      remotePeerId: peerId,
      protocol: '/memeloop/sync/2.0.0',
      direction: 'outbound',
      presentedGrant,
    });
    if (!authorized) throw new Error('device_not_trusted');
    if (this.options.syncStorage) {
      const transport = new Libp2pDeviceSyncTransport({
        nodeId: this.options.identity.peerId,
        deviceNetwork: this,
        grantProvider: async (remotePeerId) => remotePeerId === peerId ? presentedGrant : undefined,
      });
      const peer = new PeerNodeSyncAdapter(peerId, transport);
      const engine = new ChatSyncEngine({
        nodeId: this.options.identity.peerId,
        storage: this.options.syncStorage,
        peers: () => [peer],
        stateStore: this.requireSyncStateStore(),
      });
      await engine.syncOnce();
    }
    return { ok: true, peerId, syncedAt: Date.now() };
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
    const trustedRecord = this.trustedDevices.get(device.peerId);
    this.discoveredDevices.set(device.peerId, {
      ...device,
      displayName: trustedRecord?.deviceName ?? device.displayName,
      platform: trustedRecord?.platform ?? device.platform,
      trustMode: trustedRecord?.trustMode ?? device.trustMode,
      trusted: device.trusted ?? trustedRecord !== undefined,
      lastSeen: device.lastSeen ?? trustedRecord?.lastSeen,
    });
    this.emitDevices();
  }

  public async configureRelayReservation(token: DeviceRelayReservationToken): Promise<void> {
    for (const address of [...token.bootstrapMultiaddrs, ...token.relayMultiaddrs]) {
      const trimmed = address.trim();
      if (trimmed) this.bootstrapMultiaddrs.add(trimmed);
    }
    if (!this.libp2p) return;
    await this.admitRelayReservation(token);
    await this.reserveRelayListeners(token.relayMultiaddrs);
    await this.dialBootstrapPeers([...this.bootstrapMultiaddrs]);
  }

  public getMultiaddrs(): string[] {
    return this.libp2p?.getMultiaddrs().map((address) => address.toString()) ?? [];
  }

  private async createNode(): Promise<Libp2p> {
    const privateKey = await privateKeyFromIdentity(this.options.identity);
    const listen = this.options.listen ?? defaultListen;
    return await this.options.nodeFactory({
      privateKey,
      listen,
      bootstrapMultiaddrs: [...this.bootstrapMultiaddrs],
      enableCircuitRelay: this.options.enableCircuitRelay !== false,
      enableMdns: this.options.enableMdns !== false,
    });
  }

  private async dialBootstrapPeers(addresses: string[]): Promise<void> {
    const node = this.requireNode();
    for (const address of addresses) {
      await node.dial(multiaddr(address)).catch(() => undefined);
    }
  }

  private async admitRelayReservation(token: DeviceRelayReservationToken): Promise<void> {
    const relayAddresses = token.relayMultiaddrs
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (relayAddresses.length === 0) return;
    const node = this.requireNode();
    const errors: string[] = [];
    for (const address of relayAddresses) {
      let stream: Stream | undefined;
      try {
        stream = await dialRelayAdmissionStream(node, address);
        const request: RelayAdmissionRequestMessage = {
          type: RELAY_ADMISSION_REQUEST_TYPE,
          token,
        };
        await writeJsonMessage(stream, request, RELAY_ADMISSION_MESSAGE_MAX_BYTES);
        const response = await readJsonMessage<RelayAdmissionResponseMessage>(
          stream,
          RELAY_ADMISSION_MESSAGE_MAX_BYTES,
          PAIRING_IDLE_TIMEOUT_MS,
          PAIRING_TOTAL_TIMEOUT_MS,
        );
        await stream.close();
        if (isRelayAdmissionResponse(response) && response.ok) return;
        const reason = isRelayAdmissionResponse(response)
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
      }
    }
    throw new Error(`relay_admission_failed${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);
  }

  private async reserveRelayListeners(relayMultiaddrs: string[]): Promise<void> {
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
        try {
          await transportManager.listen([relayCircuitMultiaddr(address)]);
          return;
        } catch (error) {
          errors.push(
            `${address} (attempt ${attempt}/${RELAY_RESERVATION_MAX_ATTEMPTS}): ${error instanceof Error ? error.message : 'relay_reservation_failed'}`,
          );
          if (attempt < RELAY_RESERVATION_MAX_ATTEMPTS) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, RELAY_RESERVATION_RETRY_DELAY_MS * attempt);
            });
          }
        }
      }
    }
    throw new Error(`relay_reservation_failed${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);
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
    let requestId = 'unknown';
    try {
      const request = await readJsonMessage<unknown>(
        stream,
        RPC_MESSAGE_MAX_BYTES,
        RPC_IDLE_TIMEOUT_MS,
        RPC_TOTAL_TIMEOUT_MS,
      );
      if (!isLibp2pRpcRequest(request)) throw new Error('invalid_rpc_request');
      requestId = request.id;
      const authorized = await this.authorizer.canOpenProtocol({
        remotePeerId,
        protocol: RPC_PROTOCOL,
        direction: 'inbound',
        presentedGrant: request.grant,
      });
      if (!authorized) throw new Error('device_not_trusted');
      if (!this.options.rpcHandler) throw new Error('rpc_handler_not_configured');
      const result = await this.options.rpcHandler({
        remotePeerId,
        method: request.method,
        parameters: request.params,
        presentedGrant: request.grant,
      });
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
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_RPC_RESPONSE_TYPE,
          id: requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'rpc_handler_failed',
        },
        RPC_MESSAGE_MAX_BYTES,
      ).catch(() => undefined);
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  private async handleSyncStream(stream: Stream, remotePeerId: string): Promise<void> {
    let requestId = 'unknown';
    try {
      const request = await readJsonMessage<unknown>(
        stream,
        SYNC_MESSAGE_MAX_BYTES,
        SYNC_IDLE_TIMEOUT_MS,
        SYNC_TOTAL_TIMEOUT_MS,
      );
      if (!isLibp2pSyncRequest(request)) throw new Error('invalid_sync_request');
      requestId = request.id;
      const authorized = await this.authorizer.canOpenProtocol({
        remotePeerId,
        protocol: SYNC_PROTOCOL,
        direction: 'inbound',
        presentedGrant: request.grant,
      });
      if (!authorized) throw new Error('device_not_trusted');
      const result = await this.handleSyncRequest(request);
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
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_SYNC_RESPONSE_TYPE,
          id: requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'sync_handler_failed',
        },
        SYNC_MESSAGE_MAX_BYTES,
      ).catch(() => undefined);
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  private async handleSyncRequest(request: Libp2pSyncRequest): Promise<unknown> {
    const storage = this.options.syncStorage;
    if (!storage) throw new Error('sync_storage_not_configured');
    switch (request.method) {
      case 'exchangeVersionVector': {
        const presentedVersion = versionVectorParameter(request.params, 'localVersion');
        const remoteVersion = await this.currentSyncVersionVector(storage);
        return {
          remoteVersion,
          missingForRemote: computeMissingVersionRanges(remoteVersion, presentedVersion),
          missingForLocal: computeMissingVersionRanges(presentedVersion, remoteVersion),
        };
      }
      case 'pullMissingMetadata': {
        const sinceVersion = versionVectorParameter(request.params, 'sinceVersion');
        const cursor = optionalStringParameter(objectParameter(request.params), 'cursor');
        const offset = decodeMetadataCursor(cursor);
        const pageSize = 100;
        const conversations = await storage.listConversations({ limit: pageSize, offset });
        const items: ConversationMeta[] = [];
        for (const conversation of conversations) {
          const originClock = await conversationOriginClock(storage, conversation);
          const metadata = { ...conversation, originClock };
          if (shouldSendConversation(metadata, sinceVersion)) items.push(metadata);
        }
        return {
          items,
          ...(conversations.length === pageSize
            ? { nextCursor: encodeMetadataCursor(offset + conversations.length) }
            : {}),
        };
      }
      case 'pullMissingMessages': {
        const parameters = objectParameter(request.params);
        const conversationId = stringParameter(parameters, 'conversationId');
        const knownMessageIds = stringArrayParameter(parameters, 'knownMessageIds');
        const messages = await storage.getMessages(conversationId, { mode: 'full-content' });
        const known = new Set(knownMessageIds);
        return messages.filter((message) => !known.has(message.messageId));
      }
      case 'pullAttachmentBlob': {
        const parameters = objectParameter(request.params);
        const contentHash = stringParameter(parameters, 'contentHash');
        return this.readAttachmentBlob(contentHash);
      }
    }
  }

  private async readAttachmentBlob(contentHash: string): Promise<AttachmentBlobWire | null> {
    const storage = this.options.syncStorage;
    if (!storage?.readAttachmentData) return null;
    const reference = await storage.getAttachment(contentHash);
    if (!reference) return null;
    const data = await storage.readAttachmentData(contentHash);
    if (!data) return null;
    const { toString } = await loadUint8arrays();
    return {
      dataBase64Url: toString(data, 'base64url'),
      filename: reference.filename,
      mimeType: reference.mimeType,
      size: reference.size,
    };
  }

  private pairingDialTarget(
    peerId: string,
    options: LocalPairingRequestOptions,
  ): PeerId | ReturnType<typeof multiaddr>[] {
    const addresses = options.multiaddrs ?? this.discoveredDevices.get(peerId)?.multiaddrs ?? [];
    if (addresses.length === 0) return peerIdFromString(peerId);
    return addresses.map((address) => multiaddr(address));
  }

  private localPairingDevice(): PairingDeviceEnvelope {
    return {
      peerId: this.options.identity.peerId,
      publicKeyMultibase: this.options.identity.publicKeyMultibase,
      deviceName: this.options.identity.deviceName,
      platform: this.options.identity.platform,
      capabilities: this.capabilities,
      multiaddrs: this.getMultiaddrs(),
    };
  }

  private async handlePairingStream(stream: Stream, remotePeerId: string): Promise<void> {
    const request = await readJsonMessage<PairingRequestMessage>(
      stream,
      PAIRING_MESSAGE_MAX_BYTES,
      PAIRING_IDLE_TIMEOUT_MS,
      PAIRING_TOTAL_TIMEOUT_MS,
    );
    if (!isPairingRequest(request)) throw new Error('invalid_pairing_request');
    if (request.device.peerId !== remotePeerId) throw new Error('pairing_peer_id_mismatch');
    if (request.expiresAt <= Date.now()) throw new Error('pairing_request_expired');
    await assertPairingDeviceIdentity(request.device);
    const responseNonce = randomPairingNonce();
    const localDevice = this.localPairingDevice();
    const expiresAt = Math.min(request.expiresAt, Date.now() + PAIRING_SESSION_TTL_MS);
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
    this.pairingSessions.set(session.sessionId, session);
    this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, request.device);
    await writeJsonMessage(stream, {
      type: 'memeloop-local-pairing-response-v2',
      sessionId: request.sessionId,
      requestNonce: request.requestNonce,
      responseNonce,
      accepted: true,
      expiresAt,
      device: localDevice,
    });
    await stream.close();
    this.emitPairingSessions();
    this.emitDevices();
  }

  private async sessionFromPairingResponse(
    peerId: string,
    request: PairingRequestMessage,
    response: PairingResponseMessage,
  ): Promise<PairingSession> {
    if (!isPairingResponse(response)) throw new Error('invalid_pairing_response');
    if (response.sessionId !== request.sessionId) throw new Error('pairing_session_mismatch');
    if (response.requestNonce !== request.requestNonce) throw new Error('pairing_nonce_mismatch');
    if (response.device.peerId !== peerId) throw new Error('pairing_peer_id_mismatch');
    if (response.expiresAt <= Date.now()) throw new Error('pairing_response_expired');
    await assertPairingDeviceIdentity(response.device);
    return {
      sessionId: request.sessionId,
      localPeerId: this.options.identity.peerId,
      remotePeerId: response.device.peerId,
      remotePublicKeyMultibase: response.device.publicKeyMultibase,
      remoteDeviceName: response.device.deviceName,
      remotePlatform: response.device.platform,
      remoteCapabilities: response.device.capabilities,
      remoteMultiaddrs: response.device.multiaddrs,
      direction: 'outbound',
      status: 'pending',
      confirmCode: await buildPairingConfirmCode({
        initiator: request.device,
        responder: response.device,
        requestNonce: request.requestNonce,
        responseNonce: response.responseNonce,
      }),
      createdAt: request.createdAt,
      expiresAt: Math.min(request.expiresAt, response.expiresAt),
    };
  }

  private requirePairingSession(sessionId: string): PairingSession {
    const session = this.pairingSessions.get(sessionId);
    if (!session) throw new Error('pairing_session_not_found');
    return session;
  }

  private refreshPairingSessionExpiry(): void {
    const now = Date.now();
    let changed = false;
    for (const session of this.pairingSessions.values()) {
      if (session.status === 'pending' && session.expiresAt <= now) {
        session.status = 'expired';
        changed = true;
      }
    }
    if (changed) this.emitPairingSessions();
  }

  private upsertDiscoveredDeviceFromPairing(peerId: string, device: PairingDeviceEnvelope): void {
    const current = this.discoveredDevices.get(peerId);
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

  private wrapStream(stream: Stream): MemeLoopDuplexStream {
    return {
      source: this.streamSource(stream),
      async sink(source) {
        for await (const chunk of source) {
          stream.send(chunk);
        }
        await stream.close();
      },
      close: async () => {
        await stream.close();
      },
      abort: (error) => {
        abortLibp2pStreamOnce(stream, error);
      },
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
          trusted: !record.revokedAt,
          lastSeen: current.lastSeen ?? record.lastSeen,
        });
        continue;
      }
      if (record.revokedAt) continue;
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

  private requireSyncStateStore(): DeviceSyncStateStore {
    if (!this.options.syncStateStore) throw new Error('sync_state_store_not_configured');
    return this.options.syncStateStore;
  }

  private async currentSyncVersionVector(storage: IAgentStorage): Promise<VersionVector> {
    const stateStore = this.requireSyncStateStore();
    const versionVector = await stateStore.loadVersionVector();
    const pageSize = 100;
    let offset = 0;
    let changed = false;
    for (;;) {
      const conversations = await storage.listConversations({ limit: pageSize, offset });
      for (const conversation of conversations) {
        const originClock = await conversationOriginClock(storage, conversation);
        const current = versionVector[conversation.originNodeId] ?? 0;
        if (originClock > current) {
          versionVector[conversation.originNodeId] = originClock;
          changed = true;
        }
      }
      if (conversations.length < pageSize) break;
      offset += conversations.length;
    }
    if (changed) await stateStore.saveVersionVector(versionVector);
    return versionVector;
  }
}

async function dialRelayAdmissionStream(node: Libp2p, address: string): Promise<Stream> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= RELAY_ADMISSION_DIAL_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('relay_admission_dial_timeout'));
    }, RELAY_ADMISSION_DIAL_TIMEOUT_MS);
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
    try {
      return await node.dialProtocol(multiaddr(address), RELAY_ADMISSION_PROTOCOL, {
        signal: controller.signal,
      });
    } catch (error) {
      errors.push(
        `attempt ${attempt}/${RELAY_ADMISSION_DIAL_MAX_ATTEMPTS}: ${error instanceof Error ? error.message : 'relay_admission_dial_failed'}`,
      );
    } finally {
      clearTimeout(timeout);
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
      listen(addresses: Multiaddr[]): Promise<void>;
    };
  };
}

const PUBLIC_KEY_MULTIBASE_PREFIX = 'libp2p-pub:';

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
  maxBytes = PAIRING_MESSAGE_MAX_BYTES,
): Promise<void> {
  stream.send(encodeJsonFrame(message, maxBytes));
}

async function readJsonMessage<T>(
  stream: Stream,
  maxBytes = PAIRING_MESSAGE_MAX_BYTES,
  idleTimeoutMs = PAIRING_IDLE_TIMEOUT_MS,
  totalTimeoutMs = PAIRING_TOTAL_TIMEOUT_MS,
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
    abort: (error) => {
      abortLibp2pStreamOnce(stream, error);
    },
  })[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done) throw new Error('json_message_missing');
  void reader.return?.();
  return result.value as T;
}

async function writeStreamJson(
  stream: MemeLoopDuplexStream,
  message: unknown,
  maxBytes = RPC_MESSAGE_MAX_BYTES,
): Promise<void> {
  await stream.sink(encodeJsonFrames([message], maxBytes));
}

async function readStreamJson(
  stream: MemeLoopDuplexStream,
  maxBytes = RPC_MESSAGE_MAX_BYTES,
  idleTimeoutMs = RPC_IDLE_TIMEOUT_MS,
  totalTimeoutMs = RPC_TOTAL_TIMEOUT_MS,
): Promise<unknown> {
  const reader = createJsonFrameReader(stream.source, {
    maxPayloadBytes: maxBytes,
    idleTimeoutMs,
    totalTimeoutMs,
    abort: (error) => stream.abort(error),
  })[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done) throw new Error('rpc_response_missing');
  void reader.return?.();
  return result.value;
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

function objectParameter(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_sync_params');
  }
  return value as Record<string, unknown>;
}

function stringParameter(parameters: Record<string, unknown>, key: string): string {
  const value = parameters[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_sync_params');
  return value;
}

function optionalStringParameter(
  parameters: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('invalid_sync_params');
  return value;
}

function stringArrayParameter(parameters: Record<string, unknown>, key: string): string[] {
  const value = parameters[key];
  if (!Array.isArray(value)) throw new Error('invalid_sync_params');
  return value.filter((item): item is string => typeof item === 'string');
}

function versionVectorParameter(parameters: unknown, key: string): VersionVector {
  const raw = objectParameter(parameters)[key];
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid_sync_params');
  }
  const version: VersionVector = {};
  for (const [nodeId, clock] of Object.entries(raw)) {
    if (typeof clock === 'number' && Number.isFinite(clock) && clock >= 0) version[nodeId] = clock;
  }
  return version;
}

function shouldSendConversation(
  conversation: ConversationMeta,
  sinceVersion: VersionVector,
): boolean {
  return (sinceVersion[conversation.originNodeId] ?? 0) < (conversation.originClock ?? 0);
}

function encodeMetadataCursor(offset: number): string {
  return offset.toString(36);
}

function decodeMetadataCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9a-z]+$/.test(cursor)) throw new Error('invalid_sync_cursor');
  const offset = Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_sync_cursor');
  return offset;
}

async function conversationOriginClock(
  storage: IAgentStorage,
  conversation: ConversationMeta,
): Promise<number> {
  if (
    typeof conversation.originClock === 'number' &&
    Number.isSafeInteger(conversation.originClock) &&
    conversation.originClock >= 0
  ) return conversation.originClock;
  return storage.getMaxLamportClockForConversation?.(conversation.conversationId) ?? 0;
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'desktop' || value === 'mobile' || value === 'cli';
}

function normalizePairingCapabilities(value: unknown): DeviceCapabilities {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<DeviceCapabilities>)
    : {};
  return {
    tools: Array.isArray(raw.tools)
      ? raw.tools.filter((item): item is string => typeof item === 'string')
      : [],
    mcpServers: Array.isArray(raw.mcpServers)
      ? raw.mcpServers.filter((item): item is string => typeof item === 'string')
      : [],
    hasWiki: raw.hasWiki === true,
    agentLoop: raw.agentLoop === true,
    imChannels: Array.isArray(raw.imChannels)
      ? raw.imChannels.filter((item): item is string => typeof item === 'string')
      : [],
    wikis: Array.isArray(raw.wikis)
      ? raw.wikis.filter(
        (item): item is DeviceCapabilities['wikis'][number] => item !== null && typeof item === 'object',
      )
      : [],
  };
}

function normalizePairingDevice(value: unknown): PairingDeviceEnvelope | undefined {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  if (!raw) return undefined;
  const peerId = typeof raw.peerId === 'string' ? raw.peerId.trim() : '';
  const publicKeyMultibase = typeof raw.publicKeyMultibase === 'string' ? raw.publicKeyMultibase.trim() : '';
  const deviceName = typeof raw.deviceName === 'string' ? raw.deviceName.trim() : '';
  if (!peerId || !publicKeyMultibase || !deviceName || !isDevicePlatform(raw.platform)) {
    return undefined;
  }
  return {
    peerId,
    publicKeyMultibase,
    deviceName,
    platform: raw.platform,
    capabilities: normalizePairingCapabilities(raw.capabilities),
    multiaddrs: Array.isArray(raw.multiaddrs)
      ? raw.multiaddrs.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function isPairingRequest(value: unknown): value is PairingRequestMessage {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  if (!raw || raw.type !== 'memeloop-local-pairing-request-v2') return false;
  return (
    typeof raw.sessionId === 'string' &&
    typeof raw.requestNonce === 'string' &&
    typeof raw.createdAt === 'number' &&
    typeof raw.expiresAt === 'number' &&
    normalizePairingDevice(raw.device) !== undefined
  );
}

function isPairingResponse(value: unknown): value is PairingResponseMessage {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  if (!raw || raw.type !== 'memeloop-local-pairing-response-v2') return false;
  return (
    typeof raw.sessionId === 'string' &&
    typeof raw.requestNonce === 'string' &&
    typeof raw.responseNonce === 'string' &&
    raw.accepted === true &&
    typeof raw.expiresAt === 'number' &&
    normalizePairingDevice(raw.device) !== undefined
  );
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
    'memeloop-local-pairing-confirm-v1',
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

export function buildDeviceBindingMessage(input: {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  nonce: string;
}): Uint8Array {
  const message = [
    'memeloop-device-binding-v1',
    `accountId=${input.accountId}`,
    `peerId=${input.peerId}`,
    `publicKey=${input.publicKeyMultibase}`,
    `nonce=${input.nonce}`,
  ].join('\n');
  return new TextEncoder().encode(message);
}

export function buildDeviceConnectionGrantMessage(
  grant: Omit<DeviceConnectionGrant, 'signature'>,
): Uint8Array {
  const message = [
    'memeloop-device-connection-grant-v1',
    `issuer=${grant.issuer}`,
    `accountId=${grant.accountId}`,
    `subjectPeerId=${grant.subjectPeerId}`,
    `allowedPeerIds=${grant.allowedPeerIds.join(',')}`,
    `issuedAt=${grant.issuedAt}`,
    `expiresAt=${grant.expiresAt}`,
  ].join('\n');
  return new TextEncoder().encode(message);
}

export function buildDeviceRelayReservationTokenMessage(
  token: Omit<DeviceRelayReservationToken, 'signature'>,
): Uint8Array {
  const message = [
    'memeloop-device-relay-admission-v1',
    `issuer=${token.issuer}`,
    `accountId=${token.accountId}`,
    `peerId=${token.peerId}`,
    `relayMultiaddrs=${token.relayMultiaddrs.join(',')}`,
    `bootstrapMultiaddrs=${token.bootstrapMultiaddrs.join(',')}`,
    `issuedAt=${token.issuedAt}`,
    `expiresAt=${token.expiresAt}`,
  ].join('\n');
  return new TextEncoder().encode(message);
}

export async function signDeviceBinding(input: {
  identity: LocalDeviceIdentity;
  accountId: string;
  nonce: string;
}): Promise<string> {
  const { toString } = await loadUint8arrays();
  const privateKey = await privateKeyFromIdentity(input.identity);
  const publicKey = privateKey.publicKey;
  if ((await encodePublicKeyMultibase(publicKey)) !== input.identity.publicKeyMultibase) {
    throw new Error('device_identity_public_key_mismatch');
  }
  if (peerIdFromPrivateKey(privateKey).toString() !== input.identity.peerId) {
    throw new Error('device_identity_peer_id_mismatch');
  }
  const message = buildDeviceBindingMessage({
    accountId: input.accountId,
    peerId: input.identity.peerId,
    publicKeyMultibase: input.identity.publicKeyMultibase,
    nonce: input.nonce,
  });
  const signature = await privateKey.sign(message);
  return toString(signature, 'base64url');
}

export async function signDevicePairingInvitePayload(input: {
  identity: LocalDeviceIdentity;
  payload: Uint8Array;
}): Promise<string> {
  const { toString } = await loadUint8arrays();
  const privateKey = await privateKeyFromIdentity(input.identity);
  if ((await encodePublicKeyMultibase(privateKey.publicKey)) !== input.identity.publicKeyMultibase) {
    throw new Error('device_identity_public_key_mismatch');
  }
  if (peerIdFromPrivateKey(privateKey).toString() !== input.identity.peerId) {
    throw new Error('device_identity_peer_id_mismatch');
  }
  return toString(await privateKey.sign(input.payload), 'base64url');
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
    if (grant.issuer !== 'memeloop-cloud') return false;
    if (grant.issuedAt > grant.expiresAt) return false;
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
    if (token.issuer !== 'memeloop-cloud') return false;
    if (token.issuedAt > token.expiresAt) return false;
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

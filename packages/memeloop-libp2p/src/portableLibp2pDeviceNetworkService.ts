import type { Libp2p, PeerId, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type {
  Device,
  DeviceAuthorizer,
  DeviceCapabilities,
  DeviceCloudCommitFence,
  DeviceConnectionGrant,
  DeviceNetworkService,
  DeviceRelayReservationToken,
  DeviceStreamOptions,
  DeviceSyncOptions,
  LocalPairingRequestOptions,
  MemeLoopDuplexStream,
  MemeLoopProtocol,
  PairingSession,
  SyncResult,
  TrustedDeviceRecord,
} from 'memeloop/device-network/portable';
import { ChatSyncEngine, Libp2pDeviceSyncTransport, LocalTrustDeviceAuthorizer, PeerNodeSyncAdapter } from 'memeloop/device-network/portable';
import { defaultListen, emptyCapabilities } from './network/deviceDefaults.js';
import { privateKeyFromIdentity } from './network/deviceIdentity.js';
import { strictPairingMultiaddrs, strictPeerBoundMultiaddrs } from './network/networkAddresses.js';
import type { Libp2pDeviceNetworkServiceOptions } from './network/networkTypes.js';
import { PairingCoordinator } from './network/pairingCoordinator.js';
import { sendRpc, syncWithDevice } from './network/peerRequests.js';
import { ORCHESTRATION_PROTOCOL, PAIRING_PROTOCOL, RPC_PROTOCOL, SYNC_PROTOCOL } from './network/protocolConstants.js';
import { RelayReservationManager } from './network/relayReservationManager.js';
import type { VerifiedRelayReservation } from './network/relayTypes.js';
import { validateRelayReservationVerificationOptions } from './network/relayValidation.js';
import { handleRpcStream } from './network/rpcStreamHandler.js';
import { abortLibp2pStreamOnce, abortSignalError, wrapStream } from './network/streamIO.js';
import { handleSyncStream } from './network/syncStreamHandler.js';

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
export {
  createDeviceIdentity,
  createSignedDevicePairingInvite,
  decodePublicKeyMultibase,
  encodePublicKeyMultibase,
  parseVerifiedDevicePairingInvite,
  signDeviceBinding,
  signDeviceIdentityPayload,
  verifyDeviceBinding,
  verifyDeviceConnectionGrant,
  verifyDevicePairingInviteIdentity,
  verifyDeviceRelayReservationToken,
} from './network/deviceIdentity.js';
export type { RawSeedDeviceIdentity } from './network/deviceIdentity.js';
export type {
  DeviceRpcRunGrantResources,
  Libp2pDeviceNetworkServiceOptions,
  Libp2pNodeFactory,
  Libp2pNodeFactoryOptions,
  RelayReservationVerificationOptions,
} from './network/networkTypes.js';
export { LOCAL_PAIRING_CONFIRMATION_DOMAIN } from './network/pairingMessages.js';
export {
  DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS,
  DEFAULT_RELAY_RESERVATION_TTL_MS,
  DEVICE_SYNC_MAX_PASSES,
  LIBP2P_DEVICE_NETWORK_FRAME_LIMITS,
} from './network/protocolConstants.js';
export { resolveRelayTransportManager } from './network/relayTransport.js';
export type { Libp2pRelayTransportManager } from './network/relayTransport.js';

export class PortableLibp2pDeviceNetworkService implements DeviceNetworkService {
  private readonly pairing: PairingCoordinator;
  private readonly relay: RelayReservationManager;
  private libp2p?: Libp2p;

  private readonly capabilities: DeviceCapabilities;

  private readonly discoveredDevices = new Map<string, Device>();

  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();

  private readonly explicitPairingAddresses = new Map<string, string[]>();

  private readonly bootstrapMultiaddrs = new Set<string>();

  private readonly authorizer: DeviceAuthorizer;

  private readonly listeners = new Set<(devices: Device[]) => void>();

  private readonly cloudDirectoryAddresses = new Map<string, string[]>();

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
    this.pairing = new PairingCoordinator({
      options,
      capabilities: this.capabilities,
      trustedDevices: this.trustedDevices,
      discoveredDevices: this.discoveredDevices,
      explicitPairingAddresses: this.explicitPairingAddresses,
      requireNode: () => this.requireNode(),
      getMultiaddrs: () => this.getMultiaddrs(),
      rememberConnectedPairingAddress: peerId => {
        this.rememberConnectedPairingAddress(peerId);
      },
      updateDeviceTrust: (peerId, mode, trusted) => {
        this.updateDeviceTrust(peerId, mode, trusted);
      },
      emitDevices: () => {
        this.emitDevices();
      },
    });
    this.relay = new RelayReservationManager({ options, getNode: () => this.libp2p, requireNode: () => this.requireNode() });
  }

  public async start(): Promise<void> {
    if (this.libp2p) return;
    await this.loadTrustedDevicesFromStore();
    const relayReservation = this.relay.currentVerifiedRelayReservation();
    this.libp2p = await this.createNode(relayReservation);
    this.registerDiscoveryListeners(this.libp2p);
    await this.registerProtocolHandlers(this.libp2p);
    try {
      await this.libp2p.start();
      // Restored invitations are already peer-bound trusted destinations.
      // Bootstrap discovery is asynchronous; the first RPC must not depend on it.
      const restoredAddresses = new Map<string, string[]>();
      for (const address of this.bootstrapMultiaddrs) {
        const parsed = multiaddr(address);
        const destination = parsed.getComponents().at(-1);
        if (destination?.name !== 'p2p' || !destination.value) continue;
        const trusted = this.trustedDevices.get(destination.value);
        if (!trusted || trusted.revokedAt !== undefined) continue;
        const addresses = restoredAddresses.get(destination.value) ?? [];
        addresses.push(parsed.toString());
        restoredAddresses.set(destination.value, addresses);
      }
      for (const [peerId, addresses] of restoredAddresses) {
        await this.libp2p.peerStore.merge(peerIdFromString(peerId), { multiaddrs: addresses.map(address => multiaddr(address)) });
        this.explicitPairingAddresses.set(peerId, addresses);
      }
      if (relayReservation) {
        const effects = await this.relay.applyRelayReservation(
          relayReservation,
          relayReservation.fence.signal,
          relayReservation.fence,
        );
        relayReservation.fence.commitSynchronous(() => {
          this.relay.retainEffects(effects);
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
      this.relay.resetEffects();
      this.pairing.reset();
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

  public listPairingSessions(): Promise<PairingSession[]> {
    return this.pairing.listPairingSessions();
  }

  public observePairingSessions(listener: (sessions: PairingSession[]) => void): () => void {
    return this.pairing.observePairingSessions(listener);
  }

  public requestLocalPairing(peerId: string, options: LocalPairingRequestOptions = {}): Promise<PairingSession> {
    return this.pairing.requestLocalPairing(peerId, options);
  }

  public acceptPairing(sessionId: string): Promise<void> {
    return this.pairing.acceptPairing(sessionId);
  }

  public rejectPairing(sessionId: string): Promise<void> {
    return this.pairing.rejectPairing(sessionId);
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    this.trustedDevices.delete(peerId);
    this.explicitPairingAddresses.delete(peerId);
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
    const node = this.requireNode();
    const targetPeer = peerIdFromString(peerId);
    const addresses = [
      ...new Set([
        ...(this.explicitPairingAddresses.get(peerId) ?? []),
        ...(this.discoveredDevices.get(peerId)?.multiaddrs ?? []),
      ]),
    ];
    if (addresses.length > 0) {
      await node.peerStore.merge(targetPeer, { multiaddrs: addresses.map((address) => multiaddr(address)) });
    }
    signal?.throwIfAborted();
    // Discovery may report raw transport addresses. Dial by the authorized
    // identity so libp2p reuses its connection and retains other known routes.
    const dialOptions = {
      runOnLimitedConnection: true,
      ...(signal ? { signal } : {}),
    };
    let stream: Stream;
    try {
      stream = await node.dialProtocol(targetPeer, protocol, dialOptions);
    } catch (error) {
      const retainedAddresses = this.explicitPairingAddresses.get(peerId) ?? [];
      if (!(error instanceof Error) || error.name !== 'NoValidAddressesError' || retainedAddresses.length === 0) throw error;
      signal?.throwIfAborted();
      // libp2p preserves an address's original observed timestamp when merging
      // it again. After its one-hour expiry, peer-id dialing can therefore see
      // no addresses even after the merge above. Retained pairing routes remain
      // explicitly bound to the authorized Noise identity and can be dialed
      // directly without resetting peer-store metadata or extending trust.
      stream = await node.dialProtocol(
        strictPairingMultiaddrs(peerId, retainedAddresses).map(address => multiaddr(address)),
        protocol,
        dialOptions,
      );
    }
    this.rememberConnectedPairingAddress(peerId);
    if (signal?.aborted) {
      abortLibp2pStreamOnce(stream, abortSignalError(signal));
      signal.throwIfAborted();
    }
    return wrapStream(stream, signal);
  }

  public async sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    options: DeviceStreamOptions = {},
  ): Promise<T> {
    return sendRpc<T>(this, peerId, method, parameters, options);
  }

  public async syncWithDevice(
    peerId: string,
    options: DeviceSyncOptions = {},
  ): Promise<SyncResult> {
    return syncWithDevice(
      {
        authorizer: this.authorizer,
        storage: this.options.syncStorage,
        createDeviceSyncEngine: (id, grant, ids) => this.createDeviceSyncEngine(id, grant, ids),
      },
      peerId,
      options,
    );
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
   * target PeerId. openStream merges these into the peer store before dialing
   * that identity, so browser hosts do not depend on mDNS or a DHT.
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

  public configureRelayReservation(token: DeviceRelayReservationToken, signal: AbortSignal, fence: DeviceCloudCommitFence): Promise<void> {
    return this.relay.configureRelayReservation(token, signal, fence);
  }

  public clearRelayReservation(signal?: AbortSignal): Promise<void> {
    return this.relay.clearRelayReservation(signal);
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
      isPreferredDialAddress: address => {
        const peerId = multiaddr(address).getComponents().at(-1)?.value;
        if (!peerId) return false;
        const preferred = this.explicitPairingAddresses.get(peerId)?.[0];
        return preferred !== undefined &&
          preferred.replace(/\/p2p\/[^/]+$/u, '') === address.replace(/\/p2p\/[^/]+$/u, '');
      },
      isExplicitDialAddress: address => {
        const transportAddress = (value: string) => value.replace(/\/p2p\/[^/]+$/u, '');
        const target = transportAddress(address);
        for (const addresses of this.explicitPairingAddresses.values()) {
          if (addresses.some(value => transportAddress(value) === target)) return true;
        }
        for (const peerId of this.trustedDevices.keys()) {
          if (this.discoveredDevices.get(peerId)?.multiaddrs?.some(value => transportAddress(value) === target)) return true;
        }
        return false;
      },
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
          await this.pairing.handlePairingStream(stream, remotePeerId).catch((error: unknown) => {
            abortLibp2pStreamOnce(
              stream,
              error instanceof Error ? error : new Error('pairing_handler_failed'),
            );
          });
          return;
        }
        if (stream.protocol === SYNC_PROTOCOL) {
          await handleSyncStream({ authorizer: this.authorizer, storage: this.options.syncStorage }, stream, remotePeerId);
          return;
        }
        if (stream.protocol === RPC_PROTOCOL) {
          await handleRpcStream({ authorizer: this.authorizer, options: this.options }, stream, remotePeerId);
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
              stream: wrapStream(stream),
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

  private markPeerOnline(peerId: PeerId): void {
    const id = peerId.toString();
    this.rememberConnectedPairingAddress(id);
    const current = this.discoveredDevices.get(id);
    if (current) {
      current.reachability = { state: 'online', paths: current.reachability.paths };
      current.lastSeen = Date.now();
      this.emitDevices();
    }
  }

  private rememberConnectedPairingAddress(peerId: string): void {
    const retained = this.explicitPairingAddresses.get(peerId);
    if (!retained) return;
    const connection = this.libp2p?.getConnections(peerIdFromString(peerId))
      .find(connection => connection.direction === 'outbound' && connection.status === 'open');
    if (!connection) return;
    const address = connection.remoteAddr.toString();
    this.explicitPairingAddresses.set(peerId, [address, ...retained.filter(value => value !== address)]);
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

  private requireNode(): Libp2p {
    if (!this.libp2p) throw new Error('device_network_not_started');
    return this.libp2p;
  }
}

import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import type { Libp2p, PeerId, PrivateKey, PublicKey, Stream } from '@libp2p/interface';
import { mdns } from '@libp2p/mdns';
import { peerIdFromPrivateKey, peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';

import { LocalTrustDeviceAuthorizer } from './localTrustDeviceAuthorizer.js';
import type {
  Device,
  DeviceAccountBindingRequest,
  DeviceAuthorizer,
  DeviceCapabilities,
  DeviceConnectionGrant,
  DeviceConnectionGrantVerificationInput,
  DeviceNetworkListenOptions,
  DeviceNetworkService,
  DevicePlatform,
  DeviceTrustStore,
  LocalDeviceIdentity,
  LocalPairingRequestOptions,
  MemeLoopDuplexStream,
  MemeLoopProtocol,
  PairingSession,
  SyncResult,
  TrustedDeviceRecord,
} from './types.js';

export interface Libp2pDeviceNetworkServiceOptions {
  identity: LocalDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustedDevices?: TrustedDeviceRecord[];
  trustStore?: DeviceTrustStore;
  authorizer?: DeviceAuthorizer;
  listen?: DeviceNetworkListenOptions;
  enableMdns?: boolean;
  autoDialDiscoveredPeers?: boolean;
}

const emptyCapabilities: DeviceCapabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  imChannels: [],
  wikis: [],
};

const defaultListen: DeviceNetworkListenOptions = {
  addresses: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
};

const PAIRING_PROTOCOL: MemeLoopProtocol = '/memeloop/pairing/1.0.0';
const PAIRING_SESSION_TTL_MS = 5 * 60_000;
const PAIRING_MESSAGE_MAX_BYTES = 64 * 1024;

interface PairingDeviceEnvelope {
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: DevicePlatform;
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
}

interface PairingRequestMessage {
  type: 'memeloop-local-pairing-request-v1';
  sessionId: string;
  requestNonce: string;
  createdAt: number;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

interface PairingResponseMessage {
  type: 'memeloop-local-pairing-response-v1';
  sessionId: string;
  requestNonce: string;
  responseNonce: string;
  accepted: true;
  expiresAt: number;
  device: PairingDeviceEnvelope;
}

export class Libp2pDeviceNetworkService implements DeviceNetworkService {
  private libp2p?: Libp2p;
  private readonly capabilities: DeviceCapabilities;
  private readonly discoveredDevices = new Map<string, Device>();
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly authorizer: DeviceAuthorizer;
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly listeners = new Set<(devices: Device[]) => void>();
  private readonly pairingListeners = new Set<(sessions: PairingSession[]) => void>();

  constructor(private readonly options: Libp2pDeviceNetworkServiceOptions) {
    this.capabilities = options.capabilities ?? emptyCapabilities;
    for (const record of options.trustedDevices ?? []) {
      this.trustedDevices.set(record.peerId, record);
    }
    this.authorizer = options.authorizer ?? new LocalTrustDeviceAuthorizer({
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
    return [...this.discoveredDevices.values()];
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

  public async requestLocalPairing(peerId: string, options: LocalPairingRequestOptions = {}): Promise<PairingSession> {
    const requestNonce = randomPairingNonce();
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_SESSION_TTL_MS;
    const request: PairingRequestMessage = {
      type: 'memeloop-local-pairing-request-v1',
      sessionId: `pairing-${this.options.identity.peerId}-${peerId}-${createdAt}-${requestNonce}`,
      requestNonce,
      createdAt,
      expiresAt,
      device: this.localPairingDevice(),
    };
    const stream = await this.requireNode().dialProtocol(this.pairingDialTarget(peerId, options), PAIRING_PROTOCOL);
    try {
      await writeJsonMessage(stream, request);
      const response = await readJsonMessage<PairingResponseMessage>(stream);
      await stream.close();
      const session = await this.sessionFromPairingResponse(peerId, request, response);
      this.pairingSessions.set(session.sessionId, session);
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, response.device);
      this.emitPairingSessions();
      this.emitDevices();
      return session;
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error('pairing_request_failed'));
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
    this.updateDeviceTrust(session.remotePeerId, 'local-pairing');
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
    this.updateDeviceTrust(peerId, 'local-pairing');
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
    const stream = await this.requireNode().dialProtocol(peerIdFromString(peerId), protocol);
    return this.wrapStream(stream);
  }

  public async sendRpc<T>(
    peerId: string,
    method: string,
    parameters: unknown,
    presentedGrant?: DeviceConnectionGrant,
  ): Promise<T> {
    const stream = await this.openStream(peerId, '/memeloop/rpc/1.0.0', presentedGrant);
    const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: parameters }));
    await stream.sink(async function*() {
      yield payload;
    }());
    throw new Error('rpc_response_reader_not_implemented');
  }

  public async syncWithDevice(peerId: string, presentedGrant?: DeviceConnectionGrant): Promise<SyncResult> {
    const authorized = await this.authorizer.canOpenProtocol({
      remotePeerId: peerId,
      protocol: '/memeloop/sync/1.0.0',
      direction: 'outbound',
      presentedGrant,
    });
    if (!authorized) throw new Error('device_not_trusted');
    return { ok: true, peerId, syncedAt: Date.now() };
  }

  public getTrustedDevice(peerId: string): TrustedDeviceRecord | undefined {
    return this.trustedDevices.get(peerId);
  }

  public upsertDiscoveredDevice(device: Device): void {
    this.discoveredDevices.set(device.peerId, device);
    this.emitDevices();
  }

  public getMultiaddrs(): string[] {
    return this.libp2p?.getMultiaddrs().map((address) => address.toString()) ?? [];
  }

  private async createNode(): Promise<Libp2p> {
    const privateKey = await privateKeyFromIdentity(this.options.identity);
    const listen = this.options.listen ?? defaultListen;
    return createLibp2p({
      privateKey,
      addresses: {
        listen: listen.addresses,
        announce: listen.announce,
      },
      transports: [tcp(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: this.options.enableMdns === false ? [] : [mdns({ serviceTag: 'memeloop' })],
      services: {
        identify: identify(),
        ping: ping(),
      },
      start: false,
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
      this.discoveredDevices.set(peerId, {
        peerId,
        displayName: peerId,
        platform: 'cli',
        trustMode: this.trustedDevices.has(peerId) ? 'local-pairing' : 'local-pairing',
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
      '/memeloop/pairing/1.0.0',
      '/memeloop/rpc/1.0.0',
      '/memeloop/sync/1.0.0',
      '/memeloop/agent/1.0.0',
    ];
    await node.handle(protocols, async (stream, connection) => {
      const remotePeerId = connection.remotePeer.toString();
      if (!await this.authorizer.canOpenProtocol({ remotePeerId, protocol: stream.protocol as MemeLoopProtocol, direction: 'inbound' })) {
        stream.abort(new Error('device_not_trusted'));
        return;
      }
      if (stream.protocol === PAIRING_PROTOCOL) {
        await this.handlePairingStream(stream, remotePeerId).catch((error: unknown) => {
          stream.abort(error instanceof Error ? error : new Error('pairing_handler_failed'));
        });
        return;
      }
      stream.abort(new Error('protocol_handler_not_registered'));
    });
  }

  private pairingDialTarget(peerId: string, options: LocalPairingRequestOptions): PeerId | ReturnType<typeof multiaddr>[] {
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
    const request = await readJsonMessage<PairingRequestMessage>(stream);
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
      type: 'memeloop-local-pairing-response-v1',
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

  private updateDeviceTrust(peerId: string, trustMode: Device['trustMode']): void {
    const current = this.discoveredDevices.get(peerId);
    if (current) current.trustMode = trustMode;
  }

  private emitDevices(): void {
    const devices = [...this.discoveredDevices.values()];
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

export interface RawSeedDeviceIdentity extends LocalDeviceIdentity {
  privateKeyRawSeedBase64Url: string;
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

async function writeJsonMessage(stream: Stream, message: unknown): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.byteLength > PAIRING_MESSAGE_MAX_BYTES) throw new Error('pairing_message_too_large');
  stream.send(payload);
}

async function readJsonMessage<T>(stream: Stream): Promise<T> {
  const reader = stream[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done || !result.value) throw new Error('pairing_message_missing');
  const chunk = result.value instanceof Uint8Array ? result.value : result.value.subarray();
  if (chunk.byteLength > PAIRING_MESSAGE_MAX_BYTES) throw new Error('pairing_message_too_large');
  return JSON.parse(new TextDecoder().decode(chunk)) as T;
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === 'desktop' || value === 'mobile' || value === 'cli';
}

function normalizePairingCapabilities(value: unknown): DeviceCapabilities {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<DeviceCapabilities> : {};
  return {
    tools: Array.isArray(raw.tools) ? raw.tools.filter((item): item is string => typeof item === 'string') : [],
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers.filter((item): item is string => typeof item === 'string') : [],
    hasWiki: raw.hasWiki === true,
    imChannels: Array.isArray(raw.imChannels) ? raw.imChannels.filter((item): item is string => typeof item === 'string') : [],
    wikis: Array.isArray(raw.wikis)
      ? raw.wikis.filter((item): item is DeviceCapabilities['wikis'][number] => item !== null && typeof item === 'object')
      : [],
  };
}

function normalizePairingDevice(value: unknown): PairingDeviceEnvelope | undefined {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!raw) return undefined;
  const peerId = typeof raw.peerId === 'string' ? raw.peerId.trim() : '';
  const publicKeyMultibase = typeof raw.publicKeyMultibase === 'string' ? raw.publicKeyMultibase.trim() : '';
  const deviceName = typeof raw.deviceName === 'string' ? raw.deviceName.trim() : '';
  if (!peerId || !publicKeyMultibase || !deviceName || !isDevicePlatform(raw.platform)) return undefined;
  return {
    peerId,
    publicKeyMultibase,
    deviceName,
    platform: raw.platform,
    capabilities: normalizePairingCapabilities(raw.capabilities),
    multiaddrs: Array.isArray(raw.multiaddrs) ? raw.multiaddrs.filter((item): item is string => typeof item === 'string') : [],
  };
}

function isPairingRequest(value: unknown): value is PairingRequestMessage {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!raw || raw.type !== 'memeloop-local-pairing-request-v1') return false;
  return typeof raw.sessionId === 'string' &&
    typeof raw.requestNonce === 'string' &&
    typeof raw.createdAt === 'number' &&
    typeof raw.expiresAt === 'number' &&
    normalizePairingDevice(raw.device) !== undefined;
}

function isPairingResponse(value: unknown): value is PairingResponseMessage {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!raw || raw.type !== 'memeloop-local-pairing-response-v1') return false;
  return typeof raw.sessionId === 'string' &&
    typeof raw.requestNonce === 'string' &&
    typeof raw.responseNonce === 'string' &&
    raw.accepted === true &&
    typeof raw.expiresAt === 'number' &&
    normalizePairingDevice(raw.device) !== undefined;
}

async function assertPairingDeviceIdentity(device: PairingDeviceEnvelope): Promise<void> {
  const publicKey = await decodePublicKeyMultibase(device.publicKeyMultibase);
  if (peerIdFromPublicKey(publicKey).toString() !== device.peerId) throw new Error('pairing_public_key_peer_id_mismatch');
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

export function buildDeviceConnectionGrantMessage(grant: Omit<DeviceConnectionGrant, 'signature'>): Uint8Array {
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

export async function verifyDeviceBinding(input: DeviceAccountBindingRequest & { accountId: string }): Promise<boolean> {
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

export async function verifyDeviceConnectionGrant(input: DeviceConnectionGrantVerificationInput): Promise<boolean> {
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

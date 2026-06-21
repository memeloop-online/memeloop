import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import type { Libp2p, PeerId, PrivateKey, PublicKey, Stream } from '@libp2p/interface';
import { mdns } from '@libp2p/mdns';
import { peerIdFromPrivateKey, peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';

import { LocalTrustDeviceAuthorizer } from './localTrustDeviceAuthorizer.js';
import type {
  Device,
  DeviceAccountBindingRequest,
  DeviceAuthorizer,
  DeviceCapabilities,
  DeviceNetworkListenOptions,
  DeviceNetworkService,
  DevicePlatform,
  LocalDeviceIdentity,
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

export class Libp2pDeviceNetworkService implements DeviceNetworkService {
  private libp2p?: Libp2p;
  private readonly capabilities: DeviceCapabilities;
  private readonly discoveredDevices = new Map<string, Device>();
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly authorizer: DeviceAuthorizer;
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly listeners = new Set<(devices: Device[]) => void>();

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

  public async requestLocalPairing(peerId: string): Promise<PairingSession> {
    const session: PairingSession = {
      sessionId: `pairing-${this.options.identity.peerId}-${peerId}-${Date.now()}`,
      localPeerId: this.options.identity.peerId,
      remotePeerId: peerId,
      confirmCode: this.confirmCode(peerId),
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.pairingSessions.set(session.sessionId, session);
    return session;
  }

  public async acceptPairing(sessionId: string): Promise<void> {
    const session = this.pairingSessions.get(sessionId);
    if (!session) throw new Error('pairing_session_not_found');
    if (session.expiresAt < Date.now()) throw new Error('pairing_session_expired');
    const discovered = this.discoveredDevices.get(session.remotePeerId);
    this.trustedDevices.set(session.remotePeerId, {
      peerId: session.remotePeerId,
      publicKeyMultibase: '',
      deviceName: discovered?.displayName ?? session.remotePeerId,
      platform: discovered?.platform ?? 'cli',
      trustMode: 'local-pairing',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    this.pairingSessions.delete(sessionId);
    this.updateDeviceTrust(session.remotePeerId, 'local-pairing');
    this.emitDevices();
  }

  public async rejectPairing(sessionId: string): Promise<void> {
    this.pairingSessions.delete(sessionId);
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    this.trustedDevices.delete(peerId);
    this.updateDeviceTrust(peerId, 'local-pairing');
    this.emitDevices();
  }

  public async openStream(peerId: string, protocol: MemeLoopProtocol): Promise<MemeLoopDuplexStream> {
    if (!await this.authorizer.canOpenProtocol({ remotePeerId: peerId, protocol })) throw new Error('device_not_trusted');
    const stream = await this.requireNode().dialProtocol(peerIdFromString(peerId), protocol);
    return this.wrapStream(stream);
  }

  public async sendRpc<T>(peerId: string, method: string, parameters: unknown): Promise<T> {
    const stream = await this.openStream(peerId, '/memeloop/rpc/1.0.0');
    const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: parameters }));
    await stream.sink(async function*() {
      yield payload;
    }());
    throw new Error('rpc_response_reader_not_implemented');
  }

  public async syncWithDevice(peerId: string): Promise<SyncResult> {
    if (!this.trustedDevices.has(peerId)) throw new Error('device_not_trusted');
    return { ok: true, peerId, syncedAt: Date.now() };
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
      if (!await this.authorizer.canOpenProtocol({ remotePeerId, protocol: stream.protocol as MemeLoopProtocol })) {
        stream.abort(new Error('device_not_trusted'));
        return;
      }
      stream.abort(new Error('protocol_handler_not_registered'));
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

  private confirmCode(peerId: string): string {
    const input = `${this.options.identity.peerId}:${peerId}`;
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
    }
    return (hash % 1_000_000).toString().padStart(6, '0');
  }

  private emitDevices(): void {
    const devices = [...this.discoveredDevices.values()];
    for (const listener of this.listeners) listener(devices);
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

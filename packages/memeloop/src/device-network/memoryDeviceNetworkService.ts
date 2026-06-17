import type {
  Device,
  DeviceCapabilities,
  DeviceNetworkService,
  LocalDeviceIdentity,
  MemeLoopDuplexStream,
  MemeLoopProtocol,
  PairingSession,
  SyncResult,
  TrustedDeviceRecord,
} from './types.js';

export interface MemoryDeviceNetworkServiceOptions {
  identity: LocalDeviceIdentity;
  capabilities?: DeviceCapabilities;
  trustedDevices?: TrustedDeviceRecord[];
}

const emptyCapabilities: DeviceCapabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  imChannels: [],
  wikis: [],
};

function toDevice(record: TrustedDeviceRecord, capabilities: DeviceCapabilities): Device {
  return {
    peerId: record.peerId,
    displayName: record.deviceName,
    platform: record.platform,
    trustMode: record.trustMode,
    reachability: {
      state: record.revokedAt ? 'offline' : 'nearby',
      paths: record.revokedAt ? [] : ['lan'],
    },
    capabilities,
    lastSeen: record.lastSeen,
  };
}

export class MemoryDeviceNetworkService implements DeviceNetworkService {
  private started = false;
  private readonly capabilities: DeviceCapabilities;
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly listeners = new Set<(devices: Device[]) => void>();

  constructor(private readonly options: MemoryDeviceNetworkServiceOptions) {
    this.capabilities = options.capabilities ?? emptyCapabilities;
    for (const record of options.trustedDevices ?? []) {
      this.trustedDevices.set(record.peerId, record);
    }
  }

  public async start(): Promise<void> {
    this.started = true;
    this.emitDevices();
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.emitDevices();
  }

  public async getLocalDevice(): Promise<Device> {
    return {
      peerId: this.options.identity.peerId,
      displayName: this.options.identity.deviceName,
      platform: this.options.identity.platform,
      trustMode: 'local-pairing',
      reachability: {
        state: this.started ? 'online' : 'offline',
        paths: this.started ? ['lan'] : [],
      },
      capabilities: this.capabilities,
      lastSeen: Date.now(),
    };
  }

  public async listDevices(): Promise<Device[]> {
    return [...this.trustedDevices.values()].map((record) => toDevice(record, emptyCapabilities));
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
    this.trustedDevices.set(session.remotePeerId, {
      peerId: session.remotePeerId,
      publicKeyMultibase: '',
      deviceName: session.remotePeerId,
      platform: 'cli',
      trustMode: 'local-pairing',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    this.pairingSessions.delete(sessionId);
    this.emitDevices();
  }

  public async rejectPairing(sessionId: string): Promise<void> {
    this.pairingSessions.delete(sessionId);
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    this.trustedDevices.delete(peerId);
    this.emitDevices();
  }

  public async openStream(peerId: string, _protocol: MemeLoopProtocol): Promise<MemeLoopDuplexStream> {
    if (!this.trustedDevices.has(peerId)) throw new Error('device_not_trusted');
    return {
      source: (async function* emptySource() {})(),
      async sink() {},
      async close() {},
    };
  }

  public async sendRpc<T>(peerId: string, _method: string, _parameters: unknown): Promise<T> {
    if (!this.trustedDevices.has(peerId)) throw new Error('device_not_trusted');
    throw new Error('rpc_handler_not_registered');
  }

  public async syncWithDevice(peerId: string): Promise<SyncResult> {
    if (!this.trustedDevices.has(peerId)) throw new Error('device_not_trusted');
    return { ok: true, peerId, syncedAt: Date.now() };
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
    void this.listDevices().then((devices) => {
      for (const listener of this.listeners) listener(devices);
    });
  }
}

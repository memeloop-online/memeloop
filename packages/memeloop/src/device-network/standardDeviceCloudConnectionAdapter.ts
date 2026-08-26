import { CloudDeviceFetchError } from './cloudDeviceFetchClient.js';
import type { DeviceCloudCommitFence, DeviceCloudConnectionAdapter, DeviceCloudStepResult } from './deviceCloudConnectionCoordinator.js';
import { buildDeviceHeartbeatMessage, DEVICE_HEARTBEAT_LIMITS } from './deviceHeartbeat.js';
import { type CloudDeviceDirectoryReconcileLogger, type DeviceCloudLiveDirectoryCapability, reconcileCloudDeviceDirectory } from './reconcileCloudDeviceDirectory.js';
import type {
  CloudDeviceClient,
  CloudDeviceRecord,
  DeviceCapabilities,
  DeviceRelayReservationToken,
  DeviceTrustStore,
  LocalDeviceIdentity,
  PublicDeviceIdentity,
  SyncResult,
} from './types.js';

const DEFAULT_RELAY_TOKEN_SAFETY_MARGIN_MS = 2 * 60_000;

type Awaitable<T> = T | Promise<T>;

export interface StandardDeviceCloudNetworkCapability {
  getMultiaddrs(): readonly string[];
  /** Final host write must reject a stale fence at its durable commit point. */
  configureRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Awaitable<void>;
  clearRelayReservation(signal: AbortSignal): Awaitable<void>;
}

export interface StandardDeviceCloudConnectionAdapterOptions {
  capabilities: () => Awaitable<DeviceCapabilities>;
  /** Final host write must reject a stale fence at its durable commit point. */
  configureConnectionGrantPublicKey: (
    value: { issuer: 'memeloop-cloud'; publicKeyMultibase: string },
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ) => Awaitable<void>;
  /**
   * Atomically publish a fetched Cloud directory snapshot only when the
   * supplied generation is still current. Implementations backed by async
   * persistence must perform an expected-generation CAS in the same durable
   * transaction as the snapshot write; a check followed by an awaited write
   * is not sufficient.
   */
  commitCloudDirectorySnapshot: (
    input: {
      cloudDevices: readonly CloudDeviceRecord[];
      excludePeerIds: readonly string[];
      freshnessMs?: number;
      now: number;
    },
    fence: DeviceCloudCommitFence,
  ) => Awaitable<void>;
  clearConnectionGrantPublicKey: (signal: AbortSignal) => Awaitable<void>;
  clearTokenCache: (client: CloudDeviceClient, signal: AbortSignal) => Awaitable<void>;
  directoryFreshnessMs?: number;
  directoryLogger?: CloudDeviceDirectoryReconcileLogger;
  identity: LocalDeviceIdentity;
  liveDirectory: DeviceCloudLiveDirectoryCapability;
  network: StandardDeviceCloudNetworkCapability;
  now?: () => number;
  relayRequiredForOnline?: (multiaddrs: readonly string[]) => boolean;
  relayTokenSafetyMarginMs?: number;
  signDeviceBinding: (input: {
    accountId: string;
    identity: LocalDeviceIdentity;
    nonce: string;
    signal: AbortSignal;
  }) => Awaitable<string>;
  signHeartbeat: (input: {
    peerId: string;
    timestamp: number;
    capabilities: DeviceCapabilities;
    multiaddrs: string[];
    relayReservations: string[];
    signal: AbortSignal;
  }) => Awaitable<{ nonce: string; signature: string }>;
  /** Host wrapper obtains the scoped Cloud grant before entering libp2p sync. */
  syncDevice?: (
    client: CloudDeviceClient,
    peerId: string,
    signal: AbortSignal,
  ) => Promise<SyncResult>;
  trustStore: DeviceTrustStore;
}

/** Shared host adapter for Cloud registration, relay, heartbeat, and directory maintenance. */
export class StandardDeviceCloudConnectionAdapter implements DeviceCloudConnectionAdapter<CloudDeviceClient> {
  private relayReservation?: DeviceRelayReservationToken;
  private relayReservationClient?: CloudDeviceClient;
  private backgroundSyncPeerIds: string[] = [];
  private readonly now: () => number;
  private readonly relayTokenSafetyMarginMs: number;

  constructor(private readonly options: StandardDeviceCloudConnectionAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.relayTokenSafetyMarginMs = options.relayTokenSafetyMarginMs ??
      DEFAULT_RELAY_TOKEN_SAFETY_MARGIN_MS;
    if (!Number.isFinite(this.relayTokenSafetyMarginMs) || this.relayTokenSafetyMarginMs < 0) {
      throw new TypeError('relayTokenSafetyMarginMs must be finite and non-negative');
    }
  }

  public isConfigured(
    configuration: CloudDeviceClient | undefined,
  ): configuration is CloudDeviceClient {
    return configuration !== undefined;
  }

  public relayRequiredForOnline(_configuration: CloudDeviceClient): boolean {
    const addresses = this.options.network.getMultiaddrs();
    return this.options.relayRequiredForOnline?.(addresses) ??
      !hasValidDirectCloudDeviceAddress(addresses);
  }

  public async ensureAuthorizer(
    client: CloudDeviceClient,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult> {
    const publicKey = await client.getConnectionGrantPublicKey(signal);
    return {
      commit: async (fence) => {
        fence.throwIfStale();
        await this.options.configureConnectionGrantPublicKey(publicKey, signal, fence);
        fence.throwIfStale();
      },
    };
  }

  public async registerDevice(
    client: CloudDeviceClient,
    signal: AbortSignal,
  ): Promise<undefined> {
    const nonce = await client.createBindingNonce(signal);
    throwIfAborted(signal);
    const signature = await this.options.signDeviceBinding({
      accountId: nonce.accountId,
      identity: this.options.identity,
      nonce: nonce.nonce,
      signal,
    });
    throwIfAborted(signal);
    const capabilities = await this.options.capabilities();
    throwIfAborted(signal);
    const registration = await client.registerDevice({
      // Construct a fresh public projection at the capability boundary. A
      // custom CloudDeviceClient must never observe host-local key references
      // or serialized private-key material through structural typing.
      identity: toPublicDeviceIdentity(this.options.identity),
      cloudNonce: nonce.nonce,
      signature,
      capabilities,
      multiaddrs: [...this.options.network.getMultiaddrs()],
      relayReservations: this.currentRelayReservations(),
    }, signal);
    if (!registration.ok || registration.peerId !== this.options.identity.peerId) {
      throw new Error('cloud device registration rejected');
    }
    return undefined;
  }

  public async ensureRelay(
    client: CloudDeviceClient,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult | undefined> {
    if (
      this.relayReservationClient === client &&
      this.relayReservation &&
      this.relayReservation.expiresAt > this.now() + this.relayTokenSafetyMarginMs
    ) {
      return undefined;
    }
    const relayReservation = await client.createRelayReservation(
      { peerId: this.options.identity.peerId },
      signal,
    );
    return {
      commit: async (fence) => {
        fence.throwIfStale();
        await this.options.network.configureRelayReservation(relayReservation, signal, fence);
        fence.throwIfStale();
        fence.commitSynchronous(() => {
          this.relayReservation = relayReservation;
          this.relayReservationClient = client;
        });
      },
    };
  }

  public async heartbeat(
    client: CloudDeviceClient,
    signal: AbortSignal,
  ): Promise<undefined> {
    throwIfAborted(signal);
    const capabilities = await this.options.capabilities();
    throwIfAborted(signal);
    const unsigned = {
      peerId: this.options.identity.peerId,
      timestamp: this.now(),
      capabilities,
      multiaddrs: [...this.options.network.getMultiaddrs()],
      relayReservations: this.currentRelayReservations(),
    };
    const proof = await this.options.signHeartbeat({ ...unsigned, signal });
    throwIfAborted(signal);
    const heartbeat = { ...unsigned, ...proof };
    void buildDeviceHeartbeatMessage({ ...unsigned, nonce: proof.nonce });
    if (!boundedProofSignature(heartbeat.signature)) {
      throw new Error('invalid device heartbeat signature');
    }
    const result = await client.heartbeat(heartbeat, signal);
    if (!result.ok) throw new Error('cloud device heartbeat rejected');
    return undefined;
  }

  public async dispose(client: CloudDeviceClient, signal: AbortSignal): Promise<void> {
    this.relayReservation = undefined;
    this.relayReservationClient = undefined;
    this.backgroundSyncPeerIds = [];
    const errors: unknown[] = [];
    await bestEffortCleanup(
      () => this.options.clearConnectionGrantPublicKey(signal),
      errors,
    );
    await bestEffortCleanup(
      () => this.options.network.clearRelayReservation(signal),
      errors,
    );
    await bestEffortCleanup(
      async () => {
        await reconcileCloudDeviceDirectory({
          cloudDevices: [],
          liveDirectory: this.options.liveDirectory,
          logger: this.options.directoryLogger,
          now: this.now,
          trustStore: this.options.trustStore,
        });
      },
      errors,
    );
    await bestEffortCleanup(
      () => this.options.clearTokenCache(client, signal),
      errors,
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'device cloud generation cleanup failed');
    }
  }

  public async syncDirectory(
    client: CloudDeviceClient,
    signal: AbortSignal,
  ): Promise<DeviceCloudStepResult> {
    const cloudDevices = await client.listDevices(signal);
    return {
      commit: async (fence) => {
        fence.throwIfStale();
        await this.options.commitCloudDirectorySnapshot({
          cloudDevices,
          excludePeerIds: [this.options.identity.peerId],
          freshnessMs: this.options.directoryFreshnessMs,
          now: this.now(),
        }, fence);
        fence.throwIfStale();
        fence.commitSynchronous(() => {
          this.backgroundSyncPeerIds = cloudDevices
            .filter(device => device.peerId !== this.options.identity.peerId && device.revokedAt === undefined)
            .map(device => device.peerId);
        });
      },
    };
  }

  public listBackgroundSyncPeerIds(
    _client: CloudDeviceClient,
    signal: AbortSignal,
  ): readonly string[] {
    signal.throwIfAborted();
    return this.options.syncDevice ? [...this.backgroundSyncPeerIds] : [];
  }

  public syncDevice(
    client: CloudDeviceClient,
    peerId: string,
    signal: AbortSignal,
  ): Promise<SyncResult> {
    signal.throwIfAborted();
    if (!this.options.syncDevice) throw new Error('background_device_sync_not_configured');
    return this.options.syncDevice(client, peerId, signal);
  }

  public classifyError(error: unknown): 'offline' | 'error' {
    if (error instanceof CloudDeviceFetchError) {
      return error.code === 'cloud_request_failed' ? 'offline' : 'error';
    }
    return 'offline';
  }

  private currentRelayReservations(): string[] {
    const active = this.options.network.getMultiaddrs()
      .filter(address => address.includes('/p2p-circuit'));
    return active.length > 0 ? [...active] : [...(this.relayReservation?.relayMultiaddrs ?? [])];
  }
}

function toPublicDeviceIdentity(identity: LocalDeviceIdentity): PublicDeviceIdentity {
  return {
    peerId: identity.peerId,
    publicKeyMultibase: identity.publicKeyMultibase,
    createdAt: identity.createdAt,
    deviceName: identity.deviceName,
    platform: identity.platform,
  };
}

/** True only when another device can plausibly dial the address without a relay. */
export function hasValidDirectCloudDeviceAddress(addresses: readonly string[]): boolean {
  return addresses.some((address) => {
    if (address.includes('/p2p-circuit')) return false;
    const parts = address.split('/');
    const protocolIndex = parts.findIndex(part =>
      part === 'ip4' || part === 'ip6' || part === 'dns' ||
      part === 'dns4' || part === 'dns6'
    );
    if (protocolIndex < 0) return false;
    const host = parts[protocolIndex + 1]?.toLowerCase();
    if (!host) return false;
    const protocol = parts[protocolIndex];
    if (protocol === 'ip4') return isPublicIpv4(host);
    if (protocol === 'ip6') return isPublicIpv6(host);
    return isPlausiblePublicDnsHost(host);
  });
}

function isPublicIpv4(host: string): boolean {
  const octets = host.split('.').map(part => Number(part));
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return first !== 0 && first !== 10 && first !== 127 && first < 224 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 0 && octets[2] === 0) &&
    !(first === 192 && second === 0 && octets[2] === 2) &&
    !(first === 192 && second === 88 && octets[2] === 99) &&
    !(first === 192 && second === 168) &&
    !(first === 198 && (second === 18 || second === 19)) &&
    !(first === 198 && second === 51 && octets[2] === 100) &&
    !(first === 203 && second === 0 && octets[2] === 113);
}

function isPublicIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;
  const [first, second] = groups;
  if ((first & 0xe000) !== 0x2000) return false;
  // Documentation-only addresses are valid syntax but never direct public paths.
  return !(first === 0x2001 && second === 0x0db8);
}

function parseIpv6(host: string): number[] | undefined {
  const normalized = host.toLowerCase();
  if (normalized.includes('%') || normalized.includes('.')) return undefined;
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return [];
    const parts = half.split(':');
    if (parts.some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
    return parts.map(part => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isPlausiblePublicDnsHost(host: string): boolean {
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  if (isIpv4Syntax(normalized)) return isPublicIpv4(normalized);
  if (normalized.includes(':')) return isPublicIpv6(normalized);
  if (
    normalized === 'localhost' || normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') || normalized.endsWith('.internal')
  ) return false;
  const labels = normalized.split('.');
  return labels.length > 1 && labels.every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
}

function isIpv4Syntax(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
}

function boundedProofSignature(signature: unknown): signature is string {
  if (
    typeof signature !== 'string' || signature.length === 0 ||
    signature.length > DEVICE_HEARTBEAT_LIMITS.signatureCharacters ||
    signature !== signature.trim()
  ) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    const code = signature.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

async function bestEffortCleanup(
  operation: () => Awaitable<void>,
  errors: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('device_cloud_operation_aborted');
}

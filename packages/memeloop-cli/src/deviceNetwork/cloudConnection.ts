import {
  type DeviceCapabilities,
  DeviceCloudConnectionCoordinator,
  type DeviceCloudConnectionSnapshot,
  type DeviceCloudStepResult,
  type DeviceRelayReservationToken,
} from 'memeloop';

import type { DeviceCloudClient } from './cloudClient.js';
import type { CliDeviceIdentity } from './identity.js';
import { signDeviceBinding } from './identity.js';

const DEFAULT_RELAY_RENEWAL_WINDOW_MS = 2 * 60_000;

export interface CliCloudNetworkAdapter {
  configureRelayReservation(token: DeviceRelayReservationToken): Promise<void>;
  getMultiaddrs(): string[];
}

export interface CliCloudConnectionOptions {
  capabilities: () => DeviceCapabilities;
  client: DeviceCloudClient;
  ensureCloudAuthorizer: () => Promise<void>;
  heartbeatIntervalMs?: number;
  identity: CliDeviceIdentity;
  logWarning?: (message: string, error: unknown) => void;
  network: CliCloudNetworkAdapter;
  now?: () => number;
  onStatus?: (snapshot: DeviceCloudConnectionSnapshot) => void | Promise<void>;
  relayRenewalWindowMs?: number;
  syncCloudDirectory?: () => Promise<void>;
}

function isUnspecifiedOrLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '::1' ||
    normalized.startsWith('127.') || normalized === 'localhost';
}

/** True only for an address another machine can actually dial directly. */
export function hasValidDirectDeviceAddress(addresses: readonly string[]): boolean {
  return addresses.some((address) => {
    if (address.includes('/p2p-circuit')) return false;
    const parts = address.split('/');
    const protocolIndex = parts.findIndex((part) => part === 'ip4' || part === 'ip6' || part === 'dns' || part === 'dns4' || part === 'dns6');
    if (protocolIndex < 0) return false;
    const host = parts[protocolIndex + 1];
    return typeof host === 'string' && host.length > 0 && !isUnspecifiedOrLoopback(host);
  });
}

/** CLI adapter over the portable, generation-safe Cloud lifecycle. */
export class CliCloudConnection {
  private relayReservation?: DeviceRelayReservationToken;
  private readonly now: () => number;
  private readonly relayRenewalWindowMs: number;
  private readonly coordinator: DeviceCloudConnectionCoordinator<true>;

  constructor(private readonly options: CliCloudConnectionOptions) {
    this.now = options.now ?? Date.now;
    this.relayRenewalWindowMs = options.relayRenewalWindowMs ?? DEFAULT_RELAY_RENEWAL_WINDOW_MS;
    this.coordinator = new DeviceCloudConnectionCoordinator({
      adapter: {
        isConfigured: (configuration): configuration is true => configuration === true,
        relayRequiredForOnline: () => !hasValidDirectDeviceAddress(this.options.network.getMultiaddrs()),
        ensureAuthorizer: async () => {
          await this.options.ensureCloudAuthorizer();
          return undefined;
        },
        registerDevice: async () => {
          await this.registerDevice();
          return undefined;
        },
        ensureRelay: async () => this.prepareRelayReservation(),
        heartbeat: async () => {
          await this.options.client.heartbeat({
            peerId: this.options.identity.peerId,
            capabilities: this.options.capabilities(),
            multiaddrs: this.options.network.getMultiaddrs(),
            relayReservations: this.currentRelayReservations(),
          });
          return undefined;
        },
        syncDirectory: async () => {
          await this.options.syncCloudDirectory?.();
          return undefined;
        },
      },
      configuration: true,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      logWarning: options.logWarning,
      now: this.now,
      onStatus: options.onStatus,
    });
  }

  public get snapshot(): DeviceCloudConnectionSnapshot {
    return this.coordinator.snapshot;
  }

  public start(): Promise<void> {
    return this.coordinator.start();
  }

  public stop(): Promise<void> {
    return this.coordinator.stop();
  }

  public runNow(): Promise<void> {
    return this.coordinator.runNow();
  }

  private async registerDevice(): Promise<void> {
    const nonce = await this.options.client.createBindingNonce();
    await this.options.client.registerDevice({
      identity: this.options.identity,
      cloudNonce: nonce.nonce,
      signature: await signDeviceBinding({
        identity: this.options.identity,
        accountId: nonce.accountId,
        nonce: nonce.nonce,
      }),
      capabilities: this.options.capabilities(),
      multiaddrs: this.options.network.getMultiaddrs(),
      relayReservations: this.currentRelayReservations(),
    });
  }

  private async prepareRelayReservation(): Promise<DeviceCloudStepResult | undefined> {
    if (!this.shouldRenewRelay()) return undefined;
    const relayReservation = await this.options.client.createRelayReservation({
      peerId: this.options.identity.peerId,
    });
    return {
      commit: async () => {
        await this.options.network.configureRelayReservation(relayReservation);
        this.relayReservation = relayReservation;
      },
    };
  }

  private shouldRenewRelay(): boolean {
    return !this.relayReservation ||
      this.relayReservation.expiresAt <= this.now() + this.relayRenewalWindowMs;
  }

  private currentRelayReservations(): string[] {
    const active = this.options.network.getMultiaddrs().filter((address) => address.includes('/p2p-circuit'));
    return active.length > 0 ? active : (this.relayReservation?.relayMultiaddrs ?? []);
  }
}

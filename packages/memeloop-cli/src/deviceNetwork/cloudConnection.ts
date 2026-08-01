import type { DeviceCapabilities, DeviceRelayReservationToken } from 'memeloop';

import type { DeviceCloudClient } from './cloudClient.js';
import type { CliDeviceIdentity } from './identity.js';
import { signDeviceBinding } from './identity.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
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
  relayRenewalWindowMs?: number;
  syncCloudDirectory?: () => Promise<void>;
}

/** Serializes registration, relay renewal, and heartbeat recovery for the CLI host. */
export class CliCloudConnection {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private registered = false;
  private relayReservation?: DeviceRelayReservationToken;
  private readonly now: () => number;
  private readonly relayRenewalWindowMs: number;

  constructor(private readonly options: CliCloudConnectionOptions) {
    this.now = options.now ?? Date.now;
    this.relayRenewalWindowMs = options.relayRenewalWindowMs ?? DEFAULT_RELAY_RENEWAL_WINDOW_MS;
  }

  public async start(): Promise<void> {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.runNow().catch((error: unknown) => {
          this.options.logWarning?.('Cloud maintenance failed', error);
        });
      }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    }
    await this.runNow();
  }

  public async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  public runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.maintain();
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async maintain(): Promise<void> {
    try {
      await this.options.ensureCloudAuthorizer();
      if (!this.registered) await this.registerDevice();
      if (this.shouldRenewRelay()) {
        const relayReservation = await this.options.client.createRelayReservation({
          peerId: this.options.identity.peerId,
        });
        await this.options.network.configureRelayReservation(relayReservation);
        this.relayReservation = relayReservation;
      }
      await this.options.client.heartbeat({
        peerId: this.options.identity.peerId,
        capabilities: this.options.capabilities(),
        multiaddrs: this.options.network.getMultiaddrs(),
        relayReservations: this.currentRelayReservations(),
      });
      await this.options.syncCloudDirectory?.();
    } catch (error) {
      this.registered = false;
      throw error;
    }
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
    this.registered = true;
  }

  private shouldRenewRelay(): boolean {
    return !this.relayReservation || this.relayReservation.expiresAt <= this.now() + this.relayRenewalWindowMs;
  }

  private currentRelayReservations(): string[] {
    const active = this.options.network.getMultiaddrs().filter(address => address.includes('/p2p-circuit'));
    return active.length > 0 ? active : (this.relayReservation?.relayMultiaddrs ?? []);
  }
}

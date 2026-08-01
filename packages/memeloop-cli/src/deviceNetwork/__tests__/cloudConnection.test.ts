import type { DeviceCapabilities, DeviceRelayReservationToken } from 'memeloop';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity.js', () => ({
  signDeviceBinding: vi.fn().mockResolvedValue('binding-signature'),
}));

import type { DeviceCloudClient } from '../cloudClient.js';
import { CliCloudConnection, hasValidDirectDeviceAddress } from '../cloudConnection.js';
import type { CliDeviceIdentity } from '../identity.js';

const capabilities: DeviceCapabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  agentLoop: true,
  imChannels: [],
  wikis: [],
};

function reservation(expiresAt: number): DeviceRelayReservationToken {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    peerId: 'peer-1',
    relayMultiaddrs: ['/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit'],
    bootstrapMultiaddrs: [],
    issuedAt: 1,
    expiresAt,
    signature: 'signature',
  };
}

function setup(now = 1_000) {
  const client = {
    createBindingNonce: vi.fn().mockResolvedValue({ nonce: 'nonce-1', accountId: 'account-1', expiresAt: 'later' }),
    registerDevice: vi.fn().mockResolvedValue({ ok: true, peerId: 'peer-1' }),
    createRelayReservation: vi.fn().mockResolvedValue(reservation(now + 10_000)),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as DeviceCloudClient;
  const network = {
    configureRelayReservation: vi.fn().mockResolvedValue(undefined),
    getMultiaddrs: vi.fn().mockReturnValue(['/ip4/127.0.0.1/tcp/4001']),
  };
  const ensureCloudAuthorizer = vi.fn().mockResolvedValue(undefined);
  const identity = {
    peerId: 'peer-1',
    publicKeyMultibase: 'zPublicKey',
    privateKeyRawSeedBase64Url: 'seed',
    privateKeyRef: 'test',
    deviceName: 'CLI',
    platform: 'cli',
    createdAt: 1,
  } satisfies CliDeviceIdentity;
  const connection = new CliCloudConnection({
    capabilities: () => capabilities,
    client,
    ensureCloudAuthorizer,
    heartbeatIntervalMs: 60_000,
    identity,
    network,
    now: () => now,
    relayRenewalWindowMs: 100,
  });
  return { client: client as unknown as Record<string, ReturnType<typeof vi.fn>>, connection, ensureCloudAuthorizer, network };
}

describe('CliCloudConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers, reserves relay capacity, and heartbeats on startup', async () => {
    vi.useFakeTimers();
    const { client, connection, ensureCloudAuthorizer, network } = setup();
    await connection.start();
    await connection.stop();

    expect(ensureCloudAuthorizer).toHaveBeenCalledOnce();
    expect(client.createBindingNonce).toHaveBeenCalledOnce();
    expect(client.registerDevice).toHaveBeenCalledOnce();
    expect(client.createRelayReservation).toHaveBeenCalledOnce();
    expect(network.configureRelayReservation).toHaveBeenCalledOnce();
    expect(client.heartbeat).toHaveBeenCalledOnce();
  });

  it('re-registers after a failed heartbeat', async () => {
    vi.useFakeTimers();
    const { client, connection } = setup();
    await connection.start();
    client.heartbeat.mockRejectedValueOnce(new Error('offline'));
    await expect(connection.runNow()).rejects.toThrow('offline');
    await connection.runNow();
    await connection.stop();

    expect(client.registerDevice).toHaveBeenCalledTimes(2);
    expect(client.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('renews a relay reservation before it expires', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { client, network } = setup(now);
    const connection = new CliCloudConnection({
      capabilities: () => capabilities,
      client: client as unknown as DeviceCloudClient,
      ensureCloudAuthorizer: vi.fn().mockResolvedValue(undefined),
      heartbeatIntervalMs: 60_000,
      identity: {
        peerId: 'peer-1',
        publicKeyMultibase: 'zPublicKey',
        privateKeyRawSeedBase64Url: 'seed',
        privateKeyRef: 'test',
        deviceName: 'CLI',
        platform: 'cli',
        createdAt: 1,
      },
      network,
      now: () => now,
      relayRenewalWindowMs: 100,
    });
    await connection.start();
    now = 10_950;
    await connection.runNow();
    await connection.stop();

    expect(client.createRelayReservation).toHaveBeenCalledTimes(2);
    expect(network.configureRelayReservation).toHaveBeenCalledTimes(2);
  });

  it('retries a relay token when configuring it locally fails', async () => {
    vi.useFakeTimers();
    const { client, connection, network } = setup();
    network.configureRelayReservation.mockRejectedValueOnce(new Error('relay unavailable'));

    await expect(connection.start()).resolves.toBeUndefined();
    expect(connection.snapshot.status).toBe('degraded');
    await expect(connection.runNow()).resolves.toBeUndefined();
    expect(connection.snapshot.status).toBe('online');
    await connection.stop();

    expect(client.createRelayReservation).toHaveBeenCalledTimes(2);
    expect(network.configureRelayReservation).toHaveBeenCalledTimes(2);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('only treats externally dialable addresses as a direct path', () => {
    expect(hasValidDirectDeviceAddress([
      '/ip4/127.0.0.1/tcp/4001',
      '/ip4/0.0.0.0/tcp/4001',
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
    ])).toBe(false);
    expect(hasValidDirectDeviceAddress(['/ip4/192.168.1.20/tcp/4001'])).toBe(true);
    expect(hasValidDirectDeviceAddress(['/dns4/device.example.test/tcp/443/wss'])).toBe(true);
  });

  it('coalesces concurrent maintenance calls', async () => {
    vi.useFakeTimers();
    const { client, connection } = setup();
    let resolveNonce!: (value: { nonce: string; accountId: string; expiresAt: string }) => void;
    client.createBindingNonce.mockReturnValueOnce(
      new Promise(resolve => {
        resolveNonce = resolve;
      }),
    );
    const first = connection.runNow();
    const second = connection.runNow();
    expect(second).toBe(first);
    resolveNonce({ nonce: 'nonce-1', accountId: 'account-1', expiresAt: 'later' });
    await first;
    expect(client.createBindingNonce).toHaveBeenCalledOnce();
  });
});

import { createDeviceIdentity, decodePublicKeyMultibase } from '@memeloop/libp2p';
import {
  type DeviceCapabilities,
  type DeviceCloudCommitFence,
  type DeviceHeartbeatMessage,
  type DeviceRelayReservationToken,
  type TrustedDeviceRecord,
  verifyDeviceHeartbeatMessage,
} from 'memeloop';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceCloudClient } from '../cloudClient.js';
import { CliCloudConnection, hasValidDirectDeviceAddress } from '../cloudConnection.js';
import type { CliDeviceIdentity } from '../identity.js';
import type { CliCloudDirectorySnapshotTrustStore } from '../trustStore.js';

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
    relayMultiaddrs: ['/dns4/relay.example.test/tcp/443/wss/p2p/relay'],
    bootstrapMultiaddrs: [],
    issuedAt: 1,
    expiresAt,
    signature: 'signature',
  };
}

function memorySnapshotTrustStore(): CliCloudDirectorySnapshotTrustStore {
  let records: TrustedDeviceRecord[] = [];
  return {
    loadTrustedDevices: vi.fn(async () => records.map(record => ({ ...record }))),
    saveTrustedDevice: vi.fn(async (record: TrustedDeviceRecord) => {
      records = [...records.filter(current => current.peerId !== record.peerId), { ...record }];
    }),
    removeTrustedDevice: vi.fn(async (peerId: string) => {
      records = records.filter(record => record.peerId !== peerId);
    }),
    commitCloudAccountSnapshot: vi.fn((
      snapshot: readonly TrustedDeviceRecord[],
      fence: DeviceCloudCommitFence,
    ) => {
      let committed: TrustedDeviceRecord[] | undefined;
      fence.commitSynchronous(() => {
        const localRecords = records.filter(record => record.trustMode !== 'cloud-account');
        records = [...localRecords, ...snapshot.map(record => ({ ...record }))];
        committed = records.map(record => ({ ...record }));
      });
      return committed;
    }),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function setup(now = 1_000) {
  const client = {
    clearCachedTokens: vi.fn().mockResolvedValue(undefined),
    createBindingNonce: vi.fn().mockResolvedValue({ nonce: 'nonce-1', accountId: 'account-1', expiresAt: 'later' }),
    registerDevice: vi.fn().mockResolvedValue({ ok: true, peerId: 'peer-1' }),
    createRelayReservation: vi.fn().mockResolvedValue(reservation(now + 10_000)),
    getConnectionGrantPublicKey: vi.fn().mockResolvedValue({
      issuer: 'memeloop-cloud',
      publicKeyMultibase: 'zCloudKey',
    }),
    createConnectionGrant: vi.fn().mockResolvedValue({
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2'],
      protocols: ['/memeloop/sync/2.0.0'],
      rpcMethodScope: { mode: 'none' },
      conversationScope: { mode: 'all' },
      definitionScope: { mode: 'none' },
      issuedAt: 1,
      expiresAt: 10_000,
      signature: 'grant-signature',
    }),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    listDevices: vi.fn().mockResolvedValue([]),
  } as unknown as DeviceCloudClient;
  const network = {
    clearRelayReservation: vi.fn().mockResolvedValue(undefined),
    configureRelayReservation: vi.fn().mockResolvedValue(undefined),
    getMultiaddrs: vi.fn().mockReturnValue(['/ip4/127.0.0.1/tcp/4001']),
    listCloudDeviceAddressPeerIds: vi.fn().mockReturnValue([]),
    removeCloudDeviceAddresses: vi.fn().mockResolvedValue(undefined),
    setCloudDeviceAddresses: vi.fn().mockResolvedValue(undefined),
    syncWithDevice: vi.fn().mockResolvedValue({
      ok: true,
      peerId: 'peer-2',
      syncedAt: 1,
      complete: true,
      progress: {
        passes: 1,
        peers: 1,
        frontierPages: 1,
        pages: 1,
        events: 1,
        bytes: 1,
        elapsedMs: 1,
      },
    }),
  };
  const configureCloudAuthorizer = vi.fn().mockResolvedValue(undefined);
  const clearCloudAuthorizer = vi.fn().mockResolvedValue(undefined);
  const trustStore = memorySnapshotTrustStore();
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
    clearCloudAuthorizer,
    configureCloudAuthorizer,
    heartbeatIntervalMs: 60_000,
    identity,
    network,
    now: () => now,
    relayRenewalWindowMs: 100,
    signDeviceBinding: vi.fn().mockResolvedValue('binding-signature'),
    signHeartbeat: vi.fn().mockResolvedValue({
      nonce: 'heartbeat-nonce',
      signature: 'heartbeat-signature',
    }),
    trustStore,
  });
  return {
    clearCloudAuthorizer,
    client: client as unknown as Record<string, ReturnType<typeof vi.fn>>,
    configureCloudAuthorizer,
    connection,
    network,
    trustStore,
  };
}

describe('CliCloudConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers, reserves relay capacity, and sends a signed heartbeat on startup', async () => {
    vi.useFakeTimers();
    const { client, configureCloudAuthorizer, connection, network } = setup();
    await connection.start();
    await connection.stop();

    expect(configureCloudAuthorizer).toHaveBeenCalledOnce();
    expect(client.createBindingNonce).toHaveBeenCalledOnce();
    expect(client.registerDevice).toHaveBeenCalledOnce();
    expect(client.createRelayReservation).toHaveBeenCalledOnce();
    expect(network.configureRelayReservation).toHaveBeenCalledOnce();
    const relayCall = network.configureRelayReservation.mock.calls[0];
    expect(relayCall).toHaveLength(3);
    expect(relayCall?.[1]).toBeInstanceOf(AbortSignal);
    expect((relayCall?.[2] as { signal?: AbortSignal } | undefined)?.signal).toBe(relayCall?.[1]);
    expect(client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'peer-1',
        timestamp: 1_000,
        nonce: 'heartbeat-nonce',
        signature: 'heartbeat-signature',
      }),
      expect.any(AbortSignal),
    );
  });

  it('automatically syncs committed Cloud peers with a scoped grant', async () => {
    const { client, connection, network } = setup();
    client.listDevices.mockResolvedValueOnce([{
      accountId: 'account-1',
      peerId: 'peer-2',
      publicKeyMultibase: 'zPeer2Key',
      deviceName: 'Desktop',
      platform: 'desktop',
      capabilities,
      multiaddrs: ['/ip4/192.168.1.20/tcp/4001'],
      relayReservations: [],
      lastSeen: 1_000,
    }]);

    await connection.start();
    await vi.waitFor(() => {
      expect(network.syncWithDevice).toHaveBeenCalledOnce();
    });
    expect(client.createConnectionGrant).toHaveBeenCalledWith({
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2'],
      protocols: ['/memeloop/sync/2.0.0'],
      rpcMethodScope: { mode: 'none' },
      conversationScope: { mode: 'all' },
      definitionScope: { mode: 'none' },
    }, expect.any(AbortSignal));
    expect(network.syncWithDevice).toHaveBeenCalledWith('peer-2', {
      presentedGrant: expect.objectContaining({ signature: 'grant-signature' }),
      signal: expect.any(AbortSignal),
    });
    await connection.stop();
  });

  it('keeps registration after a failed heartbeat', async () => {
    vi.useFakeTimers();
    const { client, connection } = setup();
    await connection.start();
    client.heartbeat.mockRejectedValueOnce(new Error('offline'));
    await expect(connection.runNow()).rejects.toThrow('offline');
    await connection.runNow();
    await connection.stop();

    expect(client.registerDevice).toHaveBeenCalledOnce();
    expect(client.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('renews a relay reservation before it expires', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { client, network, trustStore } = setup(now);
    const connection = new CliCloudConnection({
      capabilities: () => capabilities,
      client: client as unknown as DeviceCloudClient,
      clearCloudAuthorizer: vi.fn(),
      configureCloudAuthorizer: vi.fn(),
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
      signDeviceBinding: vi.fn().mockResolvedValue('binding-signature'),
      signHeartbeat: vi.fn().mockResolvedValue({
        nonce: 'heartbeat-nonce',
        signature: 'heartbeat-signature',
      }),
      trustStore,
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

  it('only treats publicly dialable addresses as a direct path', () => {
    expect(hasValidDirectDeviceAddress([
      '/ip4/127.0.0.1/tcp/4001',
      '/ip4/0.0.0.0/tcp/4001',
      '/ip4/192.168.1.20/tcp/4001',
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
    ])).toBe(false);
    expect(hasValidDirectDeviceAddress(['/ip4/8.8.8.8/tcp/4001'])).toBe(true);
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

  it('never publishes a delayed A directory snapshot after switching to B', async () => {
    vi.useFakeTimers();
    const firstLoad = deferred<undefined>();
    const durableSnapshots: string[][] = [];
    let loadCount = 0;
    let records: TrustedDeviceRecord[] = [];
    const trustStore: CliCloudDirectorySnapshotTrustStore = {
      loadTrustedDevices: vi.fn(async () => {
        loadCount += 1;
        if (loadCount === 1) await firstLoad.promise;
        return records.map(record => ({ ...record }));
      }),
      saveTrustedDevice: vi.fn(async (record: TrustedDeviceRecord) => {
        records = [...records.filter(current => current.peerId !== record.peerId), record];
      }),
      removeTrustedDevice: vi.fn(async (peerId: string) => {
        records = records.filter(record => record.peerId !== peerId);
      }),
      commitCloudAccountSnapshot: vi.fn((
        snapshot: readonly TrustedDeviceRecord[],
        fence: DeviceCloudCommitFence,
      ) => {
        let committed: TrustedDeviceRecord[] | undefined;
        fence.commitSynchronous(() => {
          records = [
            ...records.filter(record => record.trustMode !== 'cloud-account'),
            ...snapshot.map(record => ({ ...record })),
          ];
          committed = records.map(record => ({ ...record }));
          durableSnapshots.push(
            records
              .filter(record => record.trustMode === 'cloud-account')
              .map(record => record.accountId!),
          );
        });
        return committed;
      }),
    };
    const makeClient = (accountId: string, remotePeerId: string) => ({
      clearCachedTokens: vi.fn().mockResolvedValue(undefined),
      createBindingNonce: vi.fn().mockResolvedValue({ nonce: 'nonce-1', accountId, expiresAt: 'later' }),
      registerDevice: vi.fn().mockResolvedValue({ ok: true, peerId: 'peer-1' }),
      createRelayReservation: vi.fn().mockResolvedValue(reservation(20_000)),
      getConnectionGrantPublicKey: vi.fn().mockResolvedValue({
        issuer: 'memeloop-cloud',
        publicKeyMultibase: 'zCloudKey',
      }),
      heartbeat: vi.fn().mockResolvedValue({ ok: true }),
      listDevices: vi.fn().mockResolvedValue([{
        accountId,
        peerId: remotePeerId,
        publicKeyMultibase: `z-${remotePeerId}`,
        deviceName: remotePeerId,
        platform: 'cli',
        capabilities,
        multiaddrs: [],
        relayReservations: [],
        lastSeen: 1_000,
      }]),
    } as unknown as DeviceCloudClient);
    const clientA = makeClient('account-a', 'remote-a');
    const clientB = makeClient('account-b', 'remote-b');
    const network = {
      clearRelayReservation: vi.fn().mockResolvedValue(undefined),
      configureRelayReservation: vi.fn().mockResolvedValue(undefined),
      getMultiaddrs: vi.fn().mockReturnValue(['/ip4/127.0.0.1/tcp/4001']),
      listCloudDeviceAddressPeerIds: vi.fn().mockResolvedValue([]),
      removeCloudDeviceAddresses: vi.fn().mockResolvedValue(undefined),
      setCloudDeviceAddresses: vi.fn().mockResolvedValue(undefined),
    };
    const connection = new CliCloudConnection({
      capabilities: () => capabilities,
      client: clientA,
      clearCloudAuthorizer: vi.fn(),
      configureCloudAuthorizer: vi.fn(),
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
      now: () => 1_000,
      signDeviceBinding: vi.fn().mockResolvedValue('binding-signature'),
      signHeartbeat: vi.fn().mockResolvedValue({
        nonce: 'heartbeat-nonce',
        signature: 'heartbeat-signature',
      }),
      trustStore,
    });

    const startingA = connection.start();
    await vi.waitFor(() => {
      expect(trustStore.loadTrustedDevices).toHaveBeenCalledOnce();
    });
    const switching = connection.setClient(clientB);
    firstLoad.resolve(undefined);
    await Promise.all([startingA, switching]);

    expect(durableSnapshots).toEqual([['account-b']]);
    expect((await trustStore.loadTrustedDevices()).map(record => record.accountId)).toEqual([
      'account-b',
    ]);
    await connection.stop();
  });

  it('cancels the active generation and disposes every generation-owned effect', async () => {
    vi.useFakeTimers();
    const {
      clearCloudAuthorizer,
      client,
      connection,
      network,
    } = setup();
    await connection.start();
    await connection.dispose();

    expect(clearCloudAuthorizer).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(network.clearRelayReservation).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(client.clearCachedTokens).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('produces a real CLI heartbeat that the Core/Cloud verifier accepts', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const identity = await createDeviceIdentity('cli', 'CLI heartbeat vector');
    let heartbeat: DeviceHeartbeatMessage | undefined;
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = request instanceof Request
        ? request.url
        : request instanceof URL
        ? request.href
        : request;
      const pathname = new URL(requestUrl).pathname;
      let body: unknown;
      switch (pathname) {
        case '/api/devices/connection-grant/public-key':
          body = { issuer: 'memeloop-cloud', publicKeyMultibase: 'zCloudKey' };
          break;
        case '/api/devices/binding/nonce':
          body = { nonce: 'binding-nonce', accountId: 'account-1', expiresAt: 'later' };
          break;
        case '/api/devices/register':
          body = { ok: true, peerId: identity.peerId };
          break;
        case '/api/devices/relay-reservation':
          body = {
            ...reservation(now + 10 * 60_000),
            peerId: identity.peerId,
            issuedAt: now,
          };
          break;
        case '/api/devices/heartbeat':
          if (typeof init?.body !== 'string') throw new TypeError('heartbeat body missing');
          heartbeat = JSON.parse(init.body) as DeviceHeartbeatMessage;
          body = { ok: true };
          break;
        case '/api/devices':
          body = { devices: [] };
          break;
        default:
          throw new Error(`unexpected Cloud request: ${pathname}`);
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new DeviceCloudClient('https://cloud.example.test', 'access-token');
    const trustStore = memorySnapshotTrustStore();
    const network = {
      clearRelayReservation: vi.fn(),
      configureRelayReservation: vi.fn(),
      getMultiaddrs: vi.fn().mockReturnValue(['/ip4/127.0.0.1/tcp/4001']),
      listCloudDeviceAddressPeerIds: vi.fn().mockReturnValue([]),
      removeCloudDeviceAddresses: vi.fn(),
      setCloudDeviceAddresses: vi.fn(),
    };
    const connection = new CliCloudConnection({
      capabilities: () => capabilities,
      client,
      clearCloudAuthorizer: vi.fn(),
      configureCloudAuthorizer: vi.fn(),
      heartbeatIntervalMs: 60_000,
      identity,
      network,
      now: () => now,
      trustStore,
    });

    await connection.start();
    await connection.stop();
    if (!heartbeat) throw new Error('heartbeat was not captured');
    const publicKey = await decodePublicKeyMultibase(identity.publicKeyMultibase);
    await expect(verifyDeviceHeartbeatMessage(heartbeat, {
      publicKeyMultibase: identity.publicKeyMultibase,
      now,
      consumeNonce: async () => true,
      verifyIdentity: async (input) =>
        input.peerId === identity.peerId &&
        input.publicKeyMultibase === identity.publicKeyMultibase &&
        await publicKey.verify(input.payload, Buffer.from(input.signature, 'base64url')),
    })).resolves.toBe(true);
  });
});

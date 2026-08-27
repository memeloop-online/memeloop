import { describe, expect, it, vi } from 'vitest';

import { type DeviceCloudCommitFence, DeviceCloudConnectionCoordinator } from '../deviceCloudConnectionCoordinator.js';
import { hasValidDirectCloudDeviceAddress, StandardDeviceCloudConnectionAdapter } from '../standardDeviceCloudConnectionAdapter.js';
import type {
  CloudDeviceClient,
  CloudDeviceRecord,
  DeviceCapabilities,
  DeviceRelayReservationToken,
  DeviceTrustStore,
  LocalDeviceIdentity,
  TrustedDeviceRecord,
} from '../types.js';

const identity: LocalDeviceIdentity = {
  peerId: 'peer-1',
  publicKeyMultibase: 'zPublicKey',
  privateKeyRef: 'test',
  privateKeyPkcs8Base64Url: 'secret-pkcs8',
  privateKeyRawSeedBase64Url: 'secret-seed',
  createdAt: 1,
  deviceName: 'Mobile',
  platform: 'mobile',
};

const capabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  imChannels: [],
  wikis: [],
};

function relayReservation(expiresAt: number): DeviceRelayReservationToken {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    peerId: 'peer-1',
    relayMultiaddrs: ['/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit'],
    bootstrapMultiaddrs: [],
    issuedAt: 1,
    expiresAt,
    signature: `signature-${expiresAt}`,
  };
}

function cloudDevice(): CloudDeviceRecord {
  return {
    accountId: 'account-1',
    peerId: 'peer-2',
    publicKeyMultibase: 'zPeer2Key',
    deviceName: 'Desktop',
    platform: 'desktop',
    capabilities,
    multiaddrs: ['/ip4/192.168.1.20/tcp/4001'],
    relayReservations: [],
    lastSeen: 1_000,
  };
}

function currentFence(signal: AbortSignal, generation = 0): DeviceCloudCommitFence {
  return {
    generation,
    signal,
    isCurrent: () => !signal.aborted,
    throwIfStale: () => {
      signal.throwIfAborted();
    },
    commitSynchronous: (operation) => {
      if (signal.aborted) return false;
      operation();
      return true;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function setup(options: {
  capabilities?: () => DeviceCapabilities | Promise<DeviceCapabilities>;
} = {}) {
  let now = 1_000;
  const client = {
    listDevices: vi.fn(async () => [cloudDevice()]),
    getConnectionGrantPublicKey: vi.fn(async () => ({
      issuer: 'memeloop-cloud' as const,
      publicKeyMultibase: 'zCloudKey',
    })),
    createConnectionGrant: vi.fn(),
    createRelayReservation: vi.fn()
      .mockResolvedValueOnce(relayReservation(2_000))
      .mockResolvedValueOnce(relayReservation(4_000)),
    createBindingNonce: vi.fn(async () => ({
      nonce: 'nonce-1',
      accountId: 'account-1',
      expiresAt: 'later',
    })),
    registerDevice: vi.fn(async () => ({ ok: true, peerId: 'peer-1' })),
    heartbeat: vi.fn(async () => ({ ok: true })),
  } satisfies CloudDeviceClient;
  const trustStore: DeviceTrustStore = {
    loadTrustedDevices: vi.fn(async (): Promise<TrustedDeviceRecord[]> => []),
    saveTrustedDevice: vi.fn(),
    removeTrustedDevice: vi.fn(),
  };
  const liveDirectory = {
    listCloudDeviceAddressPeerIds: vi.fn(async (): Promise<readonly string[]> => []),
    setCloudDeviceAddresses: vi.fn(),
    removeCloudDeviceAddresses: vi.fn(),
    upsertCloudDiscoveredDevice: vi.fn(),
    upsertCloudTrustedDevice: vi.fn(),
  };
  const network = {
    getMultiaddrs: vi.fn(() => ['/ip4/127.0.0.1/tcp/4001']),
    configureRelayReservation: vi.fn(),
    clearRelayReservation: vi.fn(),
  };
  const configureConnectionGrantPublicKey = vi.fn();
  const commitCloudDirectorySnapshot = vi.fn();
  const clearConnectionGrantPublicKey = vi.fn();
  const clearTokenCache = vi.fn();
  const signDeviceBinding = vi.fn(async () => 'binding-signature');
  const signHeartbeat = vi.fn(async () => ({
    nonce: 'heartbeat-nonce',
    signature: 'heartbeat-signature',
  }));
  const syncDevice = vi.fn(async (_client: CloudDeviceClient, peerId: string) => ({
    ok: true as const,
    peerId,
    syncedAt: 1,
    complete: true as const,
    progress: {
      passes: 1,
      peers: 1,
      frontierPages: 1,
      pages: 1,
      events: 1,
      bytes: 1,
      elapsedMs: 1,
    },
  }));
  const adapter = new StandardDeviceCloudConnectionAdapter({
    capabilities: options.capabilities ?? (() => capabilities),
    clearConnectionGrantPublicKey,
    clearTokenCache,
    commitCloudDirectorySnapshot,
    configureConnectionGrantPublicKey,
    identity,
    liveDirectory,
    network,
    now: () => now,
    relayTokenSafetyMarginMs: 100,
    signDeviceBinding,
    signHeartbeat,
    syncDevice,
    trustStore,
  });
  return {
    adapter,
    client,
    clearConnectionGrantPublicKey,
    clearTokenCache,
    commitCloudDirectorySnapshot,
    configureConnectionGrantPublicKey,
    liveDirectory,
    network,
    setNow: (value: number) => {
      now = value;
    },
    signDeviceBinding,
    signHeartbeat,
    syncDevice,
    trustStore,
  };
}

describe('StandardDeviceCloudConnectionAdapter', () => {
  it('defers durable authorizer, relay, and directory changes to commit', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    const fence = currentFence(signal);
    const authorizer = await setupValue.adapter.ensureAuthorizer(setupValue.client, signal);
    const relay = await setupValue.adapter.ensureRelay(setupValue.client, signal);
    const directory = await setupValue.adapter.syncDirectory(setupValue.client, signal);

    expect(setupValue.configureConnectionGrantPublicKey).not.toHaveBeenCalled();
    expect(setupValue.network.configureRelayReservation).not.toHaveBeenCalled();
    expect(setupValue.trustStore.loadTrustedDevices).not.toHaveBeenCalled();
    await authorizer.commit?.(fence);
    await relay?.commit?.(fence);
    await directory.commit?.(fence);

    expect(setupValue.configureConnectionGrantPublicKey).toHaveBeenCalledWith(
      {
        issuer: 'memeloop-cloud',
        publicKeyMultibase: 'zCloudKey',
      },
      signal,
      fence,
    );
    expect(setupValue.network.configureRelayReservation).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: 2_000 }),
      signal,
      fence,
    );
    expect(setupValue.commitCloudDirectorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudDevices: [cloudDevice()],
        excludePeerIds: ['peer-1'],
      }),
      fence,
    );
  });

  it('passes the generation fence through a delayed directory durable commit', async () => {
    const setupValue = setup();
    const controller = new AbortController();
    const releaseCommit = deferred<undefined>();
    const durableSnapshots: CloudDeviceRecord[][] = [];
    setupValue.commitCloudDirectorySnapshot.mockImplementation(async (
      input: { cloudDevices: readonly CloudDeviceRecord[] },
      fence: DeviceCloudCommitFence,
    ) => {
      await releaseCommit.promise;
      fence.commitSynchronous(() => {
        durableSnapshots.push([...input.cloudDevices]);
      });
    });
    const directory = await setupValue.adapter.syncDirectory(
      setupValue.client,
      controller.signal,
    );
    const committing = directory.commit?.(currentFence(controller.signal));

    controller.abort();
    releaseCommit.resolve(undefined);
    await expect(committing).rejects.toThrow();
    expect(durableSnapshots).toEqual([]);
  });

  it('feeds a committed Cloud directory into shared background device sync', async () => {
    const setupValue = setup();
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: setupValue.adapter,
      configuration: setupValue.client,
      heartbeatIntervalMs: 60_000,
    });

    await coordinator.start();
    expect(coordinator.snapshot.status).toBe('online');
    await vi.waitFor(() => {
      expect(setupValue.syncDevice).toHaveBeenCalledWith(
        setupValue.client,
        'peer-2',
        expect.any(AbortSignal),
      );
    });
    await coordinator.stop();
  });

  it('passes one abort signal through registration and heartbeat', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    await setupValue.adapter.registerDevice(setupValue.client, signal);
    await setupValue.adapter.heartbeat(setupValue.client, signal);

    expect(setupValue.client.createBindingNonce).toHaveBeenCalledWith(signal);
    expect(setupValue.signDeviceBinding).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(setupValue.client.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          peerId: 'peer-1',
          publicKeyMultibase: 'zPublicKey',
          createdAt: 1,
          deviceName: 'Mobile',
          platform: 'mobile',
        },
        cloudNonce: 'nonce-1',
        signature: 'binding-signature',
      }),
      signal,
    );
    const registrationCalls = setupValue.client.registerDevice.mock.calls as unknown as Array<[
      Parameters<CloudDeviceClient['registerDevice']>[0],
      AbortSignal?,
    ]>;
    const registration = registrationCalls[0]?.[0];
    expect(registration?.identity).not.toHaveProperty('privateKeyRef');
    expect(registration?.identity).not.toHaveProperty('privateKeyPkcs8Base64Url');
    expect(registration?.identity).not.toHaveProperty('privateKeyRawSeedBase64Url');
    expect(setupValue.client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'peer-1',
        timestamp: 1_000,
        nonce: 'heartbeat-nonce',
        signature: 'heartbeat-signature',
      }),
      signal,
    );
    expect(setupValue.signHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it('awaits a fresh asynchronous capability snapshot for registration and heartbeat', async () => {
    const registrationCapabilities = { ...capabilities, tools: ['wiki-search'] };
    const heartbeatCapabilities = { ...capabilities, tools: ['wiki-write'] };
    const capabilityProvider = vi.fn()
      .mockResolvedValueOnce(registrationCapabilities)
      .mockResolvedValueOnce(heartbeatCapabilities);
    const setupValue = setup({ capabilities: capabilityProvider });
    const signal = new AbortController().signal;

    await setupValue.adapter.registerDevice(setupValue.client, signal);
    await setupValue.adapter.heartbeat(setupValue.client, signal);

    expect(capabilityProvider).toHaveBeenCalledTimes(2);
    expect(setupValue.client.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: registrationCapabilities }),
      signal,
    );
    expect(setupValue.signHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: heartbeatCapabilities, signal }),
    );
    expect(setupValue.client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: heartbeatCapabilities }),
      signal,
    );
  });

  it.each(['registration', 'heartbeat'] as const)(
    'stops %s when cancellation wins while capabilities are loading',
    async operation => {
      const pendingCapabilities = deferred<DeviceCapabilities>();
      const capabilityProvider = vi.fn(() => pendingCapabilities.promise);
      const setupValue = setup({ capabilities: capabilityProvider });
      const controller = new AbortController();

      const pending = operation === 'registration'
        ? setupValue.adapter.registerDevice(setupValue.client, controller.signal)
        : setupValue.adapter.heartbeat(setupValue.client, controller.signal);
      await vi.waitFor(() => {
        expect(capabilityProvider).toHaveBeenCalledOnce();
      });
      controller.abort();
      pendingCapabilities.resolve(capabilities);

      await expect(pending).rejects.toThrow();
      if (operation === 'registration') {
        expect(setupValue.client.registerDevice).not.toHaveBeenCalled();
      } else {
        expect(setupValue.signHeartbeat).not.toHaveBeenCalled();
        expect(setupValue.client.heartbeat).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects negative Cloud registration and heartbeat acknowledgements', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    setupValue.client.registerDevice.mockResolvedValueOnce({ ok: false, peerId: 'peer-1' });
    await expect(setupValue.adapter.registerDevice(setupValue.client, signal)).rejects.toThrow(
      'registration rejected',
    );
    setupValue.client.registerDevice.mockResolvedValueOnce({ ok: true, peerId: 'other-peer' });
    await expect(setupValue.adapter.registerDevice(setupValue.client, signal)).rejects.toThrow(
      'registration rejected',
    );
    setupValue.client.heartbeat.mockResolvedValueOnce({ ok: false });
    await expect(setupValue.adapter.heartbeat(setupValue.client, signal)).rejects.toThrow(
      'heartbeat rejected',
    );
  });

  it('renews the applied relay token only inside its safety margin', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    const fence = currentFence(signal);
    const first = await setupValue.adapter.ensureRelay(setupValue.client, signal);
    await first?.commit?.(fence);
    setupValue.setNow(1_899);
    await expect(setupValue.adapter.ensureRelay(setupValue.client, signal)).resolves.toBeUndefined();
    setupValue.setNow(1_900);
    const renewed = await setupValue.adapter.ensureRelay(setupValue.client, signal);
    await renewed?.commit?.(fence);

    expect(setupValue.client.createRelayReservation).toHaveBeenCalledTimes(2);
    expect(setupValue.network.configureRelayReservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ expiresAt: 4_000 }),
      signal,
      fence,
    );
  });

  it('does not reuse a relay token across client configuration generations', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    const fence = currentFence(signal);
    const first = await setupValue.adapter.ensureRelay(setupValue.client, signal);
    await first?.commit?.(fence);
    const replacementClient: CloudDeviceClient = {
      ...setupValue.client,
      createRelayReservation: vi.fn(async () => relayReservation(3_000)),
    };
    const replacement = await setupValue.adapter.ensureRelay(replacementClient, signal);
    await replacement?.commit?.(fence);

    expect(replacementClient.createRelayReservation).toHaveBeenCalledOnce();
    expect(setupValue.network.configureRelayReservation).toHaveBeenCalledTimes(2);
  });

  it('clears old authorizer, relay, trust, addresses, and token cache on dispose', async () => {
    const setupValue = setup();
    const signal = new AbortController().signal;
    const fence = currentFence(signal);
    const relay = await setupValue.adapter.ensureRelay(setupValue.client, signal);
    await relay?.commit?.(fence);
    setupValue.liveDirectory.listCloudDeviceAddressPeerIds.mockResolvedValue(['peer-2']);
    setupValue.trustStore.loadTrustedDevices = vi.fn(async (): Promise<TrustedDeviceRecord[]> => [{
      peerId: 'peer-2',
      publicKeyMultibase: 'zPeer2Key',
      deviceName: 'Desktop',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 1,
    }]);

    await setupValue.adapter.dispose(setupValue.client, signal);

    expect(setupValue.clearConnectionGrantPublicKey).toHaveBeenCalledWith(signal);
    expect(setupValue.network.clearRelayReservation).toHaveBeenCalledWith(signal);
    expect(setupValue.trustStore.removeTrustedDevice).toHaveBeenCalledWith('peer-2');
    expect(setupValue.liveDirectory.removeCloudDeviceAddresses).toHaveBeenCalledWith('peer-2');
    expect(setupValue.clearTokenCache).toHaveBeenCalledWith(setupValue.client, signal);
    await setupValue.adapter.registerDevice(setupValue.client, signal);
    expect(setupValue.client.registerDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ relayReservations: [] }),
      signal,
    );
  });

  it('removes the old account generation when coordinator configuration is cleared', async () => {
    const setupValue = setup();
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: setupValue.adapter,
      configuration: setupValue.client,
      heartbeatIntervalMs: 60_000,
    });
    await coordinator.start();
    setupValue.liveDirectory.listCloudDeviceAddressPeerIds.mockResolvedValue(['peer-2']);
    setupValue.trustStore.loadTrustedDevices = vi.fn(async (): Promise<TrustedDeviceRecord[]> => [{
      peerId: 'peer-2',
      publicKeyMultibase: 'zPeer2Key',
      deviceName: 'Desktop',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 1,
    }]);

    await coordinator.setConfiguration(undefined);

    expect(coordinator.snapshot.status).toBe('not-configured');
    expect(setupValue.clearConnectionGrantPublicKey).toHaveBeenCalledOnce();
    expect(setupValue.network.clearRelayReservation).toHaveBeenCalledOnce();
    expect(setupValue.liveDirectory.removeCloudDeviceAddresses).toHaveBeenCalledWith('peer-2');
    expect(setupValue.clearTokenCache).toHaveBeenCalledWith(
      setupValue.client,
      expect.any(AbortSignal),
    );
    await coordinator.stop();
  });

  it('detects only externally dialable direct addresses', () => {
    expect(hasValidDirectCloudDeviceAddress([
      '/ip4/0.0.0.0/tcp/4001',
      '/ip4/127.0.0.1/tcp/4001',
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
    ])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/192.168.1.20/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/10.1.2.3/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/100.64.1.2/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/169.254.1.2/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/172.31.1.2/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/192.0.2.1/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/dns4/127.0.0.1/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/dns4/api.localhost./tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip6/fd00::1/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip6/fe80::1/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip6/2001:db8::1/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip6/not:an:address/tcp/4001'])).toBe(false);
    expect(hasValidDirectCloudDeviceAddress(['/ip4/8.8.8.8/tcp/4001'])).toBe(true);
    expect(hasValidDirectCloudDeviceAddress(['/ip6/2606:4700:4700::1111/tcp/4001'])).toBe(true);
    expect(hasValidDirectCloudDeviceAddress(['/dns4/device.memeloop.io/tcp/443/wss'])).toBe(true);
  });

  it('rejects incomplete, non-dialable, special-use and wrong-PeerId addresses', () => {
    const peerId = '12D3KooWlocal';
    for (
      const address of [
        '/ip4/8.8.8.8',
        '/ip4/8.8.8.8/tcp',
        '/ip4/8.8.8.8/tcp/0',
        '/ip4/8.8.8.8/tcp/65536',
        '/ip4/8.8.8.8/udp/443/quic-v1',
        '/ip4/8.8.8.8/tcp/443/garbage',
        '/dns4/device.example/tcp/443/wss',
        '/dns4/device.test/tcp/443/wss',
        '/dns4/device.invalid/tcp/443/wss',
        '/dns4/device.home.arpa/tcp/443/wss',
        '/dns4/device.memeloop.io/tcp/443/wss/p2p/12D3KooWother',
        '/dns4/device.memeloop.io/tcp/443/wss/p2p/12D3KooWlocal/extra',
      ]
    ) {
      expect(hasValidDirectCloudDeviceAddress([address], peerId), address).toBe(false);
    }

    expect(hasValidDirectCloudDeviceAddress([
      `/dns4/device.memeloop.io/tcp/443/wss/p2p/${peerId}`,
    ], peerId)).toBe(true);
    expect(hasValidDirectCloudDeviceAddress([
      `/ip4/8.8.8.8/tcp/4001/p2p/${peerId}`,
    ], peerId)).toBe(true);
  });
});

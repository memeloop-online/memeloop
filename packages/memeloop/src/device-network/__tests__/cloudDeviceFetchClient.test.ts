import { describe, expect, it, vi } from 'vitest';

import { type CloudDeviceFetch, CloudDeviceFetchClient, type DeviceCloudTokenStorage, normalizeCloudDeviceBaseUrl } from '../cloudDeviceFetchClient.js';
import type { DeviceCloudCommitFence, DeviceConnectionGrant, DeviceRelayReservationToken, LocalDeviceIdentity } from '../types.js';

const identity: LocalDeviceIdentity = {
  peerId: 'peer-1',
  publicKeyMultibase: 'zPublicKey',
  privateKeyRef: 'test',
  createdAt: 1,
  deviceName: 'Browser',
  platform: 'web',
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('CloudDeviceFetchClient', () => {
  it('uses injected fetch, credentials, token supplier, signal, and audited paths', async () => {
    const responses: unknown[] = [
      { nonce: 'nonce-1', accountId: 'account-1', expiresAt: 'later' },
      { ok: true, peerId: 'peer-1' },
      { devices: [] },
      { issuer: 'memeloop-cloud', publicKeyMultibase: 'zCloudKey' },
      relayReservation(5_000),
      { ok: true },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift())));
    const tokenSupplier = vi.fn(async () => ' access-token ');
    const client = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test/',
      credentials: 'include',
      fetch: fetchMock as CloudDeviceFetch,
      getAccessToken: tokenSupplier,
      now: () => 1_000,
      tokenSafetyMarginMs: 100,
    });
    const controller = new AbortController();

    await client.createBindingNonce(controller.signal);
    await client.registerDevice({
      identity,
      cloudNonce: 'nonce-1',
      signature: 'binding-signature',
      capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
      multiaddrs: [],
      relayReservations: [],
    }, controller.signal);
    await client.listDevices(controller.signal);
    await client.getConnectionGrantPublicKey(controller.signal);
    await client.createRelayReservation({ peerId: 'peer-1' }, controller.signal);
    await client.heartbeat({
      peerId: 'peer-1',
      timestamp: 1_000,
      nonce: 'heartbeat-nonce',
      capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
      multiaddrs: [],
      relayReservations: [],
      signature: 'heartbeat-signature',
    }, controller.signal);

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(fetchCalls.map(call => call[0])).toEqual([
      'https://cloud.example.test/api/devices/binding/nonce',
      'https://cloud.example.test/api/devices/register',
      'https://cloud.example.test/api/devices',
      'https://cloud.example.test/api/devices/connection-grant/public-key',
      'https://cloud.example.test/api/devices/relay-reservation',
      'https://cloud.example.test/api/devices/heartbeat',
    ]);
    for (const [, init] of fetchCalls) {
      expect(init).toEqual(expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ authorization: 'Bearer access-token' }),
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }));
    }
    expect(tokenSupplier).toHaveBeenCalledTimes(6);
  });

  it('propagates caller abort to the injected fetch', async () => {
    let requestSignal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => {
      markFetchStarted = resolve;
    });
    const fetchImplementation: CloudDeviceFetch = async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      markFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(
            requestSignal?.reason instanceof Error
              ? requestSignal.reason
              : new Error('request aborted'),
          );
        }, { once: true });
      });
    };
    const client = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      fetch: fetchImplementation,
    });
    const controller = new AbortController();
    const reason = new Error('superseded');
    const pending = client.listDevices(controller.signal);
    await fetchStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('fails closed on HTTP errors, invalid JSON, invalid shapes, and response bounds', async () => {
    const httpClient = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      errorMaxCharacters: 6,
      fetch: vi.fn(async () => new Response('secret-error-body', { status: 401 })),
    });
    await expect(httpClient.listDevices()).rejects.toMatchObject({
      code: 'cloud_http_error',
      responseBody: 'secret',
      status: 401,
    });

    const invalidFetch = vi.fn()
      .mockResolvedValueOnce(new Response('not-json'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ devices: 'invalid' })));
    const invalidClient = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      fetch: invalidFetch as CloudDeviceFetch,
    });
    await expect(invalidClient.listDevices()).rejects.toMatchObject({
      code: 'cloud_response_invalid_json',
    });
    await expect(invalidClient.listDevices()).rejects.toMatchObject({
      code: 'cloud_response_invalid_shape',
    });

    const boundsClient = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      fetch: vi.fn(async () => new Response('{}', { headers: { 'content-length': '5' } })),
      responseMaxBytes: 4,
    });
    await expect(boundsClient.listDevices()).rejects.toMatchObject({
      code: 'cloud_response_too_large',
    });
  });

  it('rejects unscoped grants and caches only the exact canonical requested scope', async () => {
    const request = {
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2'],
      protocols: ['/memeloop/rpc/2.0.0'] as const,
      rpcMethodScope: { mode: 'ids' as const, ids: ['memeloop.agent.runTurn'] },
      conversationScope: { mode: 'ids' as const, ids: ['conversation-1'] },
      definitionScope: { mode: 'ids' as const, ids: ['definition-1'] },
    };
    const grant: DeviceConnectionGrant = {
      ...request,
      protocols: [...request.protocols],
      rpcMethodScope: { ...request.rpcMethodScope, ids: [...request.rpcMethodScope.ids] },
      conversationScope: { ...request.conversationScope, ids: [...request.conversationScope.ids] },
      definitionScope: { ...request.definitionScope, ids: [...request.definitionScope.ids] },
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      issuedAt: 1,
      expiresAt: 2_000,
      signature: 'grant-signature',
    };
    const renewedGrant: DeviceConnectionGrant = {
      ...grant,
      expiresAt: 4_000,
      signature: 'renewed-grant-signature',
    };
    let now = 1_000;
    let cached: unknown = {
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2'],
      issuedAt: 1,
      expiresAt: 2_000,
      signature: 'legacy-unscoped-grant',
    };
    const storage: DeviceCloudTokenStorage = {
      loadConnectionGrant: vi.fn(async () => cached),
      saveConnectionGrant: vi.fn(async (_input, value) => {
        cached = value;
      }),
      loadRelayReservation: vi.fn(),
      saveRelayReservation: vi.fn(),
      clear: vi.fn(),
    };
    const networkGrants = [grant, renewedGrant];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(networkGrants.shift())));
    const client = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      fetch: fetchMock as CloudDeviceFetch,
      now: () => now,
      tokenSafetyMarginMs: 100,
      tokenStorage: storage,
    });

    await expect(client.createConnectionGrant({
      ...request,
      protocols: [...request.protocols],
      rpcMethodScope: { ...request.rpcMethodScope, ids: [...request.rpcMethodScope.ids] },
      conversationScope: { ...request.conversationScope, ids: [...request.conversationScope.ids] },
      definitionScope: { ...request.definitionScope, ids: [...request.definitionScope.ids] },
    })).resolves.toEqual(grant);
    await expect(client.createConnectionGrant({
      ...request,
      protocols: [...request.protocols],
    })).resolves.toEqual(grant);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(storage.saveConnectionGrant).toHaveBeenCalledOnce();
    now = 1_900;
    await expect(client.createConnectionGrant({
      ...request,
      protocols: [...request.protocols],
    })).resolves.toEqual(renewedGrant);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.saveConnectionGrant).toHaveBeenCalledTimes(2);
    await expect(client.createConnectionGrant({
      ...request,
      protocols: [...request.protocols],
      rpcMethodScope: { mode: 'ids', ids: ['z.method', 'a.method'] },
    })).rejects.toThrow('invalid_connection_grant_scope');
  });

  it('reuses injected relay storage until expiry plus the safety margin requires renewal', async () => {
    let now = 1_000;
    let cached: unknown = relayReservation(2_000);
    const storage: DeviceCloudTokenStorage = {
      loadConnectionGrant: vi.fn(),
      saveConnectionGrant: vi.fn(),
      loadRelayReservation: vi.fn(async () => cached),
      saveRelayReservation: vi.fn(async (_peerId, token) => {
        cached = token;
      }),
      clear: vi.fn(() => {
        cached = undefined;
      }),
    };
    const networkReservations = [relayReservation(4_000), relayReservation(6_000)];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(networkReservations.shift())));
    const client = new CloudDeviceFetchClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      fetch: fetchMock as CloudDeviceFetch,
      now: () => now,
      tokenSafetyMarginMs: 100,
      tokenStorage: storage,
    });

    await expect(client.createRelayReservation({ peerId: 'peer-1' })).resolves
      .toMatchObject({ expiresAt: 2_000 });
    expect(fetchMock).not.toHaveBeenCalled();

    now = 1_900;
    await expect(client.createRelayReservation({ peerId: 'peer-1' })).resolves
      .toMatchObject({ expiresAt: 4_000 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(storage.saveRelayReservation).toHaveBeenCalledOnce();
    await client.clearCachedTokens();
    now = 2_000;
    await expect(client.createRelayReservation({ peerId: 'peer-1' })).resolves
      .toMatchObject({ expiresAt: 6_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['connection grant', 'relay reservation'] as const)(
    'rejects a stale generation at the final durable %s token write',
    async tokenKind => {
      const saveEntered = deferred<undefined>();
      const releaseSave = deferred<undefined>();
      let current = true;
      let durableToken: unknown;
      let receivedFence: DeviceCloudCommitFence | undefined;
      const controller = new AbortController();
      const fence: DeviceCloudCommitFence = {
        generation: 7,
        signal: controller.signal,
        isCurrent: () => current && !controller.signal.aborted,
        throwIfStale: () => {
          if (!current || controller.signal.aborted) throw new Error('stale-generation');
        },
        commitSynchronous: (operation) => {
          if (!current || controller.signal.aborted) return false;
          operation();
          return true;
        },
      };
      const persist = async (value: unknown, writeFence?: DeviceCloudCommitFence) => {
        receivedFence = writeFence;
        saveEntered.resolve(undefined);
        await releaseSave.promise;
        if (
          !writeFence?.commitSynchronous(() => {
            durableToken = value;
          })
        ) writeFence?.throwIfStale();
      };
      const storage: DeviceCloudTokenStorage = {
        loadConnectionGrant: vi.fn(),
        saveConnectionGrant: vi.fn(async (_input, grant, writeFence) => persist(grant, writeFence)),
        loadRelayReservation: vi.fn(),
        saveRelayReservation: vi.fn(async (_peerId, token, writeFence) => persist(token, writeFence)),
        clear: vi.fn(),
      };
      const grantRequest = {
        subjectPeerId: 'peer-1',
        allowedPeerIds: ['peer-2'],
        protocols: ['/memeloop/rpc/2.0.0'] as const,
        rpcMethodScope: { mode: 'ids' as const, ids: ['memeloop.agent.runTurn'] },
        conversationScope: { mode: 'ids' as const, ids: ['conversation-1'] },
        definitionScope: { mode: 'ids' as const, ids: ['definition-1'] },
      };
      const networkValue = tokenKind === 'connection grant'
        ? {
          ...grantRequest,
          protocols: [...grantRequest.protocols],
          issuer: 'memeloop-cloud' as const,
          accountId: 'account-1',
          issuedAt: 1,
          expiresAt: 5_000,
          signature: 'grant-signature',
        }
        : relayReservation(5_000);
      const client = new CloudDeviceFetchClient({
        baseUrl: 'https://cloud.example.test',
        accessToken: 'token',
        fetch: vi.fn(async () => new Response(JSON.stringify(networkValue))),
        now: () => 1_000,
        tokenSafetyMarginMs: 100,
        tokenStorage: storage,
      });

      const pending = tokenKind === 'connection grant'
        ? client.createConnectionGrant(
          {
            ...grantRequest,
            protocols: [...grantRequest.protocols],
          },
          controller.signal,
          fence,
        )
        : client.createRelayReservation({ peerId: 'peer-1' }, controller.signal, fence);
      await saveEntered.promise;
      current = false;
      controller.abort(new Error('old-generation-aborted'));
      releaseSave.resolve(undefined);

      await expect(pending).rejects.toThrow('stale-generation');
      expect(receivedFence).toBe(fence);
      expect(durableToken).toBeUndefined();
    },
  );

  it('normalizes secure origins and rejects unsafe or over-specified URLs', () => {
    expect(normalizeCloudDeviceBaseUrl(' https://cloud.example.test/ '))
      .toBe('https://cloud.example.test');
    expect(normalizeCloudDeviceBaseUrl('http://127.0.0.1:4000'))
      .toBe('http://127.0.0.1:4000');
    expect(() => normalizeCloudDeviceBaseUrl('http://cloud.example.test'))
      .toThrow('cloud_url_requires_https');
    expect(() => normalizeCloudDeviceBaseUrl('https://cloud.example.test/api'))
      .toThrow('invalid_cloud_url');
    expect(() => normalizeCloudDeviceBaseUrl('https://user:secret@cloud.example.test'))
      .toThrow('invalid_cloud_url');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createDeviceIdentity, Libp2pDeviceNetworkService } from '@memeloop/libp2p';
import type {
  AgentOrchestrationClient,
  DeviceTrustStore,
  MemeLoopDuplexStream,
  OrchestrationResourceManifest,
  OrchestrationResourceReference,
  RemoteOrchestrationRequest,
  RemoteOrchestrationResponse,
  TrustedDeviceRecord,
} from 'memeloop';
import {
  createControlStoreOrchestrationClient,
  createDeviceOrchestrationTransport,
  createJsonFrameReader,
  createRemoteOrchestrationClient,
  encodeJsonFrame,
  QuorumControlStore,
} from 'memeloop';
import { createOrdinaryPeerOrchestrationHandler, ordinaryPeerNamespace } from '../ordinaryPeerOrchestration.js';

function streamFor(request: RemoteOrchestrationRequest): {
  stream: MemeLoopDuplexStream;
  responses: RemoteOrchestrationResponse[];
} {
  const responses: RemoteOrchestrationResponse[] = [];
  return {
    responses,
    stream: {
      source: (async function*() {
        yield encodeJsonFrame({
          type: 'memeloop-device-orchestration-request-v2',
          request,
        });
      })(),
      async sink(source) {
        for await (
          const value of createJsonFrameReader(source, {
            maxPayloadBytes: 1024 * 1024,
            idleTimeoutMs: 100,
            totalTimeoutMs: 100,
          })
        ) responses.push(value as RemoteOrchestrationResponse);
      },
      async close() {},
      abort() {},
    },
  };
}

function client(): AgentOrchestrationClient & {
  apply: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  return {
    getCapabilities: vi.fn(async () => ({
      operations: ['apply', 'get', 'list', 'watch', 'delete'],
      resourceKinds: ['AgentWorkload', 'AgentRun', 'ToolOperation', 'CredentialGrant'],
      interfaces: ['resource'],
    })),
    apply: vi.fn(async (resource: OrchestrationResourceManifest) => resource),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], resourceVersion: '1' })),
    watch: vi.fn(() => (async function*() {})()),
    delete: vi.fn(async (reference: OrchestrationResourceReference) => ({
      accepted: true,
      reference,
    })),
  } as unknown as AgentOrchestrationClient & {
    apply: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
}

function memoryTrustStore(): DeviceTrustStore {
  const records = new Map<string, TrustedDeviceRecord>();
  return {
    async loadTrustedDevices() {
      return [...records.values()];
    },
    async saveTrustedDevice(record) {
      records.set(record.peerId, record);
    },
    async removeTrustedDevice(peerId) {
      records.delete(peerId);
    },
  };
}

describe('ordinary peer orchestration production boundary', () => {
  it('derives stable isolated namespaces from authenticated peer identities', () => {
    expect(ordinaryPeerNamespace('12D3KooWpeer-a')).toMatch(/^peer-[a-f0-9]{32}$/);
    expect(ordinaryPeerNamespace('12D3KooWpeer-a')).toBe(
      ordinaryPeerNamespace('12D3KooWpeer-a'),
    );
    expect(ordinaryPeerNamespace('12D3KooWpeer-a')).not.toBe(
      ordinaryPeerNamespace('12D3KooWpeer-b'),
    );
    expect(() => ordinaryPeerNamespace(' ')).toThrow('must not be empty');
  });

  it('binds a submitted workload to the Noise-authenticated peer namespace', async () => {
    const source = client();
    const handler = createOrdinaryPeerOrchestrationHandler(source);
    const request: RemoteOrchestrationRequest = {
      protocol: 'memeloop.resource.v2',
      requestId: 'apply-1',
      operation: 'apply',
      payload: {
        resource: {
          apiVersion: 'workload.memeloop.io/v1alpha1',
          kind: 'AgentWorkload',
          metadata: { name: 'game-build' },
          spec: { runtimeClass: 'native' },
        },
        options: { idempotencyKey: 'game-build-v1' },
      },
    };
    const { stream, responses } = streamFor(request);

    await handler({
      remotePeerId: '12D3KooWpeer-a',
      stream,
      authorize: async () => true,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: 'apply-1', ok: true });
    expect(source.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          namespace: ordinaryPeerNamespace('12D3KooWpeer-a'),
        }),
      }),
      expect.objectContaining({ idempotencyKey: 'game-build-v1' }),
    );
  });

  it('denies privileged resources and failed transport authorization before mutation', async () => {
    const source = client();
    const handler = createOrdinaryPeerOrchestrationHandler(source);
    const forbidden = streamFor({
      protocol: 'memeloop.resource.v2',
      requestId: 'credential-1',
      operation: 'list',
      payload: { query: { kind: 'CredentialGrant' } },
    });
    await handler({
      remotePeerId: '12D3KooWpeer-a',
      stream: forbidden.stream,
      authorize: async () => true,
    });
    expect(forbidden.responses[0]).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });

    const unauthorized = streamFor({
      protocol: 'memeloop.resource.v2',
      requestId: 'apply-2',
      operation: 'apply',
      payload: {
        resource: {
          apiVersion: 'workload.memeloop.io/v1alpha1',
          kind: 'AgentWorkload',
          metadata: { name: 'denied' },
          spec: {},
        },
      },
    });
    await expect(
      handler({
        remotePeerId: 'untrusted-peer',
        stream: unauthorized.stream,
        authorize: async () => false,
      }),
    ).rejects.toThrow('device_not_trusted');
    expect(source.apply).not.toHaveBeenCalled();
  });

  it('keeps AgentRun status readable but controller-owned against apply/delete', async () => {
    const source = client();
    const handler = createOrdinaryPeerOrchestrationHandler(source);
    const capabilities = streamFor({
      protocol: 'memeloop.resource.v2',
      requestId: 'peer-capabilities',
      operation: 'capabilities',
      payload: {},
    });
    await handler({
      remotePeerId: '12D3KooWpeer-a',
      stream: capabilities.stream,
      authorize: async () => true,
    });
    expect(capabilities.responses[0]).toMatchObject({
      ok: true,
      result: {
        resourceOperations: {
          AgentWorkload: ['apply', 'get', 'list', 'watch', 'delete'],
          AgentRun: ['get', 'list', 'watch'],
          ToolOperation: ['apply', 'get', 'list', 'watch', 'delete'],
        },
      },
    });
    for (const operation of ['apply', 'delete'] as const) {
      const exchange = streamFor({
        protocol: 'memeloop.resource.v2',
        requestId: `run-${operation}`,
        operation,
        payload: operation === 'apply'
          ? {
            resource: {
              apiVersion: 'execution.memeloop.io/v1alpha1',
              kind: 'AgentRun',
              metadata: { name: 'workload-run' },
              spec: {
                workloadRef: {
                  apiVersion: 'execution.memeloop.io/v1alpha1',
                  kind: 'AgentWorkload',
                  name: 'workload',
                },
              },
            },
          }
          : {
            reference: {
              apiVersion: 'execution.memeloop.io/v1alpha1',
              kind: 'AgentRun',
              name: 'workload-run',
            },
          },
      });
      await handler({
        remotePeerId: '12D3KooWpeer-a',
        stream: exchange.stream,
        authorize: async () => true,
      });
      expect(exchange.responses[0]).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
    }
    expect(source.apply).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
  });

  it('exchanges submit, status, and cancel over a real mutually paired Noise connection', {
    timeout: 20_000,
  }, async () => {
    const store = new QuorumControlStore({ memberId: 'remote-node', voters: ['remote-node'] });
    const source = createControlStoreOrchestrationClient(store, {
      id: 'controller/ordinary-peer-test',
      kind: 'controller',
    });
    const remoteIdentity = await createDeviceIdentity('desktop', 'Remote compute node');
    const remote = new Libp2pDeviceNetworkService({
      identity: remoteIdentity,
      trustStore: memoryTrustStore(),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      orchestrationHandler: createOrdinaryPeerOrchestrationHandler(source),
    });
    const localIdentity = await createDeviceIdentity('cli', 'Local controller');
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: memoryTrustStore(),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
    });
    await remote.start();
    await local.start();
    const remoteClient = createRemoteOrchestrationClient(
      createDeviceOrchestrationTransport({
        deviceNetwork: local,
        peerId: remoteIdentity.peerId,
      }),
      { createRequestId: () => crypto.randomUUID() },
    );

    try {
      await expect(
        remoteClient.list({ kind: 'AgentRun' }),
      ).rejects.toThrow('device_not_trusted');

      const outbound = await local.requestLocalPairing(remoteIdentity.peerId, {
        multiaddrs: remote.getMultiaddrs(),
      });
      const inbound = (await remote.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
      expect(inbound?.confirmCode).toBe(outbound.confirmCode);
      await remote.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      const created = await remoteClient.apply({
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        metadata: { name: 'cross-machine-game-build' },
        spec: { runtimeClass: 'native' },
      }, { idempotencyKey: 'cross-machine-game-build-v1' });
      const status = await remoteClient.get({
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: 'cross-machine-game-build',
      });
      await remoteClient.delete({
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: 'cross-machine-game-build',
      }, { idempotencyKey: 'cross-machine-game-build-cancel-v1' });

      const namespace = ordinaryPeerNamespace(localIdentity.peerId);
      expect(created.metadata.namespace).toBe(namespace);
      expect(status?.metadata.uid).toBe(created.metadata.uid);
      await expect(store.get({
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: 'cross-machine-game-build',
        namespace,
      })).resolves.toBeNull();
    } finally {
      await local.stop();
      await remote.stop();
    }
  });
});

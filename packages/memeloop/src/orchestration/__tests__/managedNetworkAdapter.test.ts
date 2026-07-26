import { describe, expect, it, vi } from 'vitest';

import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedNetworkAdapter } from '../drivers/managedNetworkAdapter.js';
import type { NetworkDriver } from '../drivers/networkDriver.js';
import type { NetworkPreparePayload } from '../drivers/networkManagement.js';
import type { NetworkAttachmentResource, NetworkClassResource } from '../resources.js';

const now = () => new Date('2026-07-26T14:00:00.000Z');
const attachment: NetworkAttachmentResource = {
  apiVersion: 'network.memeloop.io/v1alpha1',
  kind: 'NetworkAttachment',
  metadata: {
    name: 'network-1',
    uid: 'network-uid-1',
    generation: 1,
    resourceVersion: '8',
    creationTimestamp: '',
  },
  spec: {
    networkClassRef: {
      apiVersion: 'network.memeloop.io/v1alpha1',
      kind: 'NetworkClass',
      name: 'process-net',
    },
    runRef: {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
      uid: 'run-uid-1',
    },
  },
};
const networkClass: NetworkClassResource = {
  apiVersion: 'network.memeloop.io/v1alpha1',
  kind: 'NetworkClass',
  metadata: {
    name: 'process-net',
    uid: 'class-uid',
    generation: 1,
    resourceVersion: '5',
    creationTimestamp: '',
  },
  spec: {
    driver: 'process-env',
    proxy: { httpsProxy: 'http://proxy.test' },
    enforcement: 'best-effort',
  },
};
const payload: NetworkPreparePayload = {
  sandboxHandle: 'workload:run-1',
  networkClass: 'process-net',
  networkClassDigest: `sha256:${'a'.repeat(64)}`,
  requestedFeatures: ['proxy'],
  minimumEnforcementLevel: 'process',
  trustClass: 'trusted',
  policy: {
    digest: `sha256:${'b'.repeat(64)}`,
    proxy: { httpsProxy: 'http://proxy.test' },
  },
};

function request<T>(
  method: string,
  value: T,
  key = method,
  resourceUid = attachment.metadata.uid,
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: attachment.apiVersion,
      kind: attachment.kind,
      name: attachment.metadata.name,
      uid: resourceUid,
      generation: attachment.metadata.generation,
    },
    run: { uid: 'run-uid-1', attempt: 1 },
    fencingEpoch: 3,
    requestId: `${method}:${key}`,
    idempotencyKey: key,
    deadline: '2026-07-26T14:01:00.000Z',
    actor: { id: 'controller/network', kind: 'controller' },
    session: { id: 'node-session-1' },
    capabilityHandleRef: 'capability:valid',
    trace: { traceId: 'trace-1', spanId: key },
    payloadSchemaDigest: `sha256:${'c'.repeat(64)}`,
    payload: value,
  };
}

function nativeDriver() {
  const statuses = new Map<string, Awaited<ReturnType<NetworkDriver['prepare']>>>();
  const driver: NetworkDriver = {
    getCapabilities: async () => ({
      name: 'process-env',
      enforcedFeatures: ['proxy'],
      enforcementLevel: 'process',
    }),
    prepare: vi.fn(async () => {
      const status = { phase: 'Attached' as const, handle: 'native:1', attachedAt: now().toISOString() };
      statuses.set('native:1', status);
      return status;
    }),
    check: vi.fn(async (handle) => statuses.get(handle) ?? null),
    update: vi.fn(),
    resolveService: vi.fn(async () => 'gateway://default'),
    release: vi.fn(async (handle) => {
      statuses.delete(handle);
    }),
    getHealth: async () => ({ healthy: true, checkedAt: now().toISOString() }),
  };
  return driver;
}

function adapter(driver = nativeDriver()) {
  return {
    driver,
    managed: createManagedNetworkAdapter(driver, {
      supportedTrustClasses: ['trusted'],
      threatAssumptions: ['environment policy is cooperative, not a hostile-process boundary'],
      maxPolicyRules: 32,
      now,
      verifyCapability: (value) =>
        value.capabilityHandleRef === 'capability:valid' &&
        value.session?.id === 'node-session-1',
      resolveAttachRequest: async () => ({
        attachRequest: { attachment, networkClass, sandboxRef: payload.sandboxHandle },
        networkClassDigest: payload.networkClassDigest,
        policyDigest: payload.policy.digest,
      }),
    }),
  };
}

describe('managed network adapter', () => {
  it('binds authority and desired-state digests around the native lifecycle', async () => {
    const { driver, managed } = adapter();
    const first = await managed.prepareNetwork(request('network.prepare', payload, 'prepare'));
    const replay = await managed.prepareNetwork(request('network.prepare', payload, 'prepare'));
    expect(first).toMatchObject({
      networkHandle: 'native:1',
      resourceUid: attachment.metadata.uid,
      enforcementLevel: 'process',
      verifiedFeatures: ['proxy'],
    });
    expect(replay.networkHandle).toBe(first.networkHandle);
    expect(driver.prepare).toHaveBeenCalledOnce();

    await expect(managed.resolveService(request(
      'network.resolve-service',
      { networkHandle: first.networkHandle, serviceName: 'model-gateway' },
      'resolve',
    ))).resolves.toMatchObject({ serviceHandle: 'gateway://default' });
    await managed.releaseNetwork(request(
      'network.release',
      { networkHandle: first.networkHandle },
      'release',
    ));
    expect(driver.release).toHaveBeenCalledWith('native:1');
  });

  it('rejects invalid capabilities, foreign handles, digest drift, and idempotency drift', async () => {
    const { managed } = adapter();
    await expect(managed.prepareNetwork({
      ...request('network.prepare', payload, 'bad-capability'),
      capabilityHandleRef: 'capability:forged',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const network = await managed.prepareNetwork(request('network.prepare', payload, 'valid'));
    await expect(managed.checkNetwork(request(
      'network.check',
      { networkHandle: network.networkHandle },
      'foreign',
      'foreign-resource',
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(managed.prepareNetwork(request(
      'network.prepare',
      { ...payload, sandboxHandle: 'different' },
      'valid',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    const drifted = adapter();
    const original = drifted.managed;
    await expect(original.prepareNetwork({
      ...request('network.prepare', payload, 'digest-drift'),
      payload: { ...payload, networkClassDigest: `sha256:${'d'.repeat(64)}` },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(managed.prepareNetwork(request(
      'network.prepare',
      {
        ...payload,
        policy: {
          ...payload.policy,
          serviceAllowlist: Array.from({ length: 33 }, (_, index) => `service-${index}`),
        },
      },
      'too-many-rules',
    ))).rejects.toMatchObject({ code: 'EXHAUSTED' });
  });

  it('reports process-local lifecycle and refuses in-place policy mutation', async () => {
    const { managed } = adapter();
    await expect(managed.getCapabilities()).resolves.toMatchObject({
      persistence: 'process',
      supportsPolicyUpdate: false,
      enforcementLevel: 'process',
    });
    const network = await managed.prepareNetwork(request('network.prepare', payload, 'policy'));
    await expect(managed.updatePolicy(request(
      'network.update-policy',
      {
        networkHandle: network.networkHandle,
        requestedFeatures: ['proxy'] as const,
        minimumEnforcementLevel: 'process' as const,
        policy: payload.policy,
      },
      'update',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

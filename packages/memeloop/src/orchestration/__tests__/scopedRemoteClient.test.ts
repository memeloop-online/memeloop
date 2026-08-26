import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationCapabilities, AgentOrchestrationClient, OrchestrationResourceManifest, OrchestrationResourceReference } from '../client.js';
import { createNamespacedOrchestrationClient, createReadOnlyOrchestrationClient } from '../remoteClient.js';

describe('read-only remote orchestration policy', () => {
  it('advertises and delegates only allowed read operations and resource kinds', async () => {
    const source = {
      getCapabilities: vi.fn(async () => ({
        operations: ['apply', 'get', 'list', 'watch', 'delete'] as const,
        resourceKinds: ['AgentRun', 'CredentialGrant'],
        interfaces: ['resource'] as const,
      })),
      apply: vi.fn(),
      get: vi.fn(async () => null),
      list: vi.fn(async () => ({ items: [], resourceVersion: '1' })),
      async *watch() {
        yield { type: 'BOOKMARK' as const, resourceVersion: '1' };
      },
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const client = createReadOnlyOrchestrationClient(source, {
      allowedResourceKinds: ['AgentRun'],
    });

    await expect(client.getCapabilities()).resolves.toEqual({
      operations: ['get', 'list', 'watch'],
      resourceKinds: ['AgentRun'],
      interfaces: ['resource'],
    });
    await expect(
      client.get({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run-1',
      }),
    ).resolves.toBeNull();
    await expect(client.list({ kind: 'AgentRun' })).resolves.toMatchObject({
      resourceVersion: '1',
    });
  });

  it('rejects mutations and resources outside the explicit mobile scope', async () => {
    const source = {
      getCapabilities: vi.fn(async () => ({
        operations: ['apply', 'get', 'list', 'watch', 'delete'],
        resourceKinds: ['AgentRun', 'CredentialGrant'],
        interfaces: ['resource'],
      })),
      apply: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      watch: vi.fn(),
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const client = createReadOnlyOrchestrationClient(source, {
      allowedResourceKinds: ['AgentRun'],
    });

    await expect(
      client.apply({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'run-1' },
        spec: {},
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      client.delete({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.list({ kind: 'CredentialGrant' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(source.apply).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
    expect(source.list).not.toHaveBeenCalled();
  });
});

describe('namespaced remote orchestration policy', () => {
  it('binds every operation to the host-selected namespace', async () => {
    const source = {
      getCapabilities: vi.fn(async () => ({
        operations: ['apply', 'get', 'list', 'watch', 'delete'] as const,
        resourceKinds: ['AgentRun', 'CredentialGrant'],
        interfaces: ['resource', 'credential-broker'] as const,
      })),
      apply: vi.fn(async (resource: OrchestrationResourceManifest) => resource),
      get: vi.fn(async () => null),
      list: vi.fn(async () => ({ items: [], resourceVersion: '1' })),
      watch: vi.fn(() =>
        (async function*() {
          yield { type: 'BOOKMARK' as const, resourceVersion: '1' };
        })()
      ),
      delete: vi.fn(async (reference: OrchestrationResourceReference) => ({
        accepted: true,
        reference,
      })),
    } as unknown as AgentOrchestrationClient;
    const client = createNamespacedOrchestrationClient(source, {
      namespace: 'peer-a1',
      allowedResourceKinds: ['AgentRun'],
    });

    await client.apply({
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      metadata: { name: 'run-1' },
      spec: {},
    });
    await client.get({
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
    });
    await client.list({ kind: 'AgentRun' });
    await client.delete({
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
    });

    expect(source.apply).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ namespace: 'peer-a1' }) }),
      undefined,
    );
    expect(source.get).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'peer-a1' }),
      undefined,
    );
    expect(source.list).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'peer-a1' }),
      undefined,
    );
    expect(source.delete).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'peer-a1' }),
      undefined,
    );
    await expect(client.getCapabilities()).resolves.toEqual({
      operations: ['apply', 'get', 'list', 'watch', 'delete'],
      resourceKinds: ['AgentRun'],
      resourceOperations: {
        AgentRun: ['apply', 'get', 'list', 'watch', 'delete'],
      },
      interfaces: ['resource'],
    });
  });

  it('rejects cross-namespace and out-of-scope access before delegation', async () => {
    const source = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      watch: vi.fn(),
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const client = createNamespacedOrchestrationClient(source, {
      namespace: 'peer-a1',
      allowedResourceKinds: ['AgentRun'],
    });

    await expect(
      client.apply({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'run-1', namespace: 'peer-b2' },
        spec: {},
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.list({ kind: 'CredentialGrant' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(source.apply).not.toHaveBeenCalled();
    expect(source.list).not.toHaveBeenCalled();
  });

  it('rejects invalid host namespace configuration', () => {
    const source = {} as AgentOrchestrationClient;
    expect(() =>
      createNamespacedOrchestrationClient(source, {
        namespace: ' ',
        allowedResourceKinds: [],
      })
    ).toThrow('namespace must contain');
  });

  it('allows status reads while denying controller-owned resource mutations', async () => {
    const source = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: vi.fn(async () => null),
      list: vi.fn(),
      watch: vi.fn(),
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const client = createNamespacedOrchestrationClient(source, {
      namespace: 'peer-a1',
      allowedResourceKinds: ['AgentWorkload', 'AgentRun'],
      mutableResourceKinds: ['AgentWorkload'],
    });
    const runReference = {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
    };

    await expect(client.get(runReference)).resolves.toBeNull();
    await expect(
      client.apply({
        ...runReference,
        metadata: { name: 'run-1' },
        spec: { workloadRef: { apiVersion: 'v1', kind: 'AgentWorkload', name: 'w1' } },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.delete(runReference)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(source.get).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'peer-a1' }),
      undefined,
    );
    expect(source.apply).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
    source.getCapabilities = vi.fn(async (): Promise<AgentOrchestrationCapabilities> => ({
      operations: ['apply', 'get', 'list', 'watch', 'delete'],
      resourceKinds: ['AgentWorkload', 'AgentRun'],
      interfaces: ['resource'],
    }));
    await expect(client.getCapabilities()).resolves.toMatchObject({
      resourceOperations: {
        AgentWorkload: ['apply', 'get', 'list', 'watch', 'delete'],
        AgentRun: ['get', 'list', 'watch'],
      },
    });
  });

  it('rejects a mutable kind that is outside the readable allowlist', () => {
    expect(() =>
      createNamespacedOrchestrationClient({} as AgentOrchestrationClient, {
        namespace: 'peer-a1',
        allowedResourceKinds: ['AgentRun'],
        mutableResourceKinds: ['CredentialGrant'],
      })
    ).toThrow("mutable resource kind 'CredentialGrant' must also be allowed");
  });
});

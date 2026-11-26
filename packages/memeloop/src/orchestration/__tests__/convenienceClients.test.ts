import { describe, expect, it } from 'vitest';

import type { AgentOrchestrationClient, OrchestrationApplyOptions, OrchestrationResourceManifest, OrchestrationResourceReference } from '../client.js';
import { createConvenienceClients } from '../convenienceClients.js';

interface FakeClient extends AgentOrchestrationClient {
  applied: Array<{
    manifest: OrchestrationResourceManifest<unknown>;
    options: OrchestrationApplyOptions | undefined;
  }>;
  deleted: OrchestrationResourceReference[];
  gotten: OrchestrationResourceReference[];
}

function makeFakeClient(): FakeClient {
  const applied: FakeClient['applied'] = [];
  const deleted: FakeClient['deleted'] = [];
  const gotten: FakeClient['gotten'] = [];
  return {
    async getCapabilities() {
      return {
        operations: ['apply', 'get', 'list', 'watch', 'delete'],
        resourceKinds: [
          'ToolOperation',
          'ModelCallRecord',
          'NetworkAttachment',
          'AgentVolumeClaim',
          'CredentialGrant',
          'ArtifactRecord',
        ],
        interfaces: ['resource'],
      };
    },
    async apply(manifest, options) {
      applied.push({ manifest, options });
      return {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          name: manifest.metadata.name ?? `${manifest.metadata.generateName ?? 'generated-'}fake`,
          uid: 'fake-uid',
          generation: 1,
          resourceVersion: '1',
          creationTimestamp: '2026-08-25T00:00:00.000Z',
        },
      };
    },
    async get(reference) {
      gotten.push(reference);
      return null;
    },
    async list() {
      return { items: [], resourceVersion: '1' };
    },
    watch() {
      return {
        async *[Symbol.asyncIterator]() {
          // Empty fake watch stream.
        },
      };
    },
    async delete(ref) {
      deleted.push(ref);
      return { accepted: true, reference: ref };
    },
    applied,
    deleted,
    gotten,
  };
}

describe('createConvenienceClients', () => {
  it('creates tool operation via apply with fieldManager', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    const result = await clients.tools.createOperation({
      name: 'op-1',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
      arguments: { command: 'pwd' },
    });
    expect(result).toBeDefined();
    expect(fake.applied).toHaveLength(1);
    expect(fake.applied[0]).toMatchObject({
      manifest: {
        apiVersion: 'execution.memeloop.io/v1alpha1',
        spec: { arguments: { command: 'pwd' } },
      },
      options: { fieldManager: 'memeloop-tool-client' },
    });
  });

  it('uses the ToolOperation execution API version for get and delete', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake, 'default');

    await clients.tools.getOperation('op-1');
    await clients.tools.deleteOperation('op-1');

    const expectedReference = {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ToolOperation',
      name: 'op-1',
      namespace: 'default',
    };
    expect(fake.gotten).toEqual([expectedReference]);
    expect(fake.deleted).toEqual([expectedReference]);
  });

  it('adds namespace and owner references to created operations', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake, 'default');
    const owner = {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
      uid: 'run-uid-1',
    };

    await clients.tools.createOperation({
      name: 'op-owned',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
      ownerReferences: [owner],
    });

    expect(fake.applied[0]).toMatchObject({
      manifest: { metadata: { namespace: 'default', ownerReferences: [owner] } },
    });
  });

  it('creates model call record via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.models.createCallRecord({
      name: 'call-1',
      modelClassRef: { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'gpt-4' },
    });
    expect(fake.applied[0]).toMatchObject({ options: { fieldManager: 'memeloop-model-client' } });
  });

  it('creates network attachment via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.networks.createAttachment({
      name: 'net-1',
      networkClassRef: { apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkClass', name: 'default' },
    });
    expect(fake.applied).toHaveLength(1);
  });

  it('creates volume claim via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.storage.createVolumeClaim({
      name: 'vol-1',
      storageClass: 'local-markdown',
      accessMode: 'ReadWriteOnce',
      sizeBytes: 1024 * 1024,
    });
    expect(fake.applied[0]).toMatchObject({
      manifest: {
        spec: {
          storageClassRef: {
            kind: 'StorageClass',
            name: 'local-markdown',
          },
          accessMode: 'ReadWriteOnce',
          sizeBytes: 1024 * 1024,
        },
      },
    });
  });

  it('creates credential grant via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.credentials.createGrant({
      name: 'cred-1',
      runRef: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'run-1', uid: 'uid-1' },
      attempt: 1,
      workerKey: 'sha256:worker-key',
      target: 'api.openai.com',
      method: 'chat',
      audience: 'openai',
      policyDigest: 'sha256:policy',
      ttlMs: 30_000,
    });
    expect(fake.applied[0]).toMatchObject({
      manifest: {
        spec: {
          attempt: 1,
          workerKey: 'sha256:worker-key',
          policyDigest: 'sha256:policy',
          ttlMs: 30_000,
        },
      },
    });
  });

  it('creates artifact record via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.artifacts.createRecord({
      name: 'art-1',
      contentHash: 'sha256:abc123',
      trust: 'restricted',
    });
    expect(fake.applied).toHaveLength(1);
  });

  it('projects every supported optional field into its real resource schema', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    const owner = {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
      uid: 'run-uid-1',
    };

    await clients.tools.createOperation({
      name: 'tool-options',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
      timeoutMs: 1_500,
    });
    await clients.models.createCallRecord({
      name: 'model-options',
      modelClassRef: { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'model' },
      runRef: owner,
      inputClassification: 'restricted',
      idempotencyKey: 'model-key',
    });
    await clients.networks.createAttachment({
      name: 'network-options',
      networkClassRef: { apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkClass', name: 'network' },
      workloadRef: owner,
      nodeId: 'node-1',
      idempotencyKey: 'network-key',
    });
    await clients.credentials.createGrant({
      name: 'credential-options',
      runRef: owner,
      attempt: 2,
      workerKey: 'sha256:worker',
      target: 'model:provider/model',
      method: 'generate',
      audience: 'provider',
      policyDigest: 'sha256:policy',
      budget: { maxCalls: 3, maxCost: 2, currency: 'USD' },
    });
    await clients.artifacts.createRecord({
      name: 'artifact-options',
      contentHash: 'sha256:artifact',
      sizeBytes: 42,
      mimeType: 'text/plain',
      trust: 'restricted',
      producer: { runRef: owner, trust: 'restricted' },
      parents: [{ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name: 'parent' }],
    });

    expect(fake.applied).toMatchObject([
      { manifest: { spec: { timeoutMs: 1_500 } } },
      {
        manifest: { spec: { runRef: owner, inputClassification: 'restricted' } },
        options: { idempotencyKey: 'model-key' },
      },
      {
        manifest: { spec: { workloadRef: owner, nodeId: 'node-1' } },
        options: { idempotencyKey: 'network-key' },
      },
      { manifest: { spec: { budget: { maxCalls: 3, maxCost: 2, currency: 'USD' } } } },
      {
        manifest: {
          spec: {
            sizeBytes: 42,
            mimeType: 'text/plain',
            producer: { runRef: owner, trust: 'restricted' },
            parents: [{ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name: 'parent' }],
          },
        },
      },
    ]);
  });

  it('deletes all resource types', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.tools.deleteOperation('op-1');
    await clients.models.deleteCallRecord('call-1');
    await clients.networks.deleteAttachment('net-1');
    await clients.storage.deleteVolumeClaim('vol-1');
    await clients.credentials.deleteGrant('cred-1');
    await clients.artifacts.deleteRecord('art-1');
    expect(fake.deleted).toHaveLength(6);
  });

  it('passes idempotencyKey through to apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.tools.createOperation({
      name: 'op-1',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
      idempotencyKey: 'stable-key-1',
    });
    expect(fake.applied[0]).toMatchObject({
      manifest: { spec: { idempotencyKey: 'stable-key-1' } },
      options: { idempotencyKey: 'stable-key-1' },
    });
  });

  it('preserves generateName for server-side allocation without random local names', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake, 'default');
    await clients.tools.createOperation({
      generateName: 'operation-',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
    });

    expect(fake.applied[0]).toMatchObject({
      manifest: {
        metadata: { generateName: 'operation-', namespace: 'default' },
      },
    });
    expect(fake.applied[0]?.manifest.metadata).not.toHaveProperty('name');
  });

  it('rejects ambiguous name and generateName instead of silently dropping one', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await expect(clients.artifacts.createRecord({
      name: 'artifact',
      generateName: 'artifact-',
      contentHash: 'sha256:abc123',
      trust: 'restricted',
    })).rejects.toMatchObject({ code: 'INVALID' });
    expect(fake.applied).toEqual([]);
  });
});

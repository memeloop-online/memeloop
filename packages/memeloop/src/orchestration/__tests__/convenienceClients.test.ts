import { describe, expect, it } from 'vitest';

import type { AgentOrchestrationClient } from '../client.js';
import { createConvenienceClients } from '../convenienceClients.js';

function makeFakeClient(): AgentOrchestrationClient & { applied: unknown[]; deleted: unknown[] } {
  const applied: unknown[] = [];
  const deleted: unknown[] = [];
  return {
    capabilities: { kinds: ['ToolOperation', 'ModelCallRecord', 'NetworkAttachment', 'AgentVolumeClaim', 'CredentialGrant', 'ArtifactRecord'] },
    async apply(manifest: unknown, options?: unknown) {
      applied.push({ manifest, options });
      return manifest;
    },
    async get() {
      return null;
    },
    async list() {
      return { items: [], resourceVersion: '1' };
    },
    async watch() {
      return { async *[Symbol.asyncIterator]() {} } as never;
    },
    async delete(ref: unknown) {
      deleted.push(ref);
    },
    applied,
    deleted,
  } as never;
}

describe('createConvenienceClients', () => {
  it('creates tool operation via apply with fieldManager', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    const result = await clients.tools.createOperation({
      name: 'op-1',
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'shell' },
      effect: 'execute',
    });
    expect(result).toBeDefined();
    expect(fake.applied).toHaveLength(1);
    expect(fake.applied[0]).toMatchObject({ options: { fieldManager: 'memeloop-tool-client' } });
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
    expect(fake.applied).toHaveLength(1);
  });

  it('creates credential grant via apply', async () => {
    const fake = makeFakeClient();
    const clients = createConvenienceClients(fake);
    await clients.credentials.createGrant({
      name: 'cred-1',
      runRef: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'run-1', uid: 'uid-1', controller: false, blockOwnerDeletion: false },
      target: 'api.openai.com',
      method: 'chat',
      audience: 'openai',
    });
    expect(fake.applied).toHaveLength(1);
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
    expect(fake.applied[0]).toMatchObject({ options: { idempotencyKey: 'stable-key-1' } });
  });
});

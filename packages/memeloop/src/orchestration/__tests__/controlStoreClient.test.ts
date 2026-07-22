import { describe, expect, it } from 'vitest';

import type { ControlStoreActor } from '../controlStore.js';
import { createControlStoreOrchestrationClient } from '../controlStoreClient.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const actor: ControlStoreActor = { id: 'controller/test', kind: 'controller' };

const workloadManifest = {
  apiVersion: 'execution.memeloop.io/v1alpha1',
  kind: 'AgentWorkload',
  metadata: { name: 'w1', namespace: 'default' },
  spec: { scriptReference: 'sha256:abc', trust: 'restricted' },
};

function makeClient() {
  const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
  return { store, client: createControlStoreOrchestrationClient(store, actor) };
}

describe('createControlStoreOrchestrationClient', () => {
  it('reports resource facade capabilities', async () => {
    const { client } = makeClient();
    const capabilities = await client.getCapabilities();
    expect(capabilities.operations).toEqual(['apply', 'get', 'list', 'watch', 'delete']);
    expect(capabilities.resourceKinds).toContain('AgentWorkload');
    expect(capabilities.interfaces).toEqual(['resource']);
  });

  it('apply creates a missing resource', async () => {
    const { client } = makeClient();
    const created = await client.apply(workloadManifest);
    expect(created.metadata.name).toBe('w1');
    expect(created.spec).toEqual(workloadManifest.spec);

    const got = await client.get({ apiVersion: workloadManifest.apiVersion, kind: 'AgentWorkload', name: 'w1', namespace: 'default' });
    expect(got).not.toBeNull();
  });

  it('apply is idempotent for a deep-equal spec (key order independent)', async () => {
    const { client } = makeClient();
    const first = await client.apply(workloadManifest);
    const reordered = {
      ...workloadManifest,
      spec: { trust: 'restricted', scriptReference: 'sha256:abc' },
    };
    const second = await client.apply(reordered);
    expect(second.metadata.resourceVersion).toBe(first.metadata.resourceVersion);
  });

  it('apply rejects a differing spec with CONFLICT (immutable spec)', async () => {
    const { client } = makeClient();
    await client.apply(workloadManifest);
    await expect(
      client.apply({ ...workloadManifest, spec: { scriptReference: 'sha256:other', trust: 'restricted' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('delegates list and delete to the store', async () => {
    const { client } = makeClient();
    await client.apply(workloadManifest);
    await client.apply({ ...workloadManifest, metadata: { name: 'w2', namespace: 'default' } });

    const list = await client.list({ apiVersion: workloadManifest.apiVersion, kind: 'AgentWorkload' });
    expect(list.items).toHaveLength(2);

    await client.delete({ apiVersion: workloadManifest.apiVersion, kind: 'AgentWorkload', name: 'w1', namespace: 'default' });
    const after = await client.list({ apiVersion: workloadManifest.apiVersion, kind: 'AgentWorkload' });
    expect(after.items).toHaveLength(1);
    expect(after.items[0].metadata.name).toBe('w2');
  });
});

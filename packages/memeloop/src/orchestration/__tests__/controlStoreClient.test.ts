import { describe, expect, it, vi } from 'vitest';

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

  it('apply atomically updates a differing spec and advances generation', async () => {
    const { client } = makeClient();
    const created = await client.apply(workloadManifest);
    const updated = await client.apply({
      ...workloadManifest,
      spec: { scriptReference: 'sha256:other', trust: 'restricted' },
    });
    expect(updated.metadata.uid).toBe(created.metadata.uid);
    expect(updated.metadata.generation).toBe(2);
    expect(updated.metadata.resourceVersion).not.toBe(created.metadata.resourceVersion);
    expect(updated.spec.scriptReference).toBe('sha256:other');
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

  it('forwards get/list read options, including revision and continuation limits', async () => {
    const resource = {
      ...workloadManifest,
      metadata: {
        ...workloadManifest.metadata,
        name: 'forwarded',
        uid: 'uid-forwarded',
        generation: 1,
        resourceVersion: '7',
        creationTimestamp: '2026-01-01T00:00:00.000Z',
      },
    };
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const get = vi.spyOn(store, 'get').mockResolvedValue(resource);
    const list = vi.spyOn(store, 'list').mockResolvedValue({
      items: [resource],
      resourceVersion: '7',
      continueToken: 'next-page',
    });
    const client = createControlStoreOrchestrationClient(store, actor);
    const signal = new AbortController().signal;
    const getOptions = { resourceVersion: '7', signal };
    const listOptions = { resourceVersion: '7', limit: 1, continueToken: 'next-page', signal };

    await client.get({ apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name }, getOptions);
    await client.list({ apiVersion: resource.apiVersion, kind: resource.kind }, listOptions);

    expect(get).toHaveBeenCalledWith(
      { apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name },
      getOptions,
    );
    expect(list).toHaveBeenCalledWith(
      { apiVersion: resource.apiVersion, kind: resource.kind },
      listOptions,
    );
  });

  it('forwards ownership, preconditions, and call cancellation options to apply', async () => {
    const resource = {
      ...workloadManifest,
      metadata: {
        ...workloadManifest.metadata,
        uid: 'uid-precondition',
        generation: 1,
        resourceVersion: '7',
        creationTimestamp: '2026-01-01T00:00:00.000Z',
      },
    };
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    vi.spyOn(store, 'get').mockResolvedValue(resource);
    const apply = vi.spyOn(store, 'apply').mockResolvedValue(resource);
    const client = createControlStoreOrchestrationClient(store, actor);

    const applyOptions = {
      fieldManager: 'agent',
      force: true,
      preconditions: { resourceVersion: '7', uid: 'uid-precondition', generation: 1 },
      idempotencyKey: 'apply-7',
      dryRun: true,
    };
    await client.apply(workloadManifest, applyOptions);
    expect(apply).toHaveBeenCalledWith(actor, workloadManifest, {
      resourceVersion: '7',
      idempotencyKey: 'apply-7',
      fieldManager: 'agent',
      force: true,
      preconditions: applyOptions.preconditions,
      dryRun: true,
    });

    const signal = new AbortController().signal;
    const deadline = new Date(Date.now() + 10_000).toISOString();
    await client.apply(workloadManifest, { signal, deadline });
    expect(apply).toHaveBeenLastCalledWith(
      actor,
      workloadManifest,
      expect.objectContaining({
        signal,
        deadline,
      }),
    );
  });

  it('cancels an in-flight ControlStore apply without publishing a late result', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const get = vi.spyOn(store, 'get').mockImplementation(async (_reference, options) => {
      return await new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          resolve(null);
        }, { once: true });
      });
    });
    const apply = vi.spyOn(store, 'apply');
    const client = createControlStoreOrchestrationClient(store, actor);
    const controller = new AbortController();
    const pending = client.apply(workloadManifest, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalled();
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects an expired apply deadline before touching the store', async () => {
    const { store, client } = makeClient();
    const get = vi.spyOn(store, 'get');
    await expect(client.apply(workloadManifest, {
      deadline: '2026-01-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(get).not.toHaveBeenCalled();
  });
});

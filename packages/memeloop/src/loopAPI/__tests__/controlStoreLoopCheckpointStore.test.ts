import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource } from '../../orchestration/client.js';
import type { ControlStore } from '../../orchestration/controlStore.js';
import { createControlStoreLoopCheckpointStore, type LoopCheckpointSpec } from '../controlStoreLoopCheckpointStore.js';

describe('createControlStoreLoopCheckpointStore', () => {
  it('persists and loads loop checkpoints through ControlStore', async () => {
    const resources = new Map<string, OrchestrationResource<LoopCheckpointSpec>>();
    const create = vi.fn(async (_actor, manifest) => {
      const resource: OrchestrationResource<LoopCheckpointSpec> = {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          name: manifest.metadata.name ?? '',
          uid: 'checkpoint-uid',
          generation: 1,
          resourceVersion: '1',
          creationTimestamp: '2026-07-18T00:00:00.000Z',
        },
      };
      resources.set(`${resource.metadata.namespace}/${resource.metadata.name}`, resource);
      return resource;
    });
    const get = vi.fn(async (reference) => resources.get(`${reference.namespace}/${reference.name}`) ?? null);
    const apply = vi.fn(async (_actor, manifest) => {
      const previous = resources.get(`${manifest.metadata.namespace}/${manifest.metadata.name}`)!;
      const resource: OrchestrationResource<LoopCheckpointSpec> = {
        ...previous,
        spec: manifest.spec,
        metadata: { ...previous.metadata, resourceVersion: '2' },
      };
      resources.set(`${resource.metadata.namespace}/${resource.metadata.name}`, resource);
      return resource;
    });
    const store = { apply, create, get } as unknown as ControlStore;
    const checkpoints = createControlStoreLoopCheckpointStore(
      store,
      { id: 'controller/agent-agent-loop', kind: 'controller' },
      () => new Date('2026-07-18T00:00:00.000Z'),
    );

    const result = { text: 'draft', nested: { approved: false } };
    await checkpoints.saveCheckpoint('conversation-1', 'quality-gate:1:attempt', result);
    result.nested.approved = true;

    await expect(checkpoints.loadCheckpoint('conversation-1', 'quality-gate:1:attempt')).resolves.toEqual({
      text: 'draft',
      nested: { approved: false },
    });
    expect(create).toHaveBeenCalledWith(
      { id: 'controller/agent-agent-loop', kind: 'controller' },
      expect.objectContaining({
        kind: 'LoopCheckpoint',
        metadata: { namespace: 'conversation-1', name: 'quality-gate%3A1%3Aattempt' },
      }),
      { idempotencyKey: expect.stringMatching(/^loop-checkpoint:conversation-1:quality-gate:1:attempt:/u) },
    );
  });

  it('updates mutable state with resourceVersion CAS and makes equal retries idempotent', async () => {
    let current = {
      metadata: { resourceVersion: '7' },
      spec: {
        conversationId: 'conversation-1',
        key: 'state:count',
        result: 1,
        digest: 'stale-digest',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    } as OrchestrationResource<LoopCheckpointSpec>;
    const get = vi.fn(async () => current);
    const create = vi.fn();
    const apply = vi.fn(async (_actor, manifest, options) => {
      expect(options.resourceVersion).toBe('7');
      current = {
        ...current,
        metadata: { ...current.metadata, resourceVersion: '8' },
        spec: manifest.spec,
      };
      return current;
    });
    const checkpoints = createControlStoreLoopCheckpointStore(
      { get, create, apply } as unknown as ControlStore,
      { id: 'controller/agent-agent-loop', kind: 'controller' },
    );

    await checkpoints.saveCheckpoint('conversation-1', 'state:count', 2);
    await expect(checkpoints.loadCheckpoint('conversation-1', 'state:count')).resolves.toBe(2);
    await checkpoints.saveCheckpoint('conversation-1', 'state:count', 2);
    expect(create).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('checks the current execution lease immediately before creating a checkpoint', async () => {
    const create = vi.fn();
    const checkpoints = createControlStoreLoopCheckpointStore(
      { get: vi.fn().mockResolvedValue(null), create, apply: vi.fn() } as unknown as ControlStore,
      { id: 'controller/agent-agent-loop', kind: 'controller' },
    );
    const validateExecutionLease = vi.fn(async () => {
      throw new Error('execution lease was taken over');
    });

    await expect(checkpoints.saveCheckpoint('conversation-1', 'fresh-after-takeover', { stale: true }, {
      fencingEpoch: 1,
      validateExecutionLease,
    })).rejects.toThrow('execution lease was taken over');
    expect(validateExecutionLease).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});

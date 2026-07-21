import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource } from '../../orchestration/client.js';
import type { ControlStore } from '../../orchestration/controlStore.js';
import { createControlStoreLoopCheckpointStore, type LoopCheckpointSpec } from '../controlStoreLoopCheckpointStore.js';

describe('createControlStoreLoopCheckpointStore', () => {
  it('persists and loads immutable loop checkpoints through ControlStore', async () => {
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
    const store = { create, get } as unknown as ControlStore;
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
      { idempotencyKey: 'loop-checkpoint:conversation-1:quality-gate:1:attempt' },
    );
  });

  it('does not create a checkpoint that already exists', async () => {
    const get = vi.fn().mockResolvedValue({ spec: { result: 'saved' } });
    const create = vi.fn();
    const checkpoints = createControlStoreLoopCheckpointStore(
      { get, create } as unknown as ControlStore,
      { id: 'controller/agent-agent-loop', kind: 'controller' },
    );

    await checkpoints.saveCheckpoint('conversation-1', 'done', 'new');
    expect(create).not.toHaveBeenCalled();
  });
});

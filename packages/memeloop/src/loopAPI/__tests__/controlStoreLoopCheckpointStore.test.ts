import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource } from '../../orchestration/client.js';
import type { ControlLeaseIdentity, ControlStore } from '../../orchestration/controlStore.js';
import { OrchestrationError } from '../../orchestration/errors.js';
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

  it('rejects a checkpoint whose control lease is taken over while its mutation is blocked', async () => {
    let activeFence: ControlLeaseIdentity | undefined;
    let resolveMutationStarted!: () => void;
    const mutationStarted = new Promise<void>(resolve => {
      resolveMutationStarted = resolve;
    });
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>(resolve => {
      releaseMutation = resolve;
    });
    const checkpoints = createControlStoreLoopCheckpointStore(
      {
        get: vi.fn().mockResolvedValue(null),
        create: vi.fn(async (
          _actor: unknown,
          _manifest: unknown,
          options?: { leasePrecondition?: ControlLeaseIdentity },
        ) => {
          expect(options?.leasePrecondition).toEqual(activeFence);
          resolveMutationStarted();
          await mutationBlocked;
          const fence = options?.leasePrecondition;
          const current = activeFence;
          if (
            !fence ||
            !current ||
            fence.name !== current.name ||
            fence.holder !== current.holder ||
            fence.leaseId !== current.leaseId ||
            fence.epoch !== current.epoch
          ) {
            throw new OrchestrationError({
              code: 'STALE_EPOCH',
              message: 'checkpoint lease is no longer current',
              retryable: false,
            });
          }
          throw new Error('test mutation unexpectedly committed');
        }),
        apply: vi.fn(),
        async acquireLease(_actor: unknown, request: { name: string; holder: string; ttlMs: number }) {
          activeFence = {
            name: request.name,
            holder: request.holder,
            leaseId: `${request.holder}:lease`,
            epoch: activeFence ? String(Number(activeFence.epoch) + 1) : '1',
          };
          return {
            ...activeFence,
            acquiredAt: new Date().toISOString(),
            renewedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + request.ttlMs).toISOString(),
            resourceVersion: activeFence.epoch,
          };
        },
        async renewLease(_actor: unknown, fence: ControlLeaseIdentity, ttlMs: number) {
          if (!activeFence || fence.leaseId !== activeFence.leaseId) {
            throw new OrchestrationError({ code: 'STALE_EPOCH', message: 'stale', retryable: false });
          }
          return {
            ...activeFence,
            acquiredAt: new Date().toISOString(),
            renewedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            resourceVersion: activeFence.epoch,
          };
        },
        async releaseLease() {},
      } as unknown as ControlStore,
      { id: 'controller/agent-agent-loop', kind: 'controller' },
    );
    const staleFence = await checkpoints.checkpointFenceStore!.acquireCheckpointFence(
      'run:checkpoint-race',
      'runtime:a',
      1_000,
    );

    const pending = checkpoints.saveCheckpoint('conversation-1', 'fresh-after-takeover', { stale: true }, {
      fencingEpoch: 1,
      leasePrecondition: staleFence,
    });
    await mutationStarted;
    // This represents another runtime taking over after the original write
    // has started but before the backend evaluates its mutation precondition.
    await checkpoints.checkpointFenceStore!.acquireCheckpointFence(
      'run:checkpoint-race',
      'runtime:b',
      1_000,
    );
    releaseMutation();

    await expect(pending).rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });
});

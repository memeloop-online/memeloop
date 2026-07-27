import { describe, expect, it, vi } from 'vitest';

import { planReplicaPlacement, reconcileVolumeReplication, type ReplicationNode } from '../controllers/storageReplication.js';
import type { AgentVolumeResource, StorageClassResource } from '../resources.js';

const NODES: ReplicationNode[] = [
  { nodeId: 'node-a', faultDomain: 'zone-1', trust: 'trusted' },
  { nodeId: 'node-b', faultDomain: 'zone-2', trust: 'trusted' },
  { nodeId: 'node-c', faultDomain: 'zone-3', trust: 'trusted' },
  { nodeId: 'node-r', faultDomain: 'zone-4', trust: 'restricted' },
  { nodeId: 'node-q', faultDomain: 'zone-4', trust: 'quarantine' },
];

function storageClass(overrides: Partial<StorageClassResource['spec']> = {}): StorageClassResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'StorageClass',
    metadata: { name: 'sc', uid: 'u1', generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: { driver: 'test', replication: { factor: 3, faultDomains: ['zone'], autoRebuild: true }, ...overrides },
  };
}

function volume(status: AgentVolumeResource['status']): AgentVolumeResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'AgentVolume',
    metadata: { name: 'vol-1', uid: 'u2', generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: {
      storageClassRef: { apiVersion: 'storage.memeloop.io/v1alpha1', kind: 'StorageClass', name: 'sc' },
      driverHandle: 'drv://vol-1',
    },
    ...(status ? { status } : {}),
  };
}

function transport(hashes: Record<string, string | null>, options: { transferReturns?: string } = {}) {
  const transfers: Array<{
    from: string;
    to: string;
    epoch: number;
    snapshotHandle: string;
  }> = [];
  const fences: Array<{ previous: { nodeId?: string; epoch: number }; next: { nodeId: string; epoch: number } }> = [];
  return {
    transfers,
    fences,
    readReplicaHash: vi.fn().mockImplementation(async (_volume: AgentVolumeResource, nodeId: string) => hashes[nodeId] ?? null),
    commitPrimaryFence: vi.fn().mockImplementation(async (
      _volume: AgentVolumeResource,
      previous: { nodeId?: string; epoch: number },
      next: { nodeId: string; epoch: number },
    ) => {
      fences.push({ previous, next });
    }),
    capturePrimarySnapshot: vi.fn().mockImplementation(async (
      _volume: AgentVolumeResource,
      nodeId: string,
      epoch: number,
    ) => {
      const contentHash = hashes[nodeId];
      if (!contentHash) throw new Error('primary is unreadable');
      return {
        snapshotHandle: `snapshot:${nodeId}:${epoch}:${contentHash}`,
        contentHash,
      };
    }),
    transferReplica: vi.fn().mockImplementation(async (
      _volume: AgentVolumeResource,
      snapshot: { snapshotHandle: string; contentHash: string },
      from: string,
      to: string,
      epoch: number,
    ) => {
      transfers.push({ from, to, epoch, snapshotHandle: snapshot.snapshotHandle });
      const stored = options.transferReturns ?? snapshot.contentHash;
      hashes[to] = stored;
    }),
    releaseSnapshot: vi.fn().mockImplementation(async () => {}),
  };
}

describe('planReplicaPlacement', () => {
  it('prefers unused fault domains and excludes non-trusted nodes', () => {
    const targets = planReplicaPlacement(
      [{ nodeId: 'node-a', state: 'healthy' }],
      NODES,
      2,
    );
    expect(targets.map((node) => node.nodeId)).toEqual(['node-b', 'node-c']);
  });
});

describe('reconcileVolumeReplication', () => {
  it('places replicas across fault domains and never on quarantine nodes', async () => {
    const hashes: Record<string, string | null> = { 'node-a': 'hash-good' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [{ nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' }],
      }),
      storageClass(),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.replicas).toHaveLength(3);
    const placed = result.volume.status?.replicas.map((replica) => replica.nodeId) ?? [];
    expect(placed).toContain('node-b');
    expect(placed).toContain('node-c');
    expect(placed).not.toContain('node-q');
    expect(result.volume.status?.health).toBe('healthy');
    expect(context.transfers.every((transfer) => transfer.from === 'node-a')).toBe(true);
  });

  it('never bootstraps or places authoritative replicas on non-trusted nodes', async () => {
    const hashes: Record<string, string | null> = { 'node-r': 'hash-good', 'node-q': 'hash-good' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        replicas: [
          { nodeId: 'node-r', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-q', state: 'healthy', contentHash: 'hash-good' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.contentHash).toBeUndefined();
    expect(result.volume.status?.primaryNodeId).toBeUndefined();
    expect(result.volume.status?.health).toBe('failed');
    expect(context.transfers).toEqual([]);
    expect(context.fences).toEqual([]);
  });

  it('rebuilds a corrupt replica from the primary and verifies the new hash', async () => {
    const hashes: Record<string, string | null> = { 'node-a': 'hash-good', 'node-b': 'hash-corrupt' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-stale' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.actions).toContainEqual({ type: 'mark-degraded', nodeId: 'node-b', reason: 'content hash mismatch' });
    expect(result.actions).toContainEqual({ type: 'rebuild-replica', nodeId: 'node-b', fromNodeId: 'node-a' });
    const rebuilt = result.volume.status?.replicas?.find((replica) => replica.nodeId === 'node-b');
    expect(rebuilt).toMatchObject({ state: 'healthy', contentHash: 'hash-good' });
    expect(result.volume.status?.health).toBe('healthy');
  });

  it('advances the authoritative hash after a legitimate fenced-primary write', async () => {
    const hashes: Record<string, string | null> = {
      'node-a': 'hash-after-write',
      'node-b': 'hash-before-write',
    };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-before-write',
        primaryNodeId: 'node-a',
        primaryEpoch: 7,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-before-write' },
          { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-before-write' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status).toMatchObject({
      contentHash: 'hash-after-write',
      primaryNodeId: 'node-a',
      primaryEpoch: 7,
      health: 'healthy',
      replicas: [
        { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-after-write' },
        { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-after-write' },
      ],
    });
    expect(context.fences).toEqual([]);
    expect(context.transfers).toHaveLength(1);
    expect(context.transfers[0]).toMatchObject({
      from: 'node-a',
      to: 'node-b',
      epoch: 7,
      snapshotHandle: 'snapshot:node-a:7:hash-after-write',
    });
    expect(context.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it('transfers the captured snapshot even when the live primary changes concurrently', async () => {
    const hashes: Record<string, string | null> = {
      'node-a': 'hash-v2',
      'node-b': 'hash-v1',
    };
    const context = transport(hashes);
    context.transferReplica.mockImplementation(async (
      _volume: AgentVolumeResource,
      snapshot: { snapshotHandle: string; contentHash: string },
      _from: string,
      to: string,
    ) => {
      hashes['node-a'] = 'hash-v3';
      hashes[to] = snapshot.contentHash;
    });
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-v1',
        primaryNodeId: 'node-a',
        primaryEpoch: 3,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-v1' },
          { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-v1' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.contentHash).toBe('hash-v2');
    expect(result.volume.status?.replicas).toEqual([
      expect.objectContaining({ nodeId: 'node-a', contentHash: 'hash-v2' }),
      expect.objectContaining({ nodeId: 'node-b', contentHash: 'hash-v2' }),
    ]);
    expect(hashes['node-a']).toBe('hash-v3');
    expect(context.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it('attempts snapshot cleanup without masking a failed transfer', async () => {
    const hashes: Record<string, string | null> = {
      'node-a': 'hash-good',
      'node-b': 'hash-stale',
    };
    const context = transport(hashes);
    context.transferReplica.mockRejectedValue(new Error('snapshot transfer failed'));
    context.releaseSnapshot.mockRejectedValue(new Error('snapshot cleanup failed'));

    await expect(reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 2,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-b', state: 'degraded', contentHash: 'hash-stale' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    )).rejects.toThrow('snapshot transfer failed');
    expect(context.releaseSnapshot).toHaveBeenCalledOnce();
  });

  it('marks a corrupt rebuild as degraded when the transferred hash mismatches', async () => {
    const hashes: Record<string, string | null> = { 'node-a': 'hash-good', 'node-b': 'hash-corrupt' };
    const context = transport(hashes, { transferReturns: 'hash-still-wrong' });
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-b', state: 'degraded', contentHash: 'hash-stale' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.replicas?.find((replica) => replica.nodeId === 'node-b')).toMatchObject({
      state: 'degraded',
      contentHash: 'hash-still-wrong',
    });
    expect(result.volume.status?.health).toBe('degraded');
  });

  it('elects a new fenced primary when the old primary is lost and sources transfers from it', async () => {
    const hashes: Record<string, string | null> = { 'node-a': null, 'node-b': 'hash-good' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 3,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-good' },
        ],
      }),
      storageClass({ driver: 'test', replication: { factor: 2, autoRebuild: true } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.primaryNodeId).toBe('node-b');
    expect(result.volume.status?.primaryEpoch).toBe(4);
    expect(result.actions).toContainEqual({ type: 'elect-primary', nodeId: 'node-b', epoch: 4 });
    expect(context.fences).toEqual([{
      previous: { nodeId: 'node-a', epoch: 3 },
      next: { nodeId: 'node-b', epoch: 4 },
    }]);
    expect(result.actions).toContainEqual({ type: 'mark-offline', nodeId: 'node-a' });
    expect(context.transfers.every((transfer) => transfer.from === 'node-b' && transfer.epoch === 4)).toBe(true);
    expect(result.volume.status?.health).toBe('healthy');
  });

  it('does not place replicas when autoRebuild is disabled, but still reports degradation', async () => {
    const hashes: Record<string, string | null> = { 'node-a': 'hash-good' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [{ nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' }],
      }),
      storageClass({ driver: 'test', replication: { factor: 3, autoRebuild: false } }),
      { nodes: NODES, ...context },
    );

    expect(context.transfers).toHaveLength(0);
    expect(result.volume.status?.replicas).toHaveLength(1);
    expect(result.volume.status?.health).toBe('degraded');
  });

  it('reports failed health and transfers nothing when every replica is lost', async () => {
    const hashes: Record<string, string | null> = { 'node-a': null, 'node-b': null };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({
        contentHash: 'hash-good',
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash: 'hash-good' },
          { nodeId: 'node-b', state: 'healthy', contentHash: 'hash-good' },
        ],
      }),
      storageClass(),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.health).toBe('failed');
    expect(result.volume.status?.primaryNodeId).toBeUndefined();
    expect(context.transfers).toHaveLength(0);
  });

  it('bootstraps the source of truth and fences a primary when status has none', async () => {
    const hashes: Record<string, string | null> = { 'node-a': 'hash-initial' };
    const context = transport(hashes);
    const result = await reconcileVolumeReplication(
      volume({ replicas: [{ nodeId: 'node-a', state: 'healthy' }] }),
      storageClass({ driver: 'test', replication: { factor: 1 } }),
      { nodes: NODES, ...context },
    );

    expect(result.volume.status?.contentHash).toBe('hash-initial');
    expect(result.volume.status?.primaryNodeId).toBe('node-a');
    expect(result.volume.status?.primaryEpoch).toBe(1);
    expect(result.actions).toContainEqual({ type: 'elect-primary', nodeId: 'node-a', epoch: 1 });
    expect(result.volume.status?.health).toBe('healthy');
  });
});

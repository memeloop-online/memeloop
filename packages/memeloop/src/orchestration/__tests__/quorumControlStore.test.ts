import { describe, expect, it } from 'vitest';
import type { ControlStoreActor } from '../controlStore.js';
import { QuorumControlStore } from '../quorumControlStore.js';
import { createVerifierOnlyAuthorizer } from '../verifierOnlyTransitions.js';

const adminActor: ControlStoreActor = { id: 'admin', kind: 'admin' };
const controllerActor: ControlStoreActor = { id: 'controller/test', kind: 'controller' };
const testResource = { apiVersion: 'v1', kind: 'Test', metadata: { name: 't1', namespace: 'ns' }, spec: { v: 1 } };

function makeStore(voters?: string[]) {
  return new QuorumControlStore({ memberId: 'n1', voters: voters ?? ['n1', 'n2', 'n3'] });
}

describe('QuorumControlStore', () => {
  // ── CRUD ──
  it('creates and retrieves a resource', async () => {
    const store = makeStore();
    const created = await store.create(adminActor, testResource);
    expect(created.metadata.name).toBe('t1');
    expect(created.metadata.resourceVersion).toBeTruthy();

    const got = await store.get({ apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' });
    expect(got).not.toBeNull();
    expect(got!.spec).toEqual({ v: 1 });
  });

  it('rejects duplicate create', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    await expect(store.create(adminActor, testResource)).rejects.toThrow('already exists');
  });

  it('idempotency key prevents duplicate', async () => {
    const store = makeStore();
    const r1 = await store.create(adminActor, testResource, { idempotencyKey: 'ik1' });
    const r2 = await store.create(adminActor, testResource, { idempotencyKey: 'ik1' });
    expect(r2.metadata.resourceVersion).toBe(r1.metadata.resourceVersion);
  });

  it('lists resources by kind and namespace', async () => {
    const store = makeStore();
    await store.create(adminActor, { ...testResource, metadata: { ...testResource.metadata, name: 'a1' } });
    await store.create(adminActor, { ...testResource, metadata: { ...testResource.metadata, name: 'a2' } });
    const list = await store.list({ kind: 'Test', namespace: 'ns' });
    expect(list.items.length).toBe(2);
  });

  it('returns null for missing resource', async () => {
    const store = makeStore();
    expect(await store.get({ apiVersion: 'v1', kind: 'Test', name: 'missing' })).toBeNull();
  });

  it('deletes a resource', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    const result = await store.delete(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' });
    expect(result.deleted).toBe(true);
    expect(await store.get({ apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' })).toBeNull();
  });

  it('deleting absent resource returns deleted:false', async () => {
    const store = makeStore();
    const result = await store.delete(adminActor, { apiVersion: 'v1', kind: 'Test', name: 'nonexistent' });
    expect(result.deleted).toBe(false);
  });

  // ── CAS Status Updates ──
  it('updates status with CAS', async () => {
    const store = makeStore();
    const created = await store.create(adminActor, testResource);
    const updated = await store.updateStatus(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' }, {
      conditions: [{ type: 'Ready', status: 'True', reason: 'ok', lastTransitionTime: new Date().toISOString() }],
    }, { resourceVersion: created.metadata.resourceVersion });
    expect(updated.status?.conditions?.[0]?.type).toBe('Ready');
    expect(Number(updated.metadata.resourceVersion)).toBeGreaterThan(Number(created.metadata.resourceVersion));
  });

  it('CAS rejects stale resourceVersion', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    // Wait, the first create gives rv 1, so version 1 is valid. Let me update first then retry with old version.
    const _updated = await store.updateStatus(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' }, { conditions: [] }, { resourceVersion: '1' });
    // Now rv is > 1. Retry with rv 1 should fail.
    await expect(store.updateStatus(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' }, { conditions: [] }, { resourceVersion: '1' })).rejects.toThrow(
      'CAS conflict',
    );
  });

  it('updateStatus throws NOT_FOUND for missing resource', async () => {
    const store = makeStore();
    await expect(store.updateStatus(adminActor, { apiVersion: 'v1', kind: 'Test', name: 'nope' }, { conditions: [] }, { resourceVersion: '1' })).rejects.toThrow('not found');
  });

  // ── Lease ──
  it('acquires, renews, and releases a lease', async () => {
    const store = makeStore();
    const grant = await store.acquireLease(controllerActor, { name: 'lock1', holder: 'h1', ttlMs: 300_000 });
    expect(grant.holder).toBe('h1');
    expect(grant.epoch).toBe('1');

    const renewed = await store.renewLease(controllerActor, { name: grant.name, holder: grant.holder, leaseId: grant.leaseId, epoch: grant.epoch }, 300_000);
    expect(renewed.holder).toBe('h1');

    await store.releaseLease(controllerActor, { name: grant.name, holder: grant.holder, leaseId: grant.leaseId, epoch: grant.epoch });
    // Re-acquire should succeed now.
    const grant2 = await store.acquireLease(controllerActor, { name: 'lock1', holder: 'h2', ttlMs: 300_000 });
    expect(grant2.holder).toBe('h2');
  });

  it('rejects stale epoch on renew', async () => {
    const store = makeStore();
    const grant = await store.acquireLease(controllerActor, { name: 'lock2', holder: 'h1', ttlMs: 300_000 });
    await expect(store.renewLease(controllerActor, { name: grant.name, holder: grant.holder, leaseId: grant.leaseId, epoch: '99' }, 300_000)).rejects.toThrow('stale');
  });

  // ── Watch ──
  it('watch receives create events', async () => {
    const store = makeStore();
    const watcher = store.watch({ kind: 'Test' });
    const iter = watcher[Symbol.asyncIterator]();

    const createPromise = iter.next();
    // Give the watcher a moment to register.
    await new Promise((r) => setTimeout(r, 10));
    await store.create(adminActor, testResource);
    const result = await createPromise;
    expect(result.done).toBe(false);
    expect(result.value?.type).toBe('ADDED');
  });

  // ── Health ──
  it('reports healthy with quorum', async () => {
    const store = makeStore(['n1', 'n2', 'n3']);
    const health = await store.getHealth();
    expect(health.healthy).toBe(true);
  });

  it('reports unhealthy without quorum', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'], quorumSize: 3 });
    const health = await store.getHealth();
    expect(health.healthy).toBe(false);
  });

  it('rejects writes without quorum', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'], quorumSize: 3 });
    await expect(store.create(adminActor, testResource)).rejects.toThrow('loss of quorum');
  });

  // ── Topology ──
  it('reports topology', async () => {
    const store = makeStore(['n1', 'n2', 'n3']);
    const topo = await store.getTopology();
    expect(topo.members.length).toBeGreaterThanOrEqual(3);
    expect(topo.term).toBe(1);
  });

  it('adds and removes voters', async () => {
    const store = makeStore(['n1', 'n2', 'n3']);
    await store.addVoter({ id: 'n4', peerUrls: [], isLearner: false });
    const topo = await store.getTopology();
    expect(topo.members.some((m) => m.id === 'n4')).toBe(true);

    await store.removeVoter('n4');
    const topo2 = await store.getTopology();
    expect(topo2.members.some((m) => m.id === 'n4')).toBe(false);
  });

  it('promotes learner to voter', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1', 'n2'], isLearner: false });
    await store.promoteLearner('n3');
    const topo = await store.getTopology();
    expect(topo.members.some((m) => m.id === 'n3')).toBe(true);
  });

  // ── Verifier Authorization ──
  it('enforces verifier-only transitions via authorizer', async () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'], authorizer: { authorize: authorizer } });

    // Create ArtifactRecord first.
    const art = await store.create(adminActor, {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      metadata: { name: 'sha256:xyz', namespace: 'default' },
      spec: { contentHash: 'sha256:xyz', trust: 'restricted' },
    });

    // Non-verifier trying to append review should fail.
    const nonVerifier: ControlStoreActor = { id: 'controller/storage', kind: 'controller' };
    const review = {
      contentHash: 'sha256:xyz',
      kind: 'scan' as const,
      outcome: 'passed' as const,
      reviewer: 'controller/storage',
      destinations: ['volume' as const],
      policyDigest: 'builtin:artifact/volume/v1',
      recordedAt: new Date().toISOString(),
    };
    await expect(
      store.updateStatus(nonVerifier, { apiVersion: 'execution.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name: 'sha256:xyz', namespace: 'default' }, { reviews: [review] }, {
        resourceVersion: art.metadata.resourceVersion,
      }),
    ).rejects.toThrow('verifier');
  });

  // ── Snapshot & Compaction ──
  it('snapshots current state', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    const snap = await store.snapshot('/tmp/test-snap');
    expect(snap.resourceVersion).toBeTruthy();
    expect(snap.createdAt).toBeTruthy();
  });

  it('compacts deleted resources', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    const rv = (await store.getHealth()).resourceVersion;
    await store.delete(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' });
    const result = await store.compact(rv);
    expect(result.compactedThrough).toBe(rv);
  });
});

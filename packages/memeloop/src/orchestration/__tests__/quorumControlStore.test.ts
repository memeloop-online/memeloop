import { describe, expect, it, vi } from 'vitest';
import { createVerifierOnlyAuthorizer } from '../artifacts/verifierOnlyTransitions.js';
import type { ControlStoreActor, ControlStoreAuthorizationRequest } from '../controlStore.js';
import { ARTIFACT_RECORD_API_VERSION } from '../resources.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

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

  it('atomically applies desired spec with CAS, generation, status preservation, and durable idempotency', async () => {
    const authorize = vi.fn();
    const store = new QuorumControlStore({
      memberId: 'n1',
      voters: ['n1'],
      authorizer: { authorize },
    });
    const created = await store.apply(adminActor, testResource, {
      idempotencyKey: 'apply-create',
    });
    await expect(store.apply(adminActor, testResource, {
      idempotencyKey: 'apply-noop',
    })).resolves.toEqual(created);
    await expect(store.apply(adminActor, {
      ...testResource,
      spec: { v: 99 },
    }, {
      resourceVersion: created.metadata.resourceVersion,
      idempotencyKey: 'apply-noop',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const withStatus = await store.updateStatus(
      adminActor,
      { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' },
      { phase: 'Ready' },
      { resourceVersion: created.metadata.resourceVersion },
    );
    expect(withStatus.metadata.generation).toBe(1);
    const changed = { ...testResource, spec: { v: 2 } };
    const applied = await store.apply(adminActor, changed, {
      resourceVersion: withStatus.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    });
    expect(applied.metadata.uid).toBe(created.metadata.uid);
    expect(applied.metadata.generation).toBe(2);
    expect(applied.status).toEqual({ phase: 'Ready' });
    await expect(store.apply(adminActor, { ...changed, spec: { v: 3 } }, {
      resourceVersion: withStatus.metadata.resourceVersion,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(adminActor, { ...changed, spec: { v: 4 } }, {
      resourceVersion: withStatus.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    const restored = makeStore(['n1']);
    restored.restoreSnapshot(store.exportSnapshot());
    await expect(restored.apply(adminActor, changed, {
      resourceVersion: withStatus.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).resolves.toEqual(applied);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      verb: 'apply',
      proposedResource: expect.objectContaining({ spec: { v: 2 } }),
    }));
  });

  it('enforces apply preconditions and field ownership with force transfer', async () => {
    const store = makeStore(['n1']);
    const owned = await store.apply(adminActor, testResource, { fieldManager: 'manager-a' });
    await expect(store.apply(adminActor, {
      ...testResource,
      spec: { v: 2 },
    }, {
      resourceVersion: owned.metadata.resourceVersion,
      fieldManager: 'manager-b',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const forced = await store.apply(adminActor, {
      ...testResource,
      spec: { v: 2 },
    }, {
      resourceVersion: owned.metadata.resourceVersion,
      fieldManager: 'manager-b',
      force: true,
    });
    expect(forced.metadata.generation).toBe(2);
    await expect(store.apply(adminActor, testResource, {
      preconditions: { uid: 'wrong' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(adminActor, testResource, {
      preconditions: { generation: 1 },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(adminActor, { ...testResource, metadata: { name: 'new' } }, {
      preconditions: { uid: 'must-exist' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(adminActor, testResource, { force: true })).rejects.toMatchObject({ code: 'INVALID' });
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
    const reference = { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' };
    const result = await store.delete(adminActor, reference);
    expect(result).toEqual({ accepted: true, reference });
    expect(await store.get({ apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' })).toBeNull();
  });

  it('deleting absent resource returns accepted:false', async () => {
    const store = makeStore();
    const reference = { apiVersion: 'v1', kind: 'Test', name: 'nonexistent' };
    const result = await store.delete(adminActor, reference);
    expect(result).toEqual({ accepted: false, reference });
  });

  it('enforces delete preconditions, authorization, dry-run, and durable idempotency', async () => {
    const authorize = vi.fn();
    const store = new QuorumControlStore({
      memberId: 'n1',
      voters: ['n1'],
      authorizer: { authorize },
    });
    const created = await store.create(adminActor, testResource);
    const reference = { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' };
    await expect(store.delete(adminActor, reference, {
      preconditions: { uid: 'wrong' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.delete(adminActor, reference, {
      preconditions: {
        uid: created.metadata.uid,
        resourceVersion: created.metadata.resourceVersion,
        generation: created.metadata.generation,
      },
      dryRun: true,
    })).resolves.toEqual({ accepted: true, reference });
    expect(await store.get(reference)).not.toBeNull();

    const result = await store.delete(adminActor, reference, {
      idempotencyKey: 'delete-once',
    });
    const restored = makeStore(['n1']);
    restored.restoreSnapshot(store.exportSnapshot());
    await expect(restored.delete(adminActor, reference, {
      idempotencyKey: 'delete-once',
    })).resolves.toEqual(result);
    await expect(restored.delete(
      { ...adminActor, id: 'another-admin' },
      reference,
      { idempotencyKey: 'delete-once' },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      verb: 'delete',
      current: expect.objectContaining({
        metadata: expect.objectContaining({ uid: created.metadata.uid }),
      }),
    }));
  });

  it('keeps a finalizing resource visible until its finalizers are cleared', async () => {
    const store = makeStore(['n1']);
    const manifest = {
      ...testResource,
      metadata: {
        ...testResource.metadata,
        finalizers: ['tests.memeloop.io/cleanup'],
      },
    };
    const created = await store.create(adminActor, manifest);
    const reference = {
      apiVersion: created.apiVersion,
      kind: created.kind,
      namespace: created.metadata.namespace,
      name: created.metadata.name,
    };
    await store.delete(adminActor, reference);
    const pending = await store.get(reference);
    expect(pending?.metadata.deletionTimestamp).toBeTruthy();
    expect(pending?.metadata.finalizers).toEqual(['tests.memeloop.io/cleanup']);

    const cleared = await store.apply(
      adminActor,
      {
        ...manifest,
        metadata: { ...manifest.metadata, finalizers: [] },
      },
      { resourceVersion: pending?.metadata.resourceVersion },
    );
    await store.delete(adminActor, reference, {
      preconditions: { resourceVersion: cleared.metadata.resourceVersion },
    });
    expect(await store.get(reference)).toBeNull();
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

  it('supports status dry-run and durable idempotency without changing generation', async () => {
    const store = makeStore(['n1']);
    const created = await store.create(adminActor, testResource);
    const reference = { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' };
    const dryRun = await store.updateStatus(
      adminActor,
      reference,
      { phase: 'Checking' },
      { resourceVersion: created.metadata.resourceVersion, dryRun: true },
    );
    expect(dryRun.metadata.generation).toBe(1);
    expect((await store.get(reference))?.status).toBeUndefined();

    const updated = await store.updateStatus(
      adminActor,
      reference,
      { phase: 'Ready' },
      {
        resourceVersion: created.metadata.resourceVersion,
        idempotencyKey: 'status-once',
      },
    );
    expect(updated.metadata.generation).toBe(1);
    const restored = makeStore(['n1']);
    restored.restoreSnapshot(store.exportSnapshot());
    await expect(restored.updateStatus(
      adminActor,
      reference,
      { phase: 'Ready' },
      {
        resourceVersion: created.metadata.resourceVersion,
        idempotencyKey: 'status-once',
      },
    )).resolves.toEqual(updated);
    await expect(restored.updateStatus(
      adminActor,
      reference,
      { phase: 'Failed' },
      {
        resourceVersion: created.metadata.resourceVersion,
        idempotencyKey: 'status-once',
      },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CAS rejects stale resourceVersion', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    // Wait, the first create gives rv 1, so version 1 is valid. Let me update first then retry with old version.
    await store.updateStatus(adminActor, { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' }, { conditions: [] }, { resourceVersion: '1' });
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

  it('authorizes every lease mutation', async () => {
    const authorize = vi.fn();
    const store = new QuorumControlStore({
      memberId: 'n1',
      voters: ['n1'],
      authorizer: { authorize },
    });
    const grant = await store.acquireLease(controllerActor, {
      name: 'protected-lock',
      holder: 'h1',
      ttlMs: 300_000,
    });
    await store.renewLease(controllerActor, grant, 300_000);
    await store.releaseLease(controllerActor, grant);
    expect(authorize.mock.calls.map((call) => (call[0] as ControlStoreAuthorizationRequest).verb)).toEqual([
      'acquire-lease',
      'renew-lease',
      'release-lease',
    ]);
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

  it('watch sends a snapshot bookmark and then buffers live events without a gap', async () => {
    const store = makeStore();
    await store.create(adminActor, testResource);
    const watcher = store.watch(
      { kind: 'Test' },
      { sendInitialEvents: true, allowBookmarks: true },
    );
    const iterator = watcher[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'ADDED', resource: { metadata: { name: 't1' } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'BOOKMARK' },
    });
    const live = iterator.next();
    await store.create(adminActor, {
      ...testResource,
      metadata: { name: 'r2' },
    });
    await expect(live).resolves.toMatchObject({
      done: false,
      value: { type: 'ADDED', resource: { metadata: { name: 'r2' } } },
    });
    await iterator.return?.();
  });

  it('watch observes abort and timeout options', async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const abortController = new AbortController();
      const aborted = store.watch(
        { kind: 'Test' },
        { signal: abortController.signal },
      )[Symbol.asyncIterator]();
      const abortResult = aborted.next();
      abortController.abort();
      await expect(abortResult).resolves.toMatchObject({ done: true });

      const timed = store.watch(
        { kind: 'Test' },
        { timeoutMs: 10 },
      )[Symbol.asyncIterator]();
      const timeoutResult = timed.next();
      await vi.advanceTimersByTimeAsync(10);
      await expect(timeoutResult).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays retained events from a cursor and reports compacted cursors', async () => {
    const store = makeStore();
    const created = await store.create(adminActor, testResource);
    await store.updateStatus(
      adminActor,
      { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' },
      { phase: 'Ready' },
      { resourceVersion: created.metadata.resourceVersion },
    );
    await store.create(adminActor, {
      ...testResource,
      metadata: { name: 't2', namespace: 'ns' },
    });
    const resumed = store.watch(
      { kind: 'Test' },
      { resourceVersion: created.metadata.resourceVersion },
    )[Symbol.asyncIterator]();
    await expect(resumed.next()).resolves.toMatchObject({
      value: { type: 'MODIFIED', resource: { metadata: { name: 't1' } } },
    });
    await expect(resumed.next()).resolves.toMatchObject({
      value: { type: 'ADDED', resource: { metadata: { name: 't2' } } },
    });
    await resumed.return?.();

    await store.compact('2');
    const compacted = store.watch(
      { kind: 'Test' },
      { resourceVersion: '1' },
    )[Symbol.asyncIterator]();
    await expect(compacted.next()).resolves.toMatchObject({
      value: {
        type: 'ERROR',
        terminal: true,
        error: { code: 'WATCH_COMPACTED' },
      },
    });
    await expect(compacted.next()).resolves.toMatchObject({ done: true });
  });

  it('preserves watch-resume history and its compaction boundary in snapshots', async () => {
    const store = makeStore();
    const created = await store.create(adminActor, testResource);
    await store.updateStatus(
      adminActor,
      { apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' },
      { phase: 'Ready' },
      { resourceVersion: created.metadata.resourceVersion },
    );
    const snapshot = store.exportSnapshot();
    const restored = makeStore();
    restored.restoreSnapshot(snapshot);
    const resumed = restored.watch(
      { kind: 'Test' },
      { resourceVersion: created.metadata.resourceVersion },
    )[Symbol.asyncIterator]();
    await expect(resumed.next()).resolves.toMatchObject({
      value: { type: 'MODIFIED', resource: { status: { phase: 'Ready' } } },
    });
    await resumed.return?.();
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
      apiVersion: ARTIFACT_RECORD_API_VERSION,
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
      store.updateStatus(nonVerifier, { apiVersion: ARTIFACT_RECORD_API_VERSION, kind: 'ArtifactRecord', name: 'sha256:xyz', namespace: 'default' }, { reviews: [review] }, {
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

  // ── Fencing Epochs (24.59) ──
  it('lease epochs are monotonic across release and re-acquire', async () => {
    const store = makeStore();
    const first = await store.acquireLease(controllerActor, { name: 'fence1', holder: 'h1', ttlMs: 300_000 });
    expect(first.epoch).toBe('1');
    await store.releaseLease(controllerActor, { name: first.name, holder: first.holder, leaseId: first.leaseId, epoch: first.epoch });

    const second = await store.acquireLease(controllerActor, { name: 'fence1', holder: 'h2', ttlMs: 300_000 });
    expect(second.epoch).toBe('2');

    // The stale holder's epoch is permanently unusable.
    await expect(
      store.renewLease(controllerActor, { name: 'fence1', holder: 'h1', leaseId: first.leaseId, epoch: first.epoch }, 300_000),
    ).rejects.toThrow();
  });

  it('lease epochs survive expiry', async () => {
    const store = makeStore();
    const first = await store.acquireLease(controllerActor, { name: 'fence2', holder: 'h1', ttlMs: 20 });
    expect(first.epoch).toBe('1');
    await new Promise((r) => setTimeout(r, 80));

    const second = await store.acquireLease(controllerActor, { name: 'fence2', holder: 'h2', ttlMs: 300_000 });
    expect(second.epoch).toBe('2');
  });

  // ── Snapshot Export / Restore (24.59) ──
  it('exportSnapshot/restoreSnapshot round-trips resources, revision, and fencing epochs', async () => {
    const source = makeStore();
    const created = await source.create(adminActor, testResource);
    await source.acquireLease(controllerActor, { name: 'snap-lease', holder: 'h1', ttlMs: 300_000 });
    const snapshot = source.exportSnapshot();
    expect(snapshot.resources.length).toBeGreaterThan(0);

    const restored = new QuorumControlStore({ memberId: 'n1', voters: ['n9'] });
    restored.restoreSnapshot(snapshot);

    // Resources are visible with identical resourceVersion.
    const got = await restored.get({ apiVersion: 'v1', kind: 'Test', name: 't1', namespace: 'ns' });
    expect(got).not.toBeNull();
    expect(got!.metadata.resourceVersion).toBe(created.metadata.resourceVersion);

    // New writes continue past the snapshotted revision.
    const next = await restored.create(adminActor, { ...testResource, metadata: { name: 't2', namespace: 'ns' } });
    expect(Number(next.metadata.resourceVersion)).toBeGreaterThan(Number(created.metadata.resourceVersion));

    // Fencing epochs are preserved: re-acquiring the snapshotted lease name
    // issues epoch 2, never a restarted epoch 1.
    const grant = await restored.acquireLease(controllerActor, { name: 'snap-lease', holder: 'h2', ttlMs: 300_000 });
    expect(grant.epoch).toBe('2');

    // Voter membership and quorum survive the restore.
    const topo = await restored.getTopology();
    expect(topo.members.filter((m) => !m.isLearner).map((m) => m.id).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  // ── Membership Migration (24.59) ──
  it('migrates one voter to three through learner promotion without write interruption', async () => {
    // §17.3: one stable node bootstraps as a single voter; new nodes start
    // as observers, then jointly migrate to three voters.
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    await store.create(adminActor, testResource);

    await store.addLearner({ id: 'n2', peerUrls: [], isLearner: true });
    await store.addLearner({ id: 'n3', peerUrls: [], isLearner: true });

    // Observers appear in topology but hold no vote; single-voter quorum is unchanged.
    let topo = await store.getTopology();
    expect(topo.members.filter((m) => m.isLearner).map((m) => m.id).sort()).toEqual(['n2', 'n3']);
    expect(topo.members.filter((m) => !m.isLearner)).toHaveLength(1);
    await store.create(adminActor, { ...testResource, metadata: { name: 'during-observation', namespace: 'ns' } });

    await store.promoteLearner('n2');
    await store.promoteLearner('n3');
    topo = await store.getTopology();
    expect(topo.members.filter((m) => !m.isLearner)).toHaveLength(3);
    expect(topo.members.filter((m) => m.isLearner)).toHaveLength(0);

    // Three voters (quorum 2) keep serving writes.
    await store.create(adminActor, { ...testResource, metadata: { name: 'after-migration', namespace: 'ns' } });
    expect((await store.getHealth()).healthy).toBe(true);
  });

  it('recomputes quorum on voter removal and guards the last voter', async () => {
    const store = makeStore(['n1', 'n2', 'n3']);
    await store.removeVoter('n3');
    // Two voters -> quorum 2; writes still acknowledged.
    await store.create(adminActor, testResource);
    await store.removeVoter('n2');
    // One voter -> quorum 1; single-node operation remains first-class.
    await store.create(adminActor, { ...testResource, metadata: { name: 'solo', namespace: 'ns' } });
    await expect(store.removeVoter('n1')).rejects.toThrow('last voter');
  });

  it('does not count learners toward quorum', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    await store.addLearner({ id: 'n2', peerUrls: [], isLearner: true });
    await store.addLearner({ id: 'n3', peerUrls: [], isLearner: true });
    // Still a one-voter quorum; learner presence must not change write behavior.
    await store.create(adminActor, testResource);
    expect((await store.getTopology()).leaderId).toBe('n1');
  });
});

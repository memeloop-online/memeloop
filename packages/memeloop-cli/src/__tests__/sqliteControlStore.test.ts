import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ControlStoreActor,
  type ControlStoreAuthorizationRequest,
  createControlStoreConformanceSuite,
  createControlStoreLoopCheckpointStore,
  OrchestrationError,
  type OrchestrationResourceManifest,
  runConformanceSuite,
} from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTROL_STORE_READ_BATCH_SIZE, MAX_CONTROL_STORE_PAGE_SIZE, SQLiteControlStore } from '../orchestration/sqliteControlStore.js';

const CONTROLLER: ControlStoreActor = { id: 'controller/test', kind: 'controller' };
const VERIFIER: ControlStoreActor = { id: 'verifier/test', kind: 'verifier' };

function manifest(name: string, labels?: Record<string, string>): OrchestrationResourceManifest<{ value: string }> {
  return {
    apiVersion: 'tests.memeloop.io/v1alpha1',
    kind: 'TestResource',
    metadata: { name, ...(labels ? { labels } : {}) },
    spec: { value: name },
  };
}

describe('SQLiteControlStore', () => {
  let directory: string;
  let filename: string;
  let current: Date;
  let uidCounter: number;
  let authorized: ControlStoreAuthorizationRequest[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memeloop-control-'));
    filename = join(directory, 'control.db');
    current = new Date('2026-07-18T00:00:00.000Z');
    uidCounter = 0;
    authorized = [];
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(path = filename): SQLiteControlStore {
    return new SQLiteControlStore({
      filename: path,
      now: () => current,
      uid: () => `uid-${++uidCounter}`,
      pollIntervalMs: 1,
      authorizer: {
        authorize(request) {
          authorized.push(request);
          if (request.verb === 'update-status' && request.actor.kind !== 'controller') {
            throw new OrchestrationError({ code: 'FORBIDDEN', message: 'only controllers may update this status', retryable: false });
          }
        },
      },
    });
  }

  it('passes the shared ControlStore conformance suite', async () => {
    const suite = createControlStoreConformanceSuite({
      actor: CONTROLLER,
      prefix: 'sqlite',
      create: () => createStore(),
      snapshotTarget: (testName) => join(directory, `conformance-${testName}.db`),
    });
    const result = await runConformanceSuite(suite, undefined);

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });

  it('honors an explicitly supplied native binding path', () => {
    const missingBinding = join(directory, 'host-native', 'better_sqlite3.node');
    expect(() =>
      new SQLiteControlStore({
        filename,
        nativeBinding: missingBinding,
        authorizer: { authorize() {} },
      })
    ).toThrow(missingBinding);
  });

  it('persists resources and idempotent creates across restart', async () => {
    let store = createStore();
    const created = await store.create(CONTROLLER, manifest('alpha'), { idempotencyKey: 'create-alpha' });
    const replay = await store.create(CONTROLLER, manifest('alpha'), { idempotencyKey: 'create-alpha' });
    expect(replay).toEqual(created);
    expect(created.metadata).toMatchObject({ name: 'alpha', uid: 'uid-1', generation: 1, resourceVersion: '1' });
    await store.close();

    store = createStore();
    await expect(store.get({ apiVersion: created.apiVersion, kind: created.kind, name: 'alpha' })).resolves.toEqual(created);
    await store.close();
  });

  it('treats get resourceVersion as a store consistency cursor, not a per-resource version', async () => {
    const store = createStore();
    const alpha = await store.create(CONTROLLER, manifest('alpha'));
    const beta = await store.create(CONTROLLER, manifest('beta'));

    await expect(store.get(
      { apiVersion: alpha.apiVersion, kind: alpha.kind, name: alpha.metadata.name },
      { resourceVersion: beta.metadata.resourceVersion },
    )).resolves.toEqual(alpha);
    await expect(store.get(
      { apiVersion: alpha.apiVersion, kind: alpha.kind, name: alpha.metadata.name },
      { resourceVersion: String(BigInt(beta.metadata.resourceVersion) + 1n) },
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    await store.close();
  });

  it('atomically applies changed desired state and preserves identity, status, and replay across restart', async () => {
    let store = createStore();
    const created = await store.apply(CONTROLLER, manifest('apply'), {
      idempotencyKey: 'apply-create',
    });
    await expect(store.apply(CONTROLLER, manifest('apply'), {
      idempotencyKey: 'apply-noop',
    })).resolves.toEqual(created);
    await expect(store.apply(CONTROLLER, {
      ...manifest('apply'),
      spec: { value: 'drift-from-noop' },
    }, {
      resourceVersion: created.metadata.resourceVersion,
      idempotencyKey: 'apply-noop',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const running = await store.updateStatus(
      CONTROLLER,
      {
        apiVersion: created.apiVersion,
        kind: created.kind,
        name: created.metadata.name,
      },
      { phase: 'Running' },
      { resourceVersion: created.metadata.resourceVersion },
    );
    const changed = {
      ...manifest('apply'),
      spec: { value: 'changed' },
    };
    const applied = await store.apply(CONTROLLER, changed, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    });
    expect(applied.metadata).toMatchObject({
      uid: created.metadata.uid,
      generation: 2,
      resourceVersion: '3',
    });
    expect(applied.status).toEqual({ phase: 'Running' });
    await expect(store.apply(CONTROLLER, {
      ...changed,
      spec: { value: 'drift' },
    }, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.close();

    store = createStore();
    await expect(store.apply(CONTROLLER, changed, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).resolves.toEqual(applied);
    expect(authorized).toContainEqual(expect.objectContaining({
      verb: 'apply',
      proposedResource: expect.objectContaining({ spec: { value: 'changed' } }),
    }));
    await store.close();
  });

  it('enforces apply uid/generation preconditions and field ownership', async () => {
    const store = createStore();
    const owned = await store.apply(CONTROLLER, manifest('owned'), { fieldManager: 'manager-a' });
    await expect(store.apply(CONTROLLER, {
      ...manifest('owned'),
      spec: { value: 'manager-b-change' },
    }, {
      resourceVersion: owned.metadata.resourceVersion,
      fieldManager: 'manager-b',
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    const forced = await store.apply(CONTROLLER, {
      ...manifest('owned'),
      spec: { value: 'manager-b-change' },
    }, {
      resourceVersion: owned.metadata.resourceVersion,
      fieldManager: 'manager-b',
      force: true,
    });
    expect(forced.metadata.generation).toBe(2);

    await expect(store.apply(CONTROLLER, {
      ...manifest('owned'),
      spec: { value: 'manager-a-change' },
    }, {
      resourceVersion: forced.metadata.resourceVersion,
      fieldManager: 'manager-a',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(CONTROLLER, manifest('owned'), {
      preconditions: { uid: 'wrong-uid' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(CONTROLLER, manifest('owned'), {
      preconditions: { generation: 1 },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(CONTROLLER, manifest('missing'), {
      preconditions: { uid: 'must-exist' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.apply(CONTROLLER, manifest('owned'), { force: true })).rejects.toMatchObject({ code: 'INVALID' });
    await store.close();
  });

  it('finishes an active watch before closing its native database', async () => {
    const store = createStore();
    const iterator = store.watch(
      { kind: 'TestResource' },
      { resourceVersion: '0' },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();
    await store.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('authorizes status writes inside exact resourceVersion CAS', async () => {
    const store = createStore();
    const created = await store.create(CONTROLLER, manifest('status'));

    await expect(store.updateStatus(
      VERIFIER,
      {
        apiVersion: created.apiVersion,
        kind: created.kind,
        name: created.metadata.name,
      },
      { phase: 'Verified' },
      { resourceVersion: created.metadata.resourceVersion },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const reference = {
      apiVersion: created.apiVersion,
      kind: created.kind,
      name: created.metadata.name,
    };
    const updated = await store.updateStatus(CONTROLLER, reference, { phase: 'Running' }, {
      resourceVersion: created.metadata.resourceVersion,
      idempotencyKey: 'status-running',
    });
    const replay = await store.updateStatus(CONTROLLER, reference, { phase: 'Running' }, {
      resourceVersion: created.metadata.resourceVersion,
      idempotencyKey: 'status-running',
    });
    expect(replay).toEqual(updated);
    expect(updated.status).toEqual({ phase: 'Running' });
    expect(updated.metadata.resourceVersion).toBe('2');
    expect(updated.metadata.generation).toBe(1);
    await expect(store.updateStatus(
      CONTROLLER,
      {
        apiVersion: created.apiVersion,
        kind: created.kind,
        name: created.metadata.name,
      },
      { phase: 'Stale' },
      { resourceVersion: created.metadata.resourceVersion },
    )).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { expected: '1', current: '2' },
    });
    expect(authorized.filter((request) => request.verb === 'update-status')).toHaveLength(2);
    await store.close();
  });

  it('separates operation idempotency and completes finalizer deletion across restart', async () => {
    let store = createStore();
    const created = await store.create(
      CONTROLLER,
      {
        ...manifest('finalized'),
        metadata: {
          name: 'finalized',
          finalizers: ['tests.memeloop.io/cleanup'],
        },
      },
      { idempotencyKey: 'shared-key' },
    );
    const reference = {
      apiVersion: created.apiVersion,
      kind: created.kind,
      name: created.metadata.name,
    };
    const running = await store.updateStatus(
      CONTROLLER,
      reference,
      { phase: 'Running' },
      {
        resourceVersion: created.metadata.resourceVersion,
        idempotencyKey: 'shared-key',
      },
    );
    await store.delete(CONTROLLER, reference);
    const pending = await store.get(reference);
    expect(pending?.metadata.deletionTimestamp).toBeTruthy();

    const cleared = await store.apply(
      CONTROLLER,
      {
        ...manifest('finalized'),
        metadata: { name: 'finalized', finalizers: [] },
      },
      { resourceVersion: pending?.metadata.resourceVersion },
    );
    expect(cleared.metadata.generation).toBe(running.metadata.generation);
    const deleted = await store.delete(CONTROLLER, reference, {
      preconditions: { resourceVersion: cleared.metadata.resourceVersion },
      idempotencyKey: 'shared-key',
    });
    expect(await store.get(reference)).toBeNull();
    await store.close();

    store = createStore();
    await expect(store.delete(CONTROLLER, reference, {
      preconditions: { resourceVersion: cleared.metadata.resourceVersion },
      idempotencyKey: 'shared-key',
    })).resolves.toEqual(deleted);
    await expect(store.delete(
      { ...CONTROLLER, id: 'controller/other' },
      reference,
      { idempotencyKey: 'shared-key' },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.close();
  });

  it('lists an empty revision-zero store', async () => {
    const store = createStore();
    await expect(store.list({ kind: 'TestResource' })).resolves.toEqual({ items: [], resourceVersion: '0' });
    await store.close();
  });

  it('keeps list pagination on one resourceVersion snapshot', async () => {
    const store = createStore();
    await store.create(CONTROLLER, manifest('alpha', { group: 'one' }));
    const beta = await store.create(CONTROLLER, manifest('beta', { group: 'one' }));
    const first = await store.list({ kind: 'TestResource', labels: { group: 'one' } }, { limit: 1 });
    await store.updateStatus(
      CONTROLLER,
      {
        apiVersion: beta.apiVersion,
        kind: beta.kind,
        name: beta.metadata.name,
      },
      { phase: 'changed-after-first-page' },
      { resourceVersion: beta.metadata.resourceVersion },
    );
    const second = await store.list({ kind: 'TestResource', labels: { group: 'one' } }, { continueToken: first.continueToken });

    expect(first.resourceVersion).toBe('2');
    expect(first.items.map((item) => item.metadata.name)).toEqual(['alpha']);
    expect(second.resourceVersion).toBe('2');
    expect(second.items.map((item) => item.metadata.name)).toEqual(['beta']);
    expect(second.items[0]?.status).toBeUndefined();
    await store.close();
  });

  it('keyset-pages a large resource set and rejects a caller-sized page', async () => {
    const store = createStore();
    const count = CONTROL_STORE_READ_BATCH_SIZE + 5;
    for (let index = 0; index < count; index += 1) {
      await store.create(CONTROLLER, manifest(`bulk-${String(index).padStart(3, '0')}`));
    }
    await expect(store.list({ kind: 'TestResource' }, { limit: MAX_CONTROL_STORE_PAGE_SIZE + 1 })).rejects.toMatchObject({ code: 'INVALID' });

    const names: string[] = [];
    let page = await store.list({ kind: 'TestResource' }, { limit: 1 });
    for (;;) {
      names.push(...page.items.map((item) => item.metadata.name));
      if (!page.continueToken) break;
      page = await store.list({ kind: 'TestResource' }, { limit: 1, continueToken: page.continueToken });
    }
    expect(names).toHaveLength(count);
    expect(new Set(names).size).toBe(count);
    await store.close();
  }, 30_000);

  it('cancels a batched initial watch without materializing the full snapshot', async () => {
    const store = createStore();
    for (let index = 0; index < CONTROL_STORE_READ_BATCH_SIZE + 5; index += 1) {
      await store.create(CONTROLLER, manifest(`watch-${String(index).padStart(3, '0')}`));
    }
    const controller = new AbortController();
    const iterator = store.watch({ kind: 'TestResource' }, {
      sendInitialEvents: true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'ADDED' });
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await store.close();
  }, 30_000);

  it('replays watch events and reports compacted cursors', async () => {
    const store = createStore();
    await store.create(CONTROLLER, manifest('alpha'));
    await store.create(CONTROLLER, manifest('beta'));
    const iterator = store.watch({ kind: 'TestResource' }, { resourceVersion: '0', timeoutMs: 100 })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'ADDED', resourceVersion: '1', resource: { metadata: { name: 'alpha' } } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'ADDED', resourceVersion: '2', resource: { metadata: { name: 'beta' } } } });
    await iterator.return?.();

    await store.compact('1');
    const compacted = store.watch({ kind: 'TestResource' }, { resourceVersion: '0' })[Symbol.asyncIterator]();
    await expect(compacted.next()).resolves.toMatchObject({
      value: { type: 'ERROR', terminal: true, error: { code: 'WATCH_COMPACTED' } },
    });
    await store.close();
  });

  it('fences leases with a monotonic epoch and rejects stale identities', async () => {
    const store = createStore();
    const first = await store.acquireLease(CONTROLLER, { name: 'replication/volume-1', holder: 'controller-a', ttlMs: 1000 });
    await expect(store.acquireLease(CONTROLLER, {
      name: 'replication/volume-1',
      holder: 'controller-b',
      ttlMs: 1000,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const renewed = await store.renewLease(CONTROLLER, first, 2000);
    expect(renewed.epoch).toBe(first.epoch);

    current = new Date('2026-07-18T00:00:03.000Z');
    const second = await store.acquireLease(CONTROLLER, { name: 'replication/volume-1', holder: 'controller-b', ttlMs: 1000 });
    expect(BigInt(second.epoch)).toBe(BigInt(first.epoch) + 1n);
    await expect(store.renewLease(CONTROLLER, first, 1000)).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await store.releaseLease(CONTROLLER, second);
    await store.close();
  });

  it('backs quality-gate checkpoints and restores snapshots', async () => {
    const store = createStore();
    const checkpoints = createControlStoreLoopCheckpointStore(store, CONTROLLER, () => current);
    await checkpoints.saveCheckpoint('conversation-1', 'quality-gate:1:attempt', { text: 'draft-v1' });
    await expect(checkpoints.loadCheckpoint('conversation-1', 'quality-gate:1:attempt')).resolves.toEqual({ text: 'draft-v1' });

    const snapshotPath = join(directory, 'snapshot.db');
    const snapshot = await store.snapshot(snapshotPath);
    expect(snapshot.resourceVersion).toBe('1');
    await store.close();

    const restored = createStore(snapshotPath);
    const restoredCheckpoints = createControlStoreLoopCheckpointStore(restored, CONTROLLER, () => current);
    await expect(restoredCheckpoints.loadCheckpoint('conversation-1', 'quality-gate:1:attempt')).resolves.toEqual({ text: 'draft-v1' });
    expect((await restored.getHealth()).healthy).toBe(true);
    await restored.close();
  });

  it('does not call the authorizer again when an idempotent create is replayed', async () => {
    const store = createStore();
    await store.create(CONTROLLER, manifest('once'), { idempotencyKey: 'once' });
    await store.create(CONTROLLER, manifest('once'), { idempotencyKey: 'once' });
    expect(authorized.filter((request) => request.verb === 'create')).toHaveLength(1);
    expect(authorized).toContainEqual(expect.objectContaining({
      verb: 'create',
      proposedResource: expect.objectContaining({ spec: { value: 'once' } }),
    }));
    await store.close();
  });
});

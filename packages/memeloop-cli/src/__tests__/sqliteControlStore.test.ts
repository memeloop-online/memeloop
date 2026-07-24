import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ControlStoreActor,
  type ControlStoreAuthorizationRequest,
  createControlStoreLoopCheckpointStore,
  OrchestrationError,
  type OrchestrationResourceManifest,
} from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteControlStore } from '../orchestration/sqliteControlStore.js';

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
    await store.close();
  });
});

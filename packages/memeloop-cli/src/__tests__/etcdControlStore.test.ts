import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ControlStoreActor, createControlStoreConformanceSuite, OrchestrationError, type OrchestrationResourceManifest, runConformanceSuite } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EtcdControlStore } from '../orchestration/etcdControlStore.js';

const ENDPOINTS = process.env.MEMELOOP_TEST_ETCD_ENDPOINTS
  ?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ETCD_USERNAME = process.env.MEMELOOP_TEST_ETCD_USERNAME;
const ETCD_PASSWORD = process.env.MEMELOOP_TEST_ETCD_PASSWORD;
const describeEtcd = ENDPOINTS?.length ? describe : describe.skip;
const CONTROLLER: ControlStoreActor = { id: 'controller/test', kind: 'controller' };

function manifest(name: string, labels?: Record<string, string>): OrchestrationResourceManifest<{ value: string }> {
  return {
    apiVersion: 'tests.memeloop.io/v1alpha1',
    kind: 'TestResource',
    metadata: { name, ...(labels ? { labels } : {}) },
    spec: { value: name },
  };
}

describeEtcd('EtcdControlStore (real etcd)', () => {
  let current: Date;
  let directory: string;
  let namespace: string;
  let stores: EtcdControlStore[];
  let uid: number;

  beforeEach(async () => {
    current = new Date('2026-07-23T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'memeloop-etcd-control-'));
    namespace = `/memeloop/tests/${crypto.randomUUID()}/`;
    stores = [];
    uid = 0;
  });

  afterEach(async () => {
    await Promise.all(stores.map(async (store) => {
      await store.close();
    }));
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): EtcdControlStore {
    const store = new EtcdControlStore({
      connection: {
        hosts: ENDPOINTS!,
        dialTimeout: 2_000,
        defaultCallOptions: (context) => context.isStream ? {} : { deadline: Date.now() + 2_000 },
        ...(ETCD_USERNAME && ETCD_PASSWORD
          ? { auth: { username: ETCD_USERNAME, password: ETCD_PASSWORD } }
          : {}),
      },
      namespace,
      now: () => current,
      uid: () => `uid-${++uid}`,
      authorizer: {
        authorize(request) {
          if (request.verb === 'update-status' && request.actor.kind !== 'controller') {
            throw new OrchestrationError({ code: 'FORBIDDEN', message: 'controller required', retryable: false });
          }
        },
      },
    });
    stores.push(store);
    return store;
  }

  it('passes the shared ControlStore conformance suite', async () => {
    const suite = createControlStoreConformanceSuite({
      actor: CONTROLLER,
      prefix: 'etcd',
      create: () => createStore(),
      snapshotTarget: (testName) => join(directory, `conformance-${testName}.snapshot`),
    });
    const result = await runConformanceSuite(suite, undefined);

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });

  it('shares transactional CRUD, CAS, idempotency, pagination, and watches between clients', async () => {
    const writer = createStore();
    const reader = createStore();
    const alpha = await writer.create(CONTROLLER, manifest('alpha', { group: 'one' }), {
      idempotencyKey: 'create-alpha',
    });
    await expect(reader.create(CONTROLLER, manifest('alpha', { group: 'one' }), {
      idempotencyKey: 'create-alpha',
    })).resolves.toEqual(alpha);
    const beta = await writer.create(CONTROLLER, manifest('beta', { group: 'one' }));

    const first = await reader.list({ kind: 'TestResource', labels: { group: 'one' } }, { limit: 1 });
    const updated = await writer.updateStatus(
      CONTROLLER,
      { apiVersion: beta.apiVersion, kind: beta.kind, name: beta.metadata.name },
      { phase: 'Running' },
      { resourceVersion: beta.metadata.resourceVersion, idempotencyKey: 'run-beta' },
    );
    const second = await reader.list(
      { kind: 'TestResource', labels: { group: 'one' } },
      { continueToken: first.continueToken },
    );

    expect(first.resourceVersion).toBe('2');
    expect(first.items.map((item) => item.metadata.name)).toEqual(['alpha']);
    expect(second.resourceVersion).toBe('2');
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.metadata.name).toBe('beta');
    expect(second.items[0]?.status).toBeUndefined();
    await expect(reader.updateStatus(
      CONTROLLER,
      { apiVersion: beta.apiVersion, kind: beta.kind, name: beta.metadata.name },
      { phase: 'Stale' },
      { resourceVersion: beta.metadata.resourceVersion },
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    const iterator = reader.watch(
      { kind: 'TestResource' },
      { resourceVersion: '0', timeoutMs: 2_000 },
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'ADDED', resourceVersion: '1', resource: { metadata: { name: 'alpha' } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'ADDED', resourceVersion: '2', resource: { metadata: { name: 'beta' } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'MODIFIED', resourceVersion: '3', resource: { status: { phase: 'Running' } } },
    });
    await iterator.return?.();
    expect(updated.metadata.resourceVersion).toBe('3');
  });

  it('uses native leases and preserves fencing epochs across expiry and release', async () => {
    const firstClient = createStore();
    const secondClient = createStore();
    const first = await firstClient.acquireLease(CONTROLLER, {
      name: 'controller/scheduler',
      holder: 'node-a',
      ttlMs: 1_000,
    });
    await expect(secondClient.acquireLease(CONTROLLER, {
      name: 'controller/scheduler',
      holder: 'node-b',
      ttlMs: 1_000,
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    const renewed = await secondClient.renewLease(CONTROLLER, first, 2_000);
    expect(renewed.epoch).toBe('1');
    current = new Date('2026-07-23T00:00:03.000Z');
    const second = await secondClient.acquireLease(CONTROLLER, {
      name: 'controller/scheduler',
      holder: 'node-b',
      ttlMs: 1_000,
    });
    expect(second.epoch).toBe('2');
    await expect(firstClient.renewLease(CONTROLLER, first, 1_000)).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await secondClient.releaseLease(CONTROLLER, second);

    const third = await firstClient.acquireLease(CONTROLLER, {
      name: 'controller/scheduler',
      holder: 'node-c',
      ttlMs: 1_000,
    });
    expect(third.epoch).toBe('3');
  });

  it('atomically applies spec changes with CAS, generation, status preservation, and cross-client replay', async () => {
    const writer = createStore();
    const reader = createStore();
    const created = await writer.apply(CONTROLLER, manifest('apply'), {
      idempotencyKey: 'apply-create',
    });
    await expect(reader.apply(CONTROLLER, manifest('apply'), {
      idempotencyKey: 'apply-noop',
    })).resolves.toEqual(created);
    await expect(writer.apply(CONTROLLER, {
      ...manifest('apply'),
      spec: { value: 'drift-from-noop' },
    }, {
      resourceVersion: created.metadata.resourceVersion,
      idempotencyKey: 'apply-noop',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const running = await writer.updateStatus(
      CONTROLLER,
      {
        apiVersion: created.apiVersion,
        kind: created.kind,
        name: created.metadata.name,
      },
      { phase: 'Running' },
      { resourceVersion: created.metadata.resourceVersion },
    );
    const changed = { ...manifest('apply'), spec: { value: 'changed' } };
    const applied = await writer.apply(CONTROLLER, changed, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    });
    expect(applied.metadata.uid).toBe(created.metadata.uid);
    expect(applied.metadata.generation).toBe(2);
    expect(applied.status).toEqual({ phase: 'Running' });
    await expect(reader.apply(CONTROLLER, {
      ...changed,
      spec: { value: 'drift' },
    }, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reader.apply(CONTROLLER, changed, {
      resourceVersion: running.metadata.resourceVersion,
      idempotencyKey: 'apply-change',
    })).resolves.toEqual(applied);
  });

  it('separates operation idempotency and completes finalizer deletion across clients', async () => {
    const writer = createStore();
    const reader = createStore();
    const created = await writer.create(
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
    const running = await writer.updateStatus(
      CONTROLLER,
      reference,
      { phase: 'Running' },
      {
        resourceVersion: created.metadata.resourceVersion,
        idempotencyKey: 'shared-key',
      },
    );
    await writer.delete(CONTROLLER, reference);
    const pending = await reader.get(reference);
    expect(pending?.metadata.deletionTimestamp).toBeTruthy();
    const cleared = await writer.apply(
      CONTROLLER,
      {
        ...manifest('finalized'),
        metadata: { name: 'finalized', finalizers: [] },
      },
      { resourceVersion: pending?.metadata.resourceVersion },
    );
    expect(cleared.metadata.generation).toBe(running.metadata.generation);
    const deleted = await writer.delete(CONTROLLER, reference, {
      preconditions: { resourceVersion: cleared.metadata.resourceVersion },
      idempotencyKey: 'shared-key',
    });
    await expect(reader.get(reference)).resolves.toBeNull();
    await expect(reader.delete(CONTROLLER, reference, {
      preconditions: { resourceVersion: cleared.metadata.resourceVersion },
      idempotencyKey: 'shared-key',
    })).resolves.toEqual(deleted);
  });

  it('compacts logical history, reports Raft health/membership, and writes an etcd snapshot', async () => {
    const store = createStore();
    await store.create(CONTROLLER, manifest('alpha'));
    await store.create(CONTROLLER, manifest('beta'));
    await expect(store.compact('1')).resolves.toEqual({ compactedThrough: '1', resourceVersion: '2' });
    await expect(store.list({ kind: 'TestResource' }, { resourceVersion: '1' })).resolves.toMatchObject({
      resourceVersion: '1',
      items: [{ metadata: { name: 'alpha' } }],
    });
    const compacted = store.watch({ kind: 'TestResource' }, { resourceVersion: '0' })[Symbol.asyncIterator]();
    await expect(compacted.next()).resolves.toMatchObject({
      value: { type: 'ERROR', terminal: true, error: { code: 'WATCH_COMPACTED' } },
    });
    const health = await store.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('leader=');
    expect(await store.listMembers()).not.toHaveLength(0);

    const path = join(directory, 'etcd.snapshot');
    const result = await store.snapshot(path);
    expect(result.resourceVersion).toBe('2');
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  });
});

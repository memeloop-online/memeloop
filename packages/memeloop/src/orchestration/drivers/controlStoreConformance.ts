import type { OrchestrationResourceManifest } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';

import type { DriverConformanceSuite } from './driverConformance.js';

export interface ControlStoreConformanceFactory {
  create(): ControlStore | Promise<ControlStore>;
  actor: ControlStoreActor;
  snapshotTarget(testName: string): string | Promise<string>;
  /** Deterministically advance a backend's host lease clock when available. */
  advanceLeaseClock?(milliseconds: number): void | Promise<void>;
  prefix?: string;
}

function manifest(
  prefix: string,
  name: string,
  value = 1,
  finalizers?: string[],
): OrchestrationResourceManifest<{ value: number }> {
  return {
    apiVersion: 'conformance.memeloop.io/v1alpha1',
    kind: 'ControlStoreProbe',
    metadata: {
      name: `${prefix}-${name}`,
      namespace: 'conformance',
      ...(finalizers ? { finalizers } : {}),
    },
    spec: { value },
  };
}

function referenceFor(resource: OrchestrationResourceManifest) {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    namespace: resource.metadata.namespace,
  };
}

async function withStore(
  factory: ControlStoreConformanceFactory,
  run: (store: ControlStore) => Promise<void>,
): Promise<void> {
  const store = await factory.create();
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

/**
 * Backend-neutral §10.1 contract. Every test creates an isolated client/store
 * instance so the exact same suite can run against Quorum, SQLite, and etcd.
 */
export function createControlStoreConformanceSuite(
  factory: ControlStoreConformanceFactory,
): DriverConformanceSuite {
  const prefix = factory.prefix ?? 'control-store';
  const actor = factory.actor;
  return {
    interfaceKind: 'control-store',
    tests: [
      {
        name: 'atomically applies desired state and status',
        description: 'Apply preserves identity/status and advances generation only for spec changes',
        run: async () => {
          await withStore(factory, async (store) => {
            const desired = manifest(prefix, 'apply');
            const created = await store.apply(actor, desired, {
              idempotencyKey: 'apply-create',
            });
            const reference = referenceFor(desired);
            const running = await store.updateStatus(
              actor,
              reference,
              { phase: 'Running' },
              { resourceVersion: created.metadata.resourceVersion },
            );
            const changed = await store.apply(
              actor,
              manifest(prefix, 'apply', 2),
              {
                resourceVersion: running.metadata.resourceVersion,
                idempotencyKey: 'apply-change',
              },
            );
            if (
              changed.metadata.uid !== created.metadata.uid ||
              changed.metadata.generation !== 2 ||
              (changed.status as { phase?: string } | undefined)?.phase !==
                'Running'
            ) throw new Error('Apply did not preserve identity/status or generation');
            const metadataOnly = await store.apply(
              actor,
              {
                ...manifest(prefix, 'apply', 2),
                metadata: {
                  ...desired.metadata,
                  labels: { stage: 'ready' },
                },
              },
              { resourceVersion: changed.metadata.resourceVersion },
            );
            if (metadataOnly.metadata.generation !== 2) {
              throw new Error('metadata-only Apply advanced generation');
            }
            const listed = await store.list({
              apiVersion: desired.apiVersion,
              kind: desired.kind,
              namespace: desired.metadata.namespace,
              labels: { stage: 'ready' },
            });
            if (listed.items.length !== 1) throw new Error('applied resource was not listed');
          });
        },
      },
      {
        name: 'scopes idempotency, CAS, authorization inputs, and dry-run',
        description: 'Operation keys do not collide and preconditions fail closed',
        run: async () => {
          await withStore(factory, async (store) => {
            const desired = manifest(prefix, 'idempotency');
            const created = await store.create(actor, desired, {
              idempotencyKey: 'shared-key',
            });
            const reference = referenceFor(desired);
            const status = await store.updateStatus(
              actor,
              reference,
              { phase: 'Ready' },
              {
                resourceVersion: created.metadata.resourceVersion,
                idempotencyKey: 'shared-key',
              },
            );
            await store.apply(actor, desired, {
              idempotencyKey: 'shared-key',
            });
            const dryRun = await store.delete(actor, reference, {
              dryRun: true,
              preconditions: {
                uid: status.metadata.uid,
                resourceVersion: status.metadata.resourceVersion,
                generation: status.metadata.generation,
              },
            });
            if (!dryRun.accepted || !await store.get(reference)) {
              throw new Error('delete dry-run changed authoritative state');
            }
            let staleRejected = false;
            try {
              await store.updateStatus(
                actor,
                reference,
                { phase: 'Stale' },
                { resourceVersion: created.metadata.resourceVersion },
              );
            } catch (error) {
              staleRejected = error instanceof OrchestrationError &&
                error.code === 'CONFLICT';
            }
            if (!staleRejected) throw new Error('stale status CAS was accepted');
            const deleted = await store.delete(actor, reference, {
              idempotencyKey: 'shared-key',
            });
            const replay = await store.delete(actor, reference, {
              idempotencyKey: 'shared-key',
            });
            if (!deleted.accepted || !replay.accepted) {
              throw new Error('delete did not replay its accepted result');
            }
            let driftRejected = false;
            try {
              await store.delete(
                { ...actor, id: `${actor.id}/drift` },
                reference,
                { idempotencyKey: 'shared-key' },
              );
            } catch (error) {
              driftRejected = error instanceof OrchestrationError &&
                error.code === 'CONFLICT';
            }
            if (!driftRejected) throw new Error('delete idempotency drift was accepted');
          });
        },
      },
      {
        name: 'resumes an ordered watch and terminates on abort',
        description: 'ADDED/MODIFIED/DELETED events are ordered after a cursor',
        run: async () => {
          await withStore(factory, async (store) => {
            const desired = manifest(prefix, 'watch');
            const reference = referenceFor(desired);
            const cursor = (await store.getHealth()).resourceVersion;
            const controller = new AbortController();
            const iterator = store.watch(
              {
                apiVersion: desired.apiVersion,
                kind: desired.kind,
                namespace: desired.metadata.namespace,
              },
              {
                resourceVersion: cursor,
                timeoutMs: 5000,
                signal: controller.signal,
              },
            )[Symbol.asyncIterator]();
            const firstPending = iterator.next();
            const created = await store.create(actor, desired);
            const first = await firstPending;
            if (first.done || first.value.type !== 'ADDED') {
              throw new Error('watch did not emit ADDED');
            }
            const secondPending = iterator.next();
            const updated = await store.updateStatus(
              actor,
              reference,
              { phase: 'Ready' },
              { resourceVersion: created.metadata.resourceVersion },
            );
            const second = await secondPending;
            if (second.done || second.value.type !== 'MODIFIED') {
              throw new Error('watch did not emit MODIFIED');
            }
            const thirdPending = iterator.next();
            await store.delete(actor, reference, {
              preconditions: {
                resourceVersion: updated.metadata.resourceVersion,
              },
            });
            const third = await thirdPending;
            if (third.done || third.value.type !== 'DELETED') {
              throw new Error('watch did not emit DELETED');
            }
            const aborted = iterator.next();
            controller.abort();
            const done = await aborted;
            if (!done.done) throw new Error('watch did not terminate after abort');
          });
        },
      },
      {
        name: 'fences creates and applies with current expiring leases',
        description: 'Lease identity is an atomic create/apply predicate across stale, release, expiry, and takeover',
        run: async () => {
          await withStore(factory, async (store) => {
            const leaseName = `${prefix}/lease`;
            const first = await store.acquireLease(actor, {
              name: leaseName,
              holder: 'controller-a',
              ttlMs: 30_000,
            });
            const rejectStaleLease = async (
              operation: () => Promise<unknown>,
              description: string,
            ): Promise<void> => {
              let rejected = false;
              try {
                await operation();
              } catch (error) {
                rejected = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
              }
              if (!rejected) throw new Error(`${description} accepted a stale lease precondition`);
            };
            await store.create(actor, manifest(prefix, 'lease-create-valid'), {
              leasePrecondition: first,
            });
            await store.apply(actor, manifest(prefix, 'lease-apply-valid'), {
              leasePrecondition: first,
            });
            const stale = { ...first, epoch: (BigInt(first.epoch) + 1n).toString() };
            await rejectStaleLease(
              () => store.create(actor, manifest(prefix, 'lease-create-stale'), { leasePrecondition: stale }),
              'create',
            );
            await rejectStaleLease(
              () => store.apply(actor, manifest(prefix, 'lease-apply-stale'), { leasePrecondition: stale }),
              'apply',
            );
            let conflictRejected = false;
            try {
              await store.acquireLease(actor, {
                name: leaseName,
                holder: 'controller-b',
                ttlMs: 30_000,
              });
            } catch (error) {
              conflictRejected = error instanceof OrchestrationError &&
                error.code === 'CONFLICT';
            }
            if (!conflictRejected) throw new Error('concurrent lease acquisition succeeded');
            const renewed = await store.renewLease(actor, first, 30_000);
            if (renewed.epoch !== first.epoch) throw new Error('renew changed fencing epoch');
            await store.releaseLease(actor, renewed);
            await rejectStaleLease(
              () => store.create(actor, manifest(prefix, 'lease-create-released'), { leasePrecondition: renewed }),
              'create after release',
            );
            await rejectStaleLease(
              () => store.apply(actor, manifest(prefix, 'lease-apply-released'), { leasePrecondition: renewed }),
              'apply after release',
            );
            const second = await store.acquireLease(actor, {
              name: leaseName,
              holder: 'controller-b',
              ttlMs: 30_000,
            });
            if (BigInt(second.epoch) <= BigInt(first.epoch)) {
              throw new Error('lease fencing epoch did not advance');
            }
            await rejectStaleLease(
              () => store.create(actor, manifest(prefix, 'lease-create-taken-over'), { leasePrecondition: renewed }),
              'create after takeover',
            );
            await rejectStaleLease(
              () => store.apply(actor, manifest(prefix, 'lease-apply-taken-over'), { leasePrecondition: renewed }),
              'apply after takeover',
            );
            await store.releaseLease(actor, second);
            const ttlMs = 5;
            const expiring = await store.acquireLease(actor, {
              name: leaseName,
              holder: 'controller-c',
              ttlMs,
            });
            if (factory.advanceLeaseClock) {
              await factory.advanceLeaseClock(ttlMs + 1);
            } else {
              await new Promise<void>((resolve) => setTimeout(resolve, ttlMs + 20));
            }
            await rejectStaleLease(
              () => store.create(actor, manifest(prefix, 'lease-create-expired'), { leasePrecondition: expiring }),
              'create after expiry',
            );
            await rejectStaleLease(
              () => store.apply(actor, manifest(prefix, 'lease-apply-expired'), { leasePrecondition: expiring }),
              'apply after expiry',
            );
            const takeover = await store.acquireLease(actor, {
              name: leaseName,
              holder: 'controller-d',
              ttlMs: 30_000,
            });
            await rejectStaleLease(
              () => store.create(actor, manifest(prefix, 'lease-create-expiry-takeover'), { leasePrecondition: expiring }),
              'create after expiry takeover',
            );
            await rejectStaleLease(
              () => store.apply(actor, manifest(prefix, 'lease-apply-expiry-takeover'), { leasePrecondition: expiring }),
              'apply after expiry takeover',
            );
            await store.create(actor, manifest(prefix, 'lease-create-takeover-valid'), {
              leasePrecondition: takeover,
            });
            await store.apply(actor, manifest(prefix, 'lease-apply-takeover-valid'), {
              leasePrecondition: takeover,
            });
            let staleRejected = false;
            try {
              await store.renewLease(actor, first, 30_000);
            } catch (error) {
              staleRejected = error instanceof OrchestrationError &&
                error.code === 'STALE_EPOCH';
            }
            if (!staleRejected) throw new Error('stale lease identity was accepted');
          });
        },
      },
      {
        name: 'honors finalizers, compaction, health, and snapshot',
        description: 'Cleanup remains visible until finalized and maintenance reports a durable point',
        run: async () => {
          await withStore(factory, async (store) => {
            const desired = manifest(
              prefix,
              'maintenance',
              1,
              ['conformance.memeloop.io/cleanup'],
            );
            const reference = referenceFor(desired);
            await store.create(actor, desired);
            await store.delete(actor, reference);
            const pending = await store.get(reference);
            if (!pending?.metadata.deletionTimestamp) {
              throw new Error('finalizing resource disappeared before cleanup');
            }
            const cleared = await store.apply(
              actor,
              {
                ...desired,
                metadata: { ...desired.metadata, finalizers: [] },
              },
              { resourceVersion: pending.metadata.resourceVersion },
            );
            await store.delete(actor, reference, {
              preconditions: {
                resourceVersion: cleared.metadata.resourceVersion,
              },
            });
            if (await store.get(reference)) throw new Error('finalized resource remained current');
            const health = await store.getHealth();
            if (!health.healthy) throw new Error('ControlStore reported unhealthy');
            const snapshot = await store.snapshot(
              await factory.snapshotTarget('maintenance'),
            );
            if (!snapshot.resourceVersion) throw new Error('snapshot omitted resourceVersion');
            const compacted = await store.compact(snapshot.resourceVersion);
            if (compacted.compactedThrough !== snapshot.resourceVersion) {
              throw new Error('compaction did not reach the snapshot point');
            }
          });
        },
      },
    ],
  };
}

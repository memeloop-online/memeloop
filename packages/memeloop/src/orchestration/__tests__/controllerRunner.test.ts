import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource, OrchestrationWatchEvent } from '../client.js';
import { type Controller, type ControllerReconcileResult, createControllerRunner } from '../controllerRunner.js';
import type { ControlLeaseGrant, ControlStore } from '../controlStore.js';

function makeResource(name: string, resourceVersion = '1'): OrchestrationResource {
  return {
    apiVersion: 'memeloop/v1',
    kind: 'TestResource',
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion,
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: { value: 42 },
  };
}

function makeLease(name: string, holder: string, epoch = '1'): ControlLeaseGrant {
  return {
    name,
    holder,
    leaseId: `lease-${holder}`,
    epoch,
    acquiredAt: '2026-07-18T00:00:00.000Z',
    renewedAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:10.000Z',
    resourceVersion: '1',
  };
}

function added(resource: OrchestrationResource): OrchestrationWatchEvent {
  return { type: 'ADDED', resource, resourceVersion: resource.metadata.resourceVersion };
}

interface PushableControlStore extends ControlStore {
  __pushEvent(event: OrchestrationWatchEvent): void;
}

interface FakeStoreOptions {
  get?: () => Promise<OrchestrationResource | null>;
}

function makeFakeStore(overrides?: FakeStoreOptions): PushableControlStore {
  const events: OrchestrationWatchEvent[] = [];
  let resolveWatch: ((value: OrchestrationWatchEvent) => void) | null = null;

  return {
    acquireLease: vi.fn(async (_actor, request) => makeLease(request.name, request.holder)),
    renewLease: vi.fn(async (_actor, identity, _ttl) => ({ ...makeLease(identity.name, identity.holder), epoch: identity.epoch })),
    releaseLease: vi.fn(async () => undefined),
    watch: vi.fn((_query) => {
      let done = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (done) return { done: true as const, value: undefined };
              if (events.length > 0) {
                return { done: false as const, value: events.shift()! };
              }
              const event = await new Promise<OrchestrationWatchEvent>((resolve) => {
                resolveWatch = resolve;
              });
              return { done: false as const, value: event };
            },
            async return() {
              done = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    }),
    updateStatus: vi.fn(async (_actor, reference, status, _options) => ({
      ...makeResource(reference.name ?? ''),
      status: status as Record<string, unknown>,
    })),
    get: vi.fn(async () => overrides?.get?.() ?? null),
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async (_actor, manifest) => ({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        name: manifest.metadata.name ?? '',
        uid: 'u',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '2026-07-18T00:00:00.000Z',
      },
    } as OrchestrationResource)),
    delete: vi.fn(async () => ({ deleted: true })),
    compact: vi.fn(async () => ({ compactedThrough: '0', resourceVersion: '0' })),
    snapshot: vi.fn(async () => ({ resourceVersion: '0', createdAt: '2026-07-18T00:00:00.000Z' })),
    getHealth: vi.fn(async () => ({ healthy: true, resourceVersion: '0' })),
    close: vi.fn(async () => undefined),
    __pushEvent(event: OrchestrationWatchEvent) {
      if (resolveWatch) {
        resolveWatch(event);
        resolveWatch = null;
      } else {
        events.push(event);
      }
    },
  } as unknown as ControlStore & { __pushEvent(event: OrchestrationWatchEvent): void };
}

describe('createControllerRunner', () => {
  it('acquires lease, reconciles watched resources, and updates status', async () => {
    const store = makeFakeStore();
    const controller: Controller = {
      reconcile: vi.fn(async () => ({
        status: { actorReportedStatus: { phase: 'Ready' } },
        ready: true,
      } satisfies ControllerReconcileResult)),
    };

    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
    });
    expect(store.watch).toHaveBeenCalledWith(
      { kind: 'TestResource' },
      { sendInitialEvents: true },
    );

    store.__pushEvent(added(makeResource('item-1')));

    await vi.waitFor(() => {
      expect(controller.reconcile).toHaveBeenCalledOnce();
    });
    expect(controller.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({ metadata: expect.objectContaining({ name: 'item-1' }) }),
        actor: { id: 'controller/test', kind: 'controller' },
        leaseEpoch: '1',
      }),
    );

    await vi.waitFor(() => {
      expect(store.updateStatus).toHaveBeenCalledOnce();
    });
    expect(store.updateStatus).toHaveBeenCalledWith(
      { id: 'controller/test', kind: 'controller' },
      expect.objectContaining({ name: 'item-1', kind: 'TestResource' }),
      { actorReportedStatus: { phase: 'Ready' } },
      { resourceVersion: '1' },
    );

    await runner.stop();
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it('retries reconcile with backoff on failure', async () => {
    const store = makeFakeStore({
      get: vi.fn(async () => makeResource('item-1')),
    });
    let callCount = 0;
    const controller: Controller = {
      reconcile: vi.fn(async () => {
        callCount += 1;
        if (callCount < 3) throw new Error(`fail-${callCount}`);
        return { ready: true };
      }),
    };

    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 50,
    });

    store.__pushEvent(added(makeResource('item-1')));

    await vi.waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(3);
    }, { timeout: 2000 });
    expect(controller.reconcile).toHaveBeenCalledTimes(3);

    await runner.stop();
  });

  it('does not reconcile a stale snapshot after the resource was deleted', async () => {
    const store = makeFakeStore({
      get: vi.fn(async () => null),
    });
    const controller: Controller = {
      reconcile: vi.fn(async () => {
        throw new Error('status write raced deletion');
      }),
    };
    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
      retryBaseDelayMs: 10,
    });

    store.__pushEvent(added(makeResource('deleted-item')));
    await vi.waitFor(() => {
      expect(controller.reconcile).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(store.get).toHaveBeenCalled();
    expect(controller.reconcile).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('does not reconcile a stale snapshot while the authoritative read is unavailable', async () => {
    const current = makeResource('item-1', '2');
    let rejectUnavailableRead!: (error: Error) => void;
    const unavailableRead = new Promise<OrchestrationResource | null>((_resolve, reject) => {
      rejectUnavailableRead = reject;
    });
    const get = vi.fn()
      .mockReturnValueOnce(unavailableRead)
      .mockResolvedValue(current);
    const store = makeFakeStore({ get });
    let calls = 0;
    const controller: Controller = {
      reconcile: vi.fn(async ({ resource }) => {
        calls += 1;
        if (calls === 1) throw new Error('first reconcile failed');
        expect(resource.metadata.resourceVersion).toBe('2');
        return { ready: true };
      }),
    };
    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
      retryBaseDelayMs: 20,
      retryMaxDelayMs: 20,
    });

    store.__pushEvent(added(makeResource('item-1', '1')));
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledOnce();
    });
    expect(controller.reconcile).toHaveBeenCalledOnce();
    rejectUnavailableRead(new Error('store temporarily unavailable'));

    await vi.waitFor(() => {
      expect(controller.reconcile).toHaveBeenCalledTimes(2);
    });
    expect(get).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it('releases lease on stop and does not reconcile after stop', async () => {
    const store = makeFakeStore();
    const controller: Controller = {
      reconcile: vi.fn(async () => ({ ready: true })),
    };

    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
    });

    await runner.stop();

    expect(store.releaseLease).toHaveBeenCalledOnce();

    store.__pushEvent(added(makeResource('item-1')));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.reconcile).not.toHaveBeenCalled();
  });

  it('passes lease epoch to reconcile for fencing', async () => {
    const store = makeFakeStore();
    const controller: Controller = {
      reconcile: vi.fn(async () => ({ ready: true })),
    };

    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
    });

    store.__pushEvent(added(makeResource('item-1')));

    await vi.waitFor(() => {
      expect(controller.reconcile).toHaveBeenCalledOnce();
    });
    const call = (controller.reconcile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.leaseEpoch).toBe('1');

    await runner.stop();
  });

  it('skips resources that do not match resourceFilter', async () => {
    const store = makeFakeStore();
    const controller: Controller = {
      reconcile: vi.fn(async () => ({ ready: true })),
    };

    const runner = await createControllerRunner(store, controller, {
      actor: { id: 'controller/test', kind: 'controller' },
      leaseName: 'test-controller',
      watchKind: 'TestResource',
      leaseTtlMs: 10_000,
      resourceFilter: (resource) => resource.metadata.name === 'wanted',
    });

    store.__pushEvent(added(makeResource('unwanted')));
    store.__pushEvent(added(makeResource('wanted')));

    await vi.waitFor(() => {
      expect(controller.reconcile).toHaveBeenCalledOnce();
    });
    expect(controller.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({ metadata: expect.objectContaining({ name: 'wanted' }) }),
      }),
    );

    await runner.stop();
  });
});

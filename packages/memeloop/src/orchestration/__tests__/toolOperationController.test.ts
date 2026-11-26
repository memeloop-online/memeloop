import { describe, expect, it, vi } from 'vitest';

import type { ControllerReconcileRequest } from '../controllerRunner.js';
import type { ToolExecutionDriver } from '../drivers/toolExecutionDriver.js';
import { type ToolExecutorResource, type ToolOperationResource, type ToolOperationStatus } from '../resources.js';
import { createToolOperationBindingController, createToolOperationExecutionController, selectToolExecutor } from '../toolOperationController.js';

function operation(
  overrides: Partial<ToolOperationResource['spec']> = {},
  status?: ToolOperationStatus,
): ToolOperationResource {
  return {
    apiVersion: 'execution.memeloop.io/v1alpha1',
    kind: 'ToolOperation',
    metadata: {
      name: 'operation-1',
      namespace: 'default',
      uid: 'operation-uid',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-26T08:00:00.000Z',
    },
    spec: {
      toolRef: {
        kind: 'ToolClass',
        name: 'filesystem',
        schemaDigest: 'sha256:schema-v1',
      },
      effect: 'update',
      ...overrides,
    },
    status,
  };
}

function executor(
  name: string,
  overrides: Partial<ToolExecutorResource['spec']> = {},
  healthy = true,
): ToolExecutorResource {
  return {
    apiVersion: 'tool.memeloop.io/v1alpha1',
    kind: 'ToolExecutor',
    metadata: {
      name,
      namespace: 'default',
      uid: `${name}-uid`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-26T08:00:00.000Z',
    },
    spec: {
      nodeId: name,
      trust: 'restricted',
      selectors: { site: 'local' },
      capabilities: [{
        toolClassRef: {
          apiVersion: 'tool.memeloop.io/v1alpha1',
          kind: 'ToolClass',
          name: 'filesystem',
        },
        schemaDigest: 'sha256:schema-v1',
        effects: ['update'],
        endpoint: `local://${name}/filesystem`,
        capacity: { maxConcurrent: 4, queueDepth: 1 },
        health: { healthy: true },
      }],
      ...overrides,
    },
    status: { healthy },
  };
}

function request(
  resource: ToolOperationResource,
  leaseEpoch = '7',
): ControllerReconcileRequest<ToolOperationResource['spec']> {
  return {
    resource,
    actor: { id: 'controller/tool', kind: 'controller' },
    leaseEpoch,
    now: new Date('2026-07-23T08:00:00.000Z'),
  };
}

describe('selectToolExecutor', () => {
  it('filters health, schema, node selector, trust, and capacity before scoring', () => {
    const selected = selectToolExecutor(
      operation({
        placement: {
          preferredNode: 'preferred',
          nodeSelector: { site: 'local' },
          minimumTrust: 'restricted',
        },
      }),
      [
        executor('wrong-schema', {
          capabilities: [{
            toolClassRef: {
              apiVersion: 'tool.memeloop.io/v1alpha1',
              kind: 'ToolClass',
              name: 'filesystem',
            },
            schemaDigest: 'sha256:other',
            endpoint: 'local://wrong',
          }],
        }),
        executor('unhealthy', {}, false),
        executor('full', {
          capabilities: [{
            toolClassRef: {
              apiVersion: 'tool.memeloop.io/v1alpha1',
              kind: 'ToolClass',
              name: 'filesystem',
            },
            schemaDigest: 'sha256:schema-v1',
            endpoint: 'local://full',
            capacity: { maxConcurrent: 1, queueDepth: 1 },
          }],
        }),
        executor('preferred'),
      ],
    );

    expect(selected?.nodeId).toBe('preferred');
    expect(selected?.reasons).toContain('preferred node');
  });

  it('returns null when a required node has no compatible executor', () => {
    expect(selectToolExecutor(
      operation({ placement: { requiredNode: 'missing' } }),
      [executor('node-a')],
    )).toBeNull();
  });

  it('rejects an executor when the caller understates the declared tool effect', () => {
    expect(
      selectToolExecutor(operation({ effect: 'read' }), [executor('node-a')]),
    ).toBeNull();
  });
});

describe('createToolOperationBindingController', () => {
  it('binds a pending operation to an independently selected executor', async () => {
    const controller = createToolOperationBindingController({
      actor: { id: 'controller/tool-binding', kind: 'controller' },
      listExecutors: async () => [executor('node-a')],
    });

    const result = await controller.reconcile(request(operation()));

    expect(result.status).toMatchObject({
      phase: 'Pending',
      assignedNode: 'node-a',
      assignedDriver: 'node-a',
      assignedExecutor: {
        kind: 'ToolExecutor',
        name: 'node-a',
        uid: 'node-a-uid',
      },
    });
    expect((result.status as ToolOperationStatus).conditions?.at(-1)).toMatchObject({
      type: 'Scheduled',
      status: 'True',
    });
  });

  it('keeps an unschedulable operation pending for changing capacity', async () => {
    const controller = createToolOperationBindingController({
      actor: { id: 'controller/tool-binding', kind: 'controller' },
      listExecutors: async () => [],
      retryAfterMs: 250,
    });

    const result = await controller.reconcile(request(operation()));

    expect(result).toMatchObject({ ready: false, requeueAfterMs: 250 });
    expect(result.status).toMatchObject({ phase: 'Pending' });
    expect((result.status as ToolOperationStatus).conditions?.at(-1)?.reason)
      .toBe('NoSuitableExecutor');
  });

  it('does not race explicitly external operations', async () => {
    const listExecutors = vi.fn(async () => [executor('node-a')]);
    const controller = createToolOperationBindingController({
      actor: { id: 'controller/tool-binding', kind: 'controller' },
      listExecutors,
    });

    expect(
      await controller.reconcile(request(
        operation({ placement: { orchestrator: 'k8s' } }),
      )),
    ).toEqual({ ready: true });
    expect(listExecutors).not.toHaveBeenCalled();
  });
});

describe('createToolOperationExecutionController', () => {
  function driver(): ToolExecutionDriver & { execute: ReturnType<typeof vi.fn> } {
    return {
      execute: vi.fn(async (resource: ToolOperationResource) => ({
        ...resource,
        status: {
          ...resource.status,
          phase: 'Completed' as const,
          result: { value: 'done' },
          attempts: (resource.status?.attempts ?? 0) + 1,
          completedAt: '2026-07-23T08:00:01.000Z',
        },
      })),
    };
  }

  it('persists a fenced Running claim before invoking the effect', async () => {
    const toolDriver = driver();
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const result = await controller.reconcile(request(operation({}, {
      phase: 'Pending',
      assignedNode: 'node-a',
      assignedDriver: 'executor-a',
    })));

    expect(result.status).toMatchObject({
      phase: 'Running',
      executionClaim: {
        leaseEpoch: '7',
        claimedAt: '2026-07-23T08:00:00.000Z',
      },
    });
    expect(toolDriver.execute).not.toHaveBeenCalled();
  });

  it('executes only after observing its durable claim at the same epoch', async () => {
    const toolDriver = driver();
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const result = await controller.reconcile(request(operation({}, {
      phase: 'Running',
      assignedNode: 'node-a',
      assignedDriver: 'executor-a',
      assignedExecutor: {
        apiVersion: 'tool.memeloop.io/v1alpha1',
        kind: 'ToolExecutor',
        name: 'executor-a',
      },
      executionClaim: {
        leaseEpoch: '7',
        claimedAt: '2026-07-23T07:59:59.000Z',
      },
    })));

    expect(toolDriver.execute).toHaveBeenCalledOnce();
    expect(result.status).toMatchObject({
      phase: 'Completed',
      result: { value: 'done' },
      assignedNode: 'node-a',
      assignedDriver: 'executor-a',
    });
  });

  it('retries a read after failover without repeating a potentially destructive effect', async () => {
    const toolDriver = driver();
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const result = await controller.reconcile(request(
      operation({ effect: 'read' }, {
        phase: 'Running',
        assignedNode: 'node-a',
        executionClaim: {
          leaseEpoch: '6',
          claimedAt: '2026-07-23T07:59:59.000Z',
        },
      }),
      '7',
    ));

    expect(result.status).toMatchObject({ phase: 'Pending' });
    expect((result.status as ToolOperationStatus).executionClaim).toBeUndefined();
    expect(toolDriver.execute).not.toHaveBeenCalled();
  });

  it('fails a destructive unknown effect for verification after epoch change', async () => {
    const toolDriver = driver();
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const result = await controller.reconcile(request(
      operation({ effect: 'delete' }, {
        phase: 'Running',
        assignedNode: 'node-a',
        executionClaim: {
          leaseEpoch: '6',
          claimedAt: '2026-07-23T07:59:59.000Z',
        },
      }),
      '7',
    ));

    expect(result.status).toMatchObject({
      phase: 'Failed',
      result: { error: { code: 'UNKNOWN_EFFECT', retryable: false } },
    });
    expect((result.status as ToolOperationStatus).conditions?.at(-1)).toMatchObject({
      type: 'EffectUnknown',
      reason: 'verification-required',
    });
    expect(toolDriver.execute).not.toHaveBeenCalled();
  });

  it('ignores operations assigned to another node', async () => {
    const toolDriver = driver();
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });

    expect(
      await controller.reconcile(request(operation({}, {
        phase: 'Pending',
        assignedNode: 'node-b',
      }))),
    ).toEqual({ ready: true });
    expect(toolDriver.execute).not.toHaveBeenCalled();
  });

  it('bounds an uncooperative read with timeout and returns TIMEOUT', async () => {
    const toolDriver: ToolExecutionDriver = {
      execute: vi.fn(async () => await new Promise<ToolOperationResource>(() => {})),
    };
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const pending = controller.reconcile(request(operation({ effect: 'read', timeoutMs: 10 }, {
      phase: 'Running',
      assignedNode: 'node-a',
      executionClaim: {
        leaseEpoch: '7',
        claimedAt: '2026-07-23T07:59:59.000Z',
      },
    })));

    await expect(pending).resolves.toMatchObject({
      status: {
        phase: 'Failed',
        result: { error: { code: 'TIMEOUT', retryable: true } },
      },
      ready: true,
    });
    expect(controller.activeCount()).toBe(0);
  });

  it('marks a timed-out destructive effect unknown instead of claiming cancellation', async () => {
    const toolDriver: ToolExecutionDriver = {
      execute: vi.fn(async () => await new Promise<ToolOperationResource>(() => {})),
    };
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const result = await controller.reconcile(request(operation({ effect: 'update', timeoutMs: 10 }, {
      phase: 'Running',
      assignedNode: 'node-a',
      executionClaim: {
        leaseEpoch: '7',
        claimedAt: '2026-07-23T07:59:59.000Z',
      },
    })));

    expect(result.status).toMatchObject({
      phase: 'Failed',
      result: { error: { code: 'UNKNOWN_EFFECT' } },
    });
    expect((result.status as ToolOperationStatus).conditions?.at(-1)?.reason)
      .toBe('verification-required');
  });

  it('actively cancels a claimed read through the execution handle', async () => {
    const observedSignal = vi.fn();
    const toolDriver: ToolExecutionDriver = {
      execute: vi.fn(async (_operation, options) => {
        observedSignal(options?.signal);
        return await new Promise<ToolOperationResource>(() => {});
      }),
    };
    const controller = createToolOperationExecutionController({
      actor: { id: 'controller/tool-node-a', kind: 'controller' },
      nodeId: 'node-a',
      driver: toolDriver,
    });
    const resource = operation({ effect: 'read' }, {
      phase: 'Running',
      assignedNode: 'node-a',
      executionClaim: {
        leaseEpoch: '7',
        claimedAt: '2026-07-23T07:59:59.000Z',
      },
    });
    const pending = controller.reconcile(request(resource));
    await vi.waitFor(() => {
      expect(observedSignal).toHaveBeenCalled();
    });

    expect(controller.cancel(resource)).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: {
        phase: 'Cancelled',
        result: { error: { code: 'CANCELLED' } },
      },
    });
    expect(controller.activeCount()).toBe(0);
  });
});

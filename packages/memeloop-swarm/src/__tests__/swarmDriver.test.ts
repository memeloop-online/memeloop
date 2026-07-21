import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrchestrationError } from 'memeloop';
import type { AgentWorkloadResource, ControlStoreActor, ToolOperationResource } from 'memeloop';

import { ANNOTATION_RUNTIME_COMMAND, ANNOTATION_RUNTIME_ENV, ANNOTATION_RUNTIME_IMAGE } from '../labels.js';
import { SwarmOrchestrationDriver } from '../swarmDriver.js';
import { createFakeEngineServer } from './fakeEngineServer.js';
import type { FakeEngineServer } from './fakeEngineServer.js';

const actor: ControlStoreActor = { id: 'controller/test', kind: 'controller' };

/** ES2022-compatible `Array.prototype.findLast`. */
function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

function makeWorkload(name: string, overrides: Partial<AgentWorkloadResource['spec']> = {}): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name,
      namespace: 'agents',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-21T00:00:00.000Z',
      annotations: {
        [ANNOTATION_RUNTIME_IMAGE]: 'memeloop/loop-runtime:1.0.0',
        [ANNOTATION_RUNTIME_COMMAND]: JSON.stringify(['node', 'loop.mjs']),
        [ANNOTATION_RUNTIME_ENV]: JSON.stringify({ MEMELOOP_PROFILE: 'default' }),
      },
    },
    spec: {
      profileId: 'default',
      trust: 'restricted',
      completionPolicy: 'daemon',
      placement: {
        nodeSelector: { 'memeloop.io/role': 'worker' },
        requiredNode: 'node-a',
      },
      ...overrides,
    },
  };
}

function makeToolOperation(name: string, idempotencyKey?: string): ToolOperationResource {
  return {
    apiVersion: 'execution.memeloop.io/v1alpha1',
    kind: 'ToolOperation',
    metadata: {
      name,
      namespace: 'agents',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-21T00:00:00.000Z',
      annotations: { [ANNOTATION_RUNTIME_IMAGE]: 'memeloop/tool-exec:1.0.0' },
    },
    spec: {
      toolRef: { kind: 'Tool', name: 'fs.read' },
      arguments: { path: '/etc/hostname' },
      effect: 'read',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

describe('SwarmOrchestrationDriver', () => {
  let engine: FakeEngineServer;
  let driver: SwarmOrchestrationDriver;

  beforeAll(async () => {
    engine = await createFakeEngineServer();
    driver = new SwarmOrchestrationDriver({ baseUrl: engine.url });
  });

  afterAll(async () => {
    await engine.close();
  });

  it('reports capabilities from /info and /version with honest isolation claims', async () => {
    const caps = await driver.getCapabilities();
    expect(caps.name).toBe('memeloop-swarm');
    expect(caps.version).toContain('26.1.4');
    expect(caps.manages).toEqual(['AgentWorkload', 'ToolOperation']);
    expect(caps.supportsColocation).toBe(true);
  });

  it('reports healthy on /_ping', async () => {
    const health = await driver.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.detail).toBe('OK');
  });

  it('reports unhealthy instead of throwing when the engine fails', async () => {
    engine.failNext(500, 'engine on fire', '/_ping');
    const health = await driver.getHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('UNAVAILABLE');
  });

  it('places a workload with labels and explicit co-location constraints', async () => {
    const placement = await driver.placeWorkload(makeWorkload('loop-1'), actor);
    expect(placement.externalId).toBe('ml-wl-loop-1-uid-loop');
    expect(placement.nodeName).toBe('node-1');
    expect(placement.providerMetadata?.['swarm.service.id']).toMatch(/^svc-/);

    const create = findLast(engine.requests, (r) => r.method === 'POST' && r.path === '/services/create');
    expect(create).toBeDefined();
    const spec = create!.body;
    expect(spec.Name).toBe(placement.externalId);
    expect(spec.Labels['io.memeloop.managed-by']).toBe('memeloop');
    expect(spec.Labels['io.memeloop.resource-kind']).toBe('AgentWorkload');
    expect(spec.Labels['io.memeloop.workload.uid']).toBe('uid-loop-1');
    expect(spec.Labels['io.memeloop.workload.name']).toBe('loop-1');
    expect(spec.Labels['io.memeloop.workload.namespace']).toBe('agents');
    // Runtime mapping from annotations.
    expect(spec.TaskTemplate.ContainerSpec.Image).toBe('memeloop/loop-runtime:1.0.0');
    expect(spec.TaskTemplate.ContainerSpec.Command).toEqual(['node', 'loop.mjs']);
    expect(spec.TaskTemplate.ContainerSpec.Env).toContain('MEMELOOP_PROFILE=default');
    // Co-location is explicit: nodeSelector + requiredNode become constraints.
    expect(spec.TaskTemplate.Placement.Constraints).toContain('node.labels.memeloop.io/role==worker');
    expect(spec.TaskTemplate.Placement.Constraints).toContain('node.hostname==node-a');
    // Daemon completion policy → replicated service, restart any.
    expect(spec.Mode.Replicated).toEqual({ Replicas: 1 });
    expect(spec.TaskTemplate.RestartPolicy.Condition).toBe('any');
  });

  it('maps completionPolicy=complete to a replicated job with no restarts', async () => {
    await driver.placeWorkload(makeWorkload('batch-1', { completionPolicy: 'complete' }), actor);
    const create = findLast(engine.requests, (r) => r.method === 'POST' && r.path === '/services/create');
    expect(create!.body.Mode.ReplicatedJob).toEqual({ MaxConcurrent: 1, TotalCompletions: 1 });
    expect(create!.body.TaskTemplate.RestartPolicy.Condition).toBe('none');
  });

  it('rejects anti-affinity placement instead of silently dropping it', async () => {
    await expect(
      driver.placeWorkload(makeWorkload('aa-1', { placement: { antiAffinity: ['other-workload'] } }), actor),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('runs the workload place→status→stop lifecycle', async () => {
    const placement = await driver.placeWorkload(makeWorkload('life-1'), actor);

    const running = await driver.getWorkloadStatus(placement.externalId);
    expect(running.phase).toBe('Running');

    const serviceId = placement.providerMetadata!['swarm.service.id'];
    engine.setTaskState(serviceId, 'failed', 'container exited 1');
    const failed = await driver.getWorkloadStatus(placement.externalId);
    expect(failed.phase).toBe('Failed');
    expect(failed.message).toContain('container exited 1');

    await driver.stopWorkload(placement.externalId, actor);
    expect(engine.requests.some((r) => r.method === 'DELETE' && r.path === `/services/${placement.externalId}`)).toBe(true);

    await expect(driver.getWorkloadStatus(placement.externalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('executes a tool operation as a one-shot job and tracks it to success', async () => {
    const placement = await driver.executeToolOperation(makeToolOperation('op-1'), actor);
    expect(placement.externalId).toBe('ml-op-op-1-uid-op-1');

    const create = findLast(engine.requests, (r) => r.method === 'POST' && r.path === '/services/create');
    const spec = create!.body;
    expect(spec.Mode.ReplicatedJob).toEqual({ MaxConcurrent: 1, TotalCompletions: 1 });
    expect(spec.TaskTemplate.RestartPolicy).toEqual({ Condition: 'none' });
    expect(spec.Labels['io.memeloop.resource-kind']).toBe('ToolOperation');
    expect(spec.Labels['io.memeloop.operation.uid']).toBe('uid-op-1');
    const env = spec.TaskTemplate.ContainerSpec.Env as string[];
    const payload = env.find((entry) => entry.startsWith('MEMELOOP_TOOL_OPERATION='));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!.slice('MEMELOOP_TOOL_OPERATION='.length))).toMatchObject({
      toolRef: { kind: 'Tool', name: 'fs.read' },
      effect: 'read',
    });

    const serviceId = placement.providerMetadata!['swarm.service.id'];
    engine.setTaskState(serviceId, 'complete');
    const status = await driver.getToolOperationStatus(placement.externalId);
    expect(status.phase).toBe('Succeeded');

    await driver.cancelToolOperation(placement.externalId, actor);
    await expect(driver.getToolOperationStatus(placement.externalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adopts an existing service for a repeated idempotency key', async () => {
    const operation = makeToolOperation('op-idem', 'key-123');
    const first = await driver.executeToolOperation(operation, actor);
    expect(first.providerMetadata?.['memeloop.adopted']).toBeUndefined();

    const createsBefore = engine.requests.filter((r) => r.method === 'POST' && r.path === '/services/create').length;
    const second = await driver.executeToolOperation(operation, actor);
    const createsAfter = engine.requests.filter((r) => r.method === 'POST' && r.path === '/services/create').length;

    expect(second.externalId).toBe(first.externalId);
    expect(second.providerMetadata?.['memeloop.adopted']).toBe('true');
    expect(createsAfter).toBe(createsBefore);
    // The lookup used the idempotency-key label filter.
    const lookup = findLast(engine.requests, (r) => r.method === 'GET' && r.path === '/services');
    expect(decodeURIComponent(lookup!.query.get('filters') ?? '')).toContain('io.memeloop.operation.idempotency-key=key-123');
  });

  it('fails with INVALID when a tool operation has no runtime image', async () => {
    const bare = makeToolOperation('op-noimg');
    delete bare.metadata.annotations;
    await expect(driver.executeToolOperation(bare, actor)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('lists workloads and tool operations with label filters', async () => {
    await driver.placeWorkload(makeWorkload('list-1'), actor);
    await driver.executeToolOperation(makeToolOperation('list-op'), actor);

    const workloads = await driver.listWorkloads();
    expect(workloads.map((w) => w.externalId)).toContain('ml-wl-list-1-uid-list');
    expect(workloads.every((w) => !w.externalId.startsWith('ml-op-'))).toBe(true);

    const operations = await driver.listToolOperations();
    expect(operations.map((o) => o.externalId)).toContain('ml-op-list-op-uid-list');
    expect(operations.every((o) => !o.externalId.startsWith('ml-wl-'))).toBe(true);

    const listRequest = findLast(engine.requests, (r) => r.method === 'GET' && r.path === '/services');
    const filters = decodeURIComponent(listRequest!.query.get('filters') ?? '');
    expect(filters).toContain('io.memeloop.managed-by=memeloop');
    expect(filters).toContain('io.memeloop.resource-kind=ToolOperation');
  });

  it('maps engine error statuses to structured OrchestrationError codes', async () => {
    await expect(driver.getWorkloadStatus('ml-wl-missing-xxxxxxxx')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
    });

    // Duplicate service name → 409 CONFLICT.
    await driver.placeWorkload(makeWorkload('dup-1'), actor);
    await expect(driver.placeWorkload(makeWorkload('dup-1'), actor)).rejects.toMatchObject({
      code: 'CONFLICT',
      retryable: false,
    });

    // Injected 500 → retryable UNAVAILABLE.
    engine.failNext(500, 'boom', '/services/create');
    await expect(driver.placeWorkload(makeWorkload('err-500'), actor)).rejects.toSatisfy(
      (error: unknown) => error instanceof OrchestrationError && error.code === 'UNAVAILABLE' && error.retryable,
    );
  });

  it('cancels in-flight requests via AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      driver.placeWorkload(makeWorkload('abort-1'), actor, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
  });
});

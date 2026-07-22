import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentWorkloadResource, ControlStoreActor, ToolOperationResource } from 'memeloop';

import { KubernetesOrchestrationDriver } from '../k8sDriver.js';
import {
  ANNOTATION_RUNTIME_IMAGE,
  ENV_TOOL_OPERATION,
  ENV_WORKLOAD,
  LABEL_IDEMPOTENCY_KEY,
  LABEL_MANAGED_BY,
  LABEL_RESOURCE_KIND,
  LABEL_WORKLOAD_UID,
  MANAGED_BY_VALUE,
  workloadObjectName,
} from '../labels.js';
import { createFakeKubernetesServer, type FakeKubernetesServer } from './fakeKubernetesServer.js';

const actor: ControlStoreActor = { id: 'controller/test', kind: 'controller' };
const NAMESPACE = 'agents-ns';

function makeWorkload(name: string, completionPolicy: 'daemon' | 'complete' = 'daemon'): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name,
      namespace: 'agents',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-23T00:00:00.000Z',
      annotations: { [ANNOTATION_RUNTIME_IMAGE]: 'memeloop/loop-runtime:1.0.0' },
    },
    spec: {
      profileId: 'default',
      trust: 'restricted',
      completionPolicy,
      placement: { requiredNode: 'node-a' },
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
      creationTimestamp: '2026-07-23T00:00:00.000Z',
      annotations: { [ANNOTATION_RUNTIME_IMAGE]: 'memeloop/loop-runtime:1.0.0' },
    },
    spec: {
      toolRef: { apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolClass', name: 'fs.read' },
      arguments: { path: '/tmp/x' },
      effect: 'read',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  } as ToolOperationResource;
}

describe('KubernetesOrchestrationDriver (plan 24.62 item 2)', () => {
  let server: FakeKubernetesServer;
  let driver: KubernetesOrchestrationDriver;

  beforeAll(async () => {
    server = await createFakeKubernetesServer(NAMESPACE);
    driver = new KubernetesOrchestrationDriver({
      baseUrl: server.url,
      bearerToken: 'test-token',
      namespace: NAMESPACE,
      defaultToolImage: 'memeloop/loop-runtime:1.0.0',
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('reports capabilities from server discovery and sends the bearer token', async () => {
    const capabilities = await driver.getCapabilities();
    expect(capabilities.name).toBe('memeloop-k8s');
    expect(capabilities.manages).toEqual(['AgentWorkload', 'ToolOperation']);
    const versionRequest = server.requests.find((request) => request.path === '/version');
    expect(versionRequest?.headers.authorization).toBe('Bearer test-token');
  });

  it('places a daemon workload as a Deployment with labels and workload env', async () => {
    const workload = makeWorkload('svc-1', 'daemon');
    const placement = await driver.placeWorkload(workload, actor);

    const expectedName = workloadObjectName('svc-1', 'uid-svc-1');
    expect(placement.externalId).toBe(expectedName);
    expect(placement.providerMetadata?.['k8s.kind']).toBe('Deployment');
    expect(placement.nodeName).toBe('node-a'); // no pods → requiredNode fallback

    const deployment = server.deployments.get(expectedName);
    expect(deployment).toBeDefined();
    expect(deployment!.metadata.labels).toMatchObject({
      [LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
      [LABEL_RESOURCE_KIND]: 'AgentWorkload',
    });
    const container = deployment!.spec.template.spec.containers[0];
    const workloadEnv = container.env.find((entry: { name: string }) => entry.name === ENV_WORKLOAD);
    expect(JSON.parse(workloadEnv.value)).toMatchObject({ name: 'svc-1', profileId: 'default', trust: 'restricted' });
    expect(deployment!.spec.template.spec.restartPolicy).toBe('Always');
  });

  it('places a run-once workload as a Job', async () => {
    const workload = makeWorkload('once-1', 'complete');
    const placement = await driver.placeWorkload(workload, actor);
    expect(placement.providerMetadata?.['k8s.kind']).toBe('Job');
    const job = server.jobs.get(placement.externalId);
    expect(job).toBeDefined();
    expect(job!.spec.template.spec.restartPolicy).toBe('Never');
  });

  it('maps Job conditions to workload phases', async () => {
    const workload = makeWorkload('phases-1', 'complete');
    const placement = await driver.placeWorkload(workload, actor);
    const name = placement.externalId;

    expect((await driver.getWorkloadStatus(name)).phase).toBe('Pending');

    server.setJobStatus(name, { active: 1 });
    expect((await driver.getWorkloadStatus(name)).phase).toBe('Running');

    server.setJobStatus(name, { conditions: [{ type: 'Complete', status: 'True' }] });
    expect((await driver.getWorkloadStatus(name)).phase).toBe('Succeeded');

    const failing = makeWorkload('phases-2', 'complete');
    const failingPlacement = await driver.placeWorkload(failing, actor);
    server.setJobStatus(failingPlacement.externalId, {
      conditions: [{ type: 'Failed', status: 'True', message: 'backoff limit exceeded' }],
    });
    const failed = await driver.getWorkloadStatus(failingPlacement.externalId);
    expect(failed.phase).toBe('Failed');
    expect(failed.message).toBe('backoff limit exceeded');
  });

  it('falls back to Deployments for workload status and maps readiness', async () => {
    const workload = makeWorkload('dep-status', 'daemon');
    const placement = await driver.placeWorkload(workload, actor);

    expect((await driver.getWorkloadStatus(placement.externalId)).phase).toBe('Pending');
    server.setDeploymentStatus(placement.externalId, { readyReplicas: 1 });
    expect((await driver.getWorkloadStatus(placement.externalId)).phase).toBe('Running');
  });

  it('surfaces NOT_FOUND for unknown workloads', async () => {
    await expect(driver.getWorkloadStatus('ml-wl-missing-nouid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(driver.stopWorkload('ml-wl-missing-nouid', actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops workloads by deleting their Job or Deployment', async () => {
    const workload = makeWorkload('stop-1', 'complete');
    const placement = await driver.placeWorkload(workload, actor);
    await driver.stopWorkload(placement.externalId, actor);
    expect(server.jobs.has(placement.externalId)).toBe(false);

    const deleteRequest = server.requests.find((request) => request.method === 'DELETE');
    expect(deleteRequest?.query.get('propagationPolicy')).toBe('Foreground');
  });

  it('rejects tool operations without a runtime image', async () => {
    const noImage = new KubernetesOrchestrationDriver({ baseUrl: server.url, namespace: NAMESPACE });
    const operation = makeToolOperation('no-image');
    // Neither the annotation nor a driver default provides an image.
    operation.metadata.annotations = {};
    await expect(noImage.executeToolOperation(operation, actor)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('executes tool operations as ttl-bounded Jobs and adopts by idempotency key', async () => {
    const operation = makeToolOperation('op-1', 'idem-123');
    const first = await driver.executeToolOperation(operation, actor);
    expect(first.externalId).toMatch(/^ml-op-op-1-/);

    const job = server.jobs.get(first.externalId);
    expect(job!.spec.backoffLimit).toBe(0);
    expect(job!.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(job!.metadata.labels?.[LABEL_IDEMPOTENCY_KEY]).toBe('idem-123');
    const toolEnv = job!.spec.template.spec.containers[0].env.find((entry: { name: string }) => entry.name === ENV_TOOL_OPERATION);
    expect(JSON.parse(toolEnv.value)).toMatchObject({ idempotencyKey: 'idem-123', effect: 'read' });

    // Second call with the same idempotency key adopts the existing Job.
    const postsBefore = server.requests.filter((request) => request.method === 'POST').length;
    const second = await driver.executeToolOperation(makeToolOperation('op-1-duplicate', 'idem-123'), actor);
    expect(second.externalId).toBe(first.externalId);
    expect(second.providerMetadata?.['memeloop.adopted']).toBe('true');
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(postsBefore);
  });

  it('reports and cancels tool operations through their Jobs', async () => {
    const operation = makeToolOperation('op-status');
    const placement = await driver.executeToolOperation(operation, actor);

    server.setJobStatus(placement.externalId, { conditions: [{ type: 'Complete', status: 'True' }] });
    expect((await driver.getToolOperationStatus(placement.externalId)).phase).toBe('Succeeded');

    await driver.cancelToolOperation(placement.externalId, actor);
    expect(server.jobs.has(placement.externalId)).toBe(false);
    await expect(driver.getToolOperationStatus(placement.externalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists only memeloop-managed objects by label selector', async () => {
    server.requests.length = 0;
    await driver.listWorkloads();
    await driver.listToolOperations();
    const lists = server.requests.filter((request) => request.method === 'GET' && request.query.get('labelSelector'));
    expect(lists.length).toBeGreaterThanOrEqual(3); // Jobs + Deployments + tool Jobs
    for (const list of lists) {
      expect(list.query.get('labelSelector')).toContain(`${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE}`);
    }
    const workloadLists = lists.filter((request) => request.query.get('labelSelector')?.includes(`${LABEL_RESOURCE_KIND}=AgentWorkload`));
    expect(workloadLists.length).toBeGreaterThanOrEqual(2); // Jobs and Deployments
  });

  it('resolves pod nodes through label selectors', async () => {
    const workload = makeWorkload('pod-node', 'complete');
    server.pods.push({
      metadata: {
        name: 'pod-1',
        namespace: NAMESPACE,
        labels: { [LABEL_WORKLOAD_UID]: 'uid-pod-node' },
      },
      spec: { nodeName: 'node-z' },
    });
    const placement = await driver.placeWorkload(workload, actor);
    expect(placement.nodeName).toBe('node-z');
  });

  it('reports health without throwing and maps API failures to driver errors', async () => {
    const health = await driver.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('v1.30.0-fake');

    server.failNext(500, 'InternalError', 'boom', '/healthz');
    const unhealthy = await driver.getHealth();
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.detail).toContain('UNAVAILABLE');
  });

  it('maps API status codes to OrchestrationError codes', async () => {
    server.failNext(409, 'AlreadyExists', 'jobs "x" already exists', '/jobs');
    await expect(driver.placeWorkload(makeWorkload('conflict-1', 'complete'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    server.failNext(403, 'Forbidden', 'RBAC denied', '/jobs');
    await expect(driver.placeWorkload(makeWorkload('conflict-2', 'complete'), actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

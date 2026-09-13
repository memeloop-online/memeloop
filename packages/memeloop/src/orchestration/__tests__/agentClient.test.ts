import { describe, expect, it, vi } from 'vitest';

import { createAgentClient } from '../agentClient.js';
import type { AgentOrchestrationClient } from '../client.js';
import { OrchestrationError } from '../errors.js';
import { AGENT_RUN_API_VERSION, AGENT_RUN_KIND, AGENT_WORKLOAD_API_VERSION, AGENT_WORKLOAD_KIND } from '../resources.js';

describe('createAgentClient', () => {
  function createFakeClient(overrides: Partial<AgentOrchestrationClient> = {}): AgentOrchestrationClient {
    return {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      watch: vi.fn(),
      delete: vi.fn(),
      ...overrides,
    } as unknown as AgentOrchestrationClient;
  }

  it('creates an AgentWorkload through the facade', async () => {
    const apply = vi.fn().mockResolvedValue({
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      metadata: { name: 'reviewer', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      spec: { profileId: 'memeloop:code-assistant' },
    });
    const client = createAgentClient(createFakeClient({ apply }));

    const workload = await client.createWorkload({
      name: 'reviewer',
      profileId: 'memeloop:code-assistant',
      trust: 'restricted',
      completionPolicy: 'complete',
      idempotencyKey: 'child-1',
    });

    expect(workload.metadata.name).toBe('reviewer');
    expect(workload.spec.profileId).toBe('memeloop:code-assistant');
    expect(apply).toHaveBeenCalledWith(
      {
        apiVersion: AGENT_WORKLOAD_API_VERSION,
        kind: AGENT_WORKLOAD_KIND,
        metadata: { name: 'reviewer' },
        spec: {
          profileId: 'memeloop:code-assistant',
          trust: 'restricted',
          completionPolicy: 'complete',
        },
      },
      { idempotencyKey: 'child-1', fieldManager: 'memeloop-agent-client' },
    );
  });

  it('creates an AgentRun bound to a workload', async () => {
    const apply = vi.fn().mockResolvedValue({
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      metadata: { name: 'run-1', uid: 'uid-2', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      spec: { workloadRef: { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'reviewer', namespace: 'default' } },
    });
    const client = createAgentClient(createFakeClient({ apply }), 'default');

    const run = await client.createRun({
      name: 'run-1',
      workloadName: 'reviewer',
      promptReference: 'prompt:review',
      retry: 2,
      timeoutMs: 30_000,
    });

    expect(run.metadata.name).toBe('run-1');
    expect(run.spec.workloadRef.name).toBe('reviewer');
    expect(run.spec.workloadRef.namespace).toBe('default');
    expect(apply).toHaveBeenCalledWith(
      {
        apiVersion: AGENT_RUN_API_VERSION,
        kind: AGENT_RUN_KIND,
        metadata: { name: 'run-1' },
        spec: {
          workloadRef: { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'reviewer', namespace: 'default' },
          promptReference: 'prompt:review',
          retry: 2,
          timeoutMs: 30_000,
        },
      },
      { idempotencyKey: undefined, fieldManager: 'memeloop-agent-client' },
    );
  });

  it('rejects apply results of the wrong kind', async () => {
    const apply = vi.fn().mockResolvedValue({
      apiVersion: 'other/v1',
      kind: 'Other',
      metadata: { name: 'x', uid: 'uid-3', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      spec: {},
    });
    const client = createAgentClient(createFakeClient({ apply }));

    await expect(client.createWorkload({ name: 'x' })).rejects.toThrow(OrchestrationError);
  });

  it('waits for a workload condition', async () => {
    const get = vi.fn().mockResolvedValueOnce({
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      metadata: { name: 'reviewer', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      spec: {},
      status: {
        conditions: [{ type: 'Ready', status: 'False', reason: 'Starting', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
      },
    }).mockResolvedValueOnce({
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      metadata: { name: 'reviewer', uid: 'uid-1', generation: 1, resourceVersion: '2', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      spec: {},
      status: {
        conditions: [{ type: 'Ready', status: 'True', reason: 'Ready', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
      },
    });
    const client = createAgentClient(createFakeClient({ get }));

    const result = await client.waitForWorkloadCondition(
      'reviewer',
      { type: 'Ready', status: 'True' },
      { timeout: 500, interval: 50 },
    );

    expect(result.observedResourceVersion).toBe('2');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight condition wait and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn().mockResolvedValue({
        apiVersion: AGENT_WORKLOAD_API_VERSION,
        kind: AGENT_WORKLOAD_KIND,
        metadata: { name: 'reviewer', uid: 'uid-1', generation: 1, resourceVersion: '7', creationTimestamp: '2026-07-16T00:00:00.000Z' },
        spec: {},
        status: {
          conditions: [{ type: 'Ready', status: 'False', reason: 'Starting', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
        },
      });
      const client = createAgentClient(createFakeClient({ get }));
      const controller = new AbortController();

      const pending = client.waitForWorkloadCondition(
        'reviewer',
        { type: 'Ready', status: 'True' },
        { timeout: 1000, interval: 100, signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledOnce();

      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a workload and a run', async () => {
    const delete_ = vi.fn().mockResolvedValue({ accepted: true, reference: { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'reviewer' } });
    const client = createAgentClient(createFakeClient({ delete: delete_ }), 'default');

    await client.deleteWorkload('reviewer');
    await client.deleteRun('run-1');

    expect(delete_).toHaveBeenCalledWith({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'reviewer', namespace: 'default' });
    expect(delete_).toHaveBeenCalledWith({ apiVersion: AGENT_RUN_API_VERSION, kind: AGENT_RUN_KIND, name: 'run-1', namespace: 'default' });
  });
});

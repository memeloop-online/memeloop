import { describe, expect, it } from 'vitest';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  agentRunReference,
  agentWorkloadReference,
  createAgentRunManifest,
  createAgentWorkloadManifest,
  createToolClassManifest,
  createToolExecutorManifest,
  createToolOperationManifest,
  isAgentRun,
  isAgentWorkload,
  isToolClass,
  isToolExecutor,
  isToolOperation,
  TOOL_CLASS_API_VERSION,
  TOOL_CLASS_KIND,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
} from '../resources.js';

describe('orchestration resource helpers', () => {
  it('creates an AgentWorkload manifest with canonical apiVersion and kind', () => {
    const manifest = createAgentWorkloadManifest('reviewer', {
      profileId: 'memeloop:code-assistant',
      trust: 'restricted',
      placement: { nodeSelector: { gpu: 'true' } },
      ownerReferences: [{ apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'parent', uid: 'parent-uid' }],
    });

    expect(manifest).toEqual({
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      metadata: { name: 'reviewer' },
      spec: {
        profileId: 'memeloop:code-assistant',
        trust: 'restricted',
        placement: { nodeSelector: { gpu: 'true' } },
        ownerReferences: [{ apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'parent', uid: 'parent-uid' }],
      },
    });
  });

  it('creates an AgentRun manifest referencing a workload', () => {
    const manifest = createAgentRunManifest('run-1', {
      workloadRef: agentWorkloadReference('reviewer', 'default'),
      retry: 2,
      timeoutMs: 30_000,
    });

    expect(manifest).toEqual({
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      metadata: { name: 'run-1' },
      spec: {
        workloadRef: {
          apiVersion: AGENT_WORKLOAD_API_VERSION,
          kind: AGENT_WORKLOAD_KIND,
          name: 'reviewer',
          namespace: 'default',
        },
        retry: 2,
        timeoutMs: 30_000,
      },
    });
  });

  it('type-guards resources by apiVersion and kind', () => {
    const workload = createAgentWorkloadManifest('w', {});
    const run = createAgentRunManifest('r', { workloadRef: agentWorkloadReference('w') });
    const runRef = agentRunReference('r', 'default');

    expect(isAgentWorkload(workload)).toBe(true);
    expect(isAgentRun(workload)).toBe(false);
    expect(isAgentRun(run)).toBe(true);
    expect(isAgentWorkload(run)).toBe(false);
    expect(isAgentWorkload({ apiVersion: 'other/v1', kind: 'AgentWorkload' })).toBe(false);
    expect(runRef).toEqual({
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: 'r',
      namespace: 'default',
    });
  });

  it('creates a ToolOperation manifest with effect, idempotency, and fencing', () => {
    const manifest = createToolOperationManifest('write-file', {
      toolRef: { kind: 'BuiltinTool', name: 'file.write' },
      effect: 'create',
      arguments: { path: '/tmp/report.md', content: 'hello' },
      idempotencyKey: 'op-1',
      retry: { maxAttempts: 3, nonRetryable: false, fencingToken: 'fence-1' },
      policy: { requireApproval: true, auditLevel: 'payload' },
    });

    expect(manifest).toEqual({
      apiVersion: TOOL_OPERATION_API_VERSION,
      kind: TOOL_OPERATION_KIND,
      metadata: { name: 'write-file' },
      spec: {
        toolRef: { kind: 'BuiltinTool', name: 'file.write' },
        effect: 'create',
        arguments: { path: '/tmp/report.md', content: 'hello' },
        idempotencyKey: 'op-1',
        retry: { maxAttempts: 3, nonRetryable: false, fencingToken: 'fence-1' },
        policy: { requireApproval: true, auditLevel: 'payload' },
      },
    });

    const resource = {
      ...manifest,
      metadata: { name: 'write-file', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
      status: {
        phase: 'Completed' as const,
        result: { value: 'ok' },
        conditions: [],
      },
    };
    expect(isToolOperation(resource)).toBe(true);
    expect(isToolOperation({ apiVersion: 'other/v1', kind: 'ToolOperation' })).toBe(false);
  });

  it('creates ToolClass and ToolExecutor manifests with schema digests and health', () => {
    const toolClass = createToolClassManifest('file.write', {
      description: 'Write a file',
      version: '1.0.0',
      schema: {
        input: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
        required: ['path'],
      },
      schemaDigest: 'sha256:abc123',
      risk: 'high',
      effects: ['create'],
      allowedTargets: ['local', 'remote'],
      categories: ['filesystem'],
    });

    const executor = createToolExecutorManifest('executor-1', {
      nodeId: 'node-a',
      selectors: { trust: 'trusted' },
      capabilities: [
        {
          toolClassRef: { apiVersion: TOOL_CLASS_API_VERSION, kind: TOOL_CLASS_KIND, name: 'file.write' },
          schemaDigest: 'sha256:abc123',
          endpoint: 'http://node-a:8080/tools/file.write',
          capacity: { maxConcurrent: 4, queueDepth: 10 },
          health: { healthy: true, lastHeartbeat: '2026-07-16T00:00:00.000Z' },
        },
      ],
      trust: 'trusted',
    });

    expect(toolClass).toEqual({
      apiVersion: TOOL_CLASS_API_VERSION,
      kind: TOOL_CLASS_KIND,
      metadata: { name: 'file.write' },
      spec: {
        description: 'Write a file',
        version: '1.0.0',
        schema: {
          input: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
          required: ['path'],
        },
        schemaDigest: 'sha256:abc123',
        risk: 'high',
        effects: ['create'],
        allowedTargets: ['local', 'remote'],
        categories: ['filesystem'],
      },
    });

    expect(executor).toEqual({
      apiVersion: TOOL_EXECUTOR_API_VERSION,
      kind: TOOL_EXECUTOR_KIND,
      metadata: { name: 'executor-1' },
      spec: {
        nodeId: 'node-a',
        selectors: { trust: 'trusted' },
        capabilities: [
          {
            toolClassRef: { apiVersion: TOOL_CLASS_API_VERSION, kind: TOOL_CLASS_KIND, name: 'file.write' },
            schemaDigest: 'sha256:abc123',
            endpoint: 'http://node-a:8080/tools/file.write',
            capacity: { maxConcurrent: 4, queueDepth: 10 },
            health: { healthy: true, lastHeartbeat: '2026-07-16T00:00:00.000Z' },
          },
        ],
        trust: 'trusted',
      },
    });

    expect(isToolClass(toolClass)).toBe(true);
    expect(isToolExecutor(executor)).toBe(true);
    expect(isToolClass({ apiVersion: 'other/v1', kind: 'ToolClass' })).toBe(false);
  });
});

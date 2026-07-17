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
  createModelCallRecordManifest,
  createModelClassManifest,
  createModelEndpointManifest,
  createSnapshotManifest,
  createStorageClassManifest,
  createToolClassManifest,
  createToolExecutorManifest,
  createToolOperationManifest,
  createVolumeClaimManifest,
  createVolumeManifest,
  isAgentRun,
  isAgentWorkload,
  isModelCallRecord,
  isModelClass,
  isModelEndpoint,
  isSnapshot,
  isStorageClass,
  isToolClass,
  isToolExecutor,
  isToolOperation,
  isVolume,
  isVolumeClaim,
  MODEL_CALL_RECORD_API_VERSION,
  MODEL_CALL_RECORD_KIND,
  MODEL_CLASS_API_VERSION,
  MODEL_CLASS_KIND,
  MODEL_ENDPOINT_API_VERSION,
  MODEL_ENDPOINT_KIND,
  SNAPSHOT_API_VERSION,
  SNAPSHOT_KIND,
  STORAGE_CLASS_API_VERSION,
  STORAGE_CLASS_KIND,
  TOOL_CLASS_API_VERSION,
  TOOL_CLASS_KIND,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
  VOLUME_API_VERSION,
  VOLUME_KIND,
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

  it('creates ModelClass, ModelEndpoint, and ModelCallRecord manifests', () => {
    const modelClass = createModelClassManifest('qwen2.5-7b-local', {
      description: 'Local Qwen 7B served by worker nodes',
      provider: 'ollama',
      model: 'qwen2.5:7b',
      digest: 'sha256:weights123',
      modalities: ['text'],
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      capabilities: { streaming: true, toolUse: true },
      dataResidency: 'local',
    });

    expect(modelClass).toEqual({
      apiVersion: MODEL_CLASS_API_VERSION,
      kind: MODEL_CLASS_KIND,
      metadata: { name: 'qwen2.5-7b-local' },
      spec: {
        description: 'Local Qwen 7B served by worker nodes',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        digest: 'sha256:weights123',
        modalities: ['text'],
        contextWindow: 32_768,
        maxOutputTokens: 4096,
        capabilities: { streaming: true, toolUse: true },
        dataResidency: 'local',
      },
    });

    const endpoint = createModelEndpointManifest('endpoint-node-a', {
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: 'qwen2.5-7b-local' },
      modelDigest: 'sha256:weights123',
      nodeId: 'node-a',
      trust: 'restricted',
      endpoint: 'ollama://node-a/qwen2.5:7b',
      capacity: { maxConcurrent: 2, tokensPerMinute: 20_000 },
      dataPolicy: { classification: 'internal', retention: 'none' },
    });

    expect(endpoint.apiVersion).toBe(MODEL_ENDPOINT_API_VERSION);
    expect(endpoint.kind).toBe(MODEL_ENDPOINT_KIND);
    expect(endpoint.spec.modelClassRef.name).toBe('qwen2.5-7b-local');

    const call = createModelCallRecordManifest('call-1', {
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: 'qwen2.5-7b-local' },
      endpointRef: { apiVersion: MODEL_ENDPOINT_API_VERSION, kind: MODEL_ENDPOINT_KIND, name: 'endpoint-node-a' },
      runRef: { apiVersion: AGENT_RUN_API_VERSION, kind: AGENT_RUN_KIND, name: 'run-1', uid: 'uid-run-1' },
      caller: 'agent:reviewer',
      accessHandleRef: 'handle-1',
      inputClassification: 'internal',
      outputClassification: 'internal',
    });

    expect(call).toEqual({
      apiVersion: MODEL_CALL_RECORD_API_VERSION,
      kind: MODEL_CALL_RECORD_KIND,
      metadata: { name: 'call-1' },
      spec: {
        modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: 'qwen2.5-7b-local' },
        endpointRef: { apiVersion: MODEL_ENDPOINT_API_VERSION, kind: MODEL_ENDPOINT_KIND, name: 'endpoint-node-a' },
        runRef: { apiVersion: AGENT_RUN_API_VERSION, kind: AGENT_RUN_KIND, name: 'run-1', uid: 'uid-run-1' },
        caller: 'agent:reviewer',
        accessHandleRef: 'handle-1',
        inputClassification: 'internal',
        outputClassification: 'internal',
      },
    });

    expect(isModelClass(modelClass)).toBe(true);
    expect(isModelEndpoint(endpoint)).toBe(true);
    expect(isModelCallRecord(call)).toBe(true);
    expect(isModelClass({ apiVersion: 'other/v1', kind: 'ModelClass' })).toBe(false);
    expect(isModelEndpoint({ apiVersion: MODEL_ENDPOINT_API_VERSION, kind: 'ModelClass' })).toBe(false);
    expect(isModelCallRecord({ apiVersion: MODEL_CALL_RECORD_API_VERSION, kind: 'ModelEndpoint' })).toBe(false);
  });

  it('creates StorageClass, claim, volume, and snapshot manifests for the CSI-like lifecycle', () => {
    const storageClass = createStorageClassManifest('replicated-markdown', {
      description: 'Markdown volumes replicated across nodes',
      driver: 'markdown-fs',
      replication: { factor: 3, faultDomains: ['node'], autoRebuild: true },
      encryption: { enabled: true, keyRef: 'vault:storage-key' },
      allowedAccessModes: ['ReadWriteOnce'],
      snapshotSupport: true,
      backup: { schedule: '0 * * * *', retentionCount: 24 },
      dataPolicy: { classification: 'internal' },
    });

    expect(storageClass).toEqual({
      apiVersion: STORAGE_CLASS_API_VERSION,
      kind: STORAGE_CLASS_KIND,
      metadata: { name: 'replicated-markdown' },
      spec: {
        description: 'Markdown volumes replicated across nodes',
        driver: 'markdown-fs',
        replication: { factor: 3, faultDomains: ['node'], autoRebuild: true },
        encryption: { enabled: true, keyRef: 'vault:storage-key' },
        allowedAccessModes: ['ReadWriteOnce'],
        snapshotSupport: true,
        backup: { schedule: '0 * * * *', retentionCount: 24 },
        dataPolicy: { classification: 'internal' },
      },
    });

    const claim = createVolumeClaimManifest('workspace-claim', {
      storageClassRef: { apiVersion: STORAGE_CLASS_API_VERSION, kind: STORAGE_CLASS_KIND, name: 'replicated-markdown' },
      accessMode: 'ReadWriteOnce',
      sizeBytes: 1_073_741_824,
      dataSourceRef: { apiVersion: SNAPSHOT_API_VERSION, kind: SNAPSHOT_KIND, name: 'snap-20260716' },
    });
    expect(claim.spec.dataSourceRef?.name).toBe('snap-20260716');

    const volume = createVolumeManifest('workspace-vol', {
      storageClassRef: { apiVersion: STORAGE_CLASS_API_VERSION, kind: STORAGE_CLASS_KIND, name: 'replicated-markdown' },
      driverHandle: 'mdfs://vol-8f3a',
      capacityBytes: 1_073_741_824,
      topology: { nodeId: 'node-a', zone: 'home' },
      accessModes: ['ReadWriteOnce'],
    });
    expect(volume.spec.driverHandle).toBe('mdfs://vol-8f3a');

    const snapshot = createSnapshotManifest('snap-20260716', {
      sourceVolumeRef: { apiVersion: VOLUME_API_VERSION, kind: VOLUME_KIND, name: 'workspace-vol' },
    });
    expect(snapshot.spec.sourceVolumeRef.name).toBe('workspace-vol');

    expect(isStorageClass(storageClass)).toBe(true);
    expect(isVolumeClaim(claim)).toBe(true);
    expect(isVolume(volume)).toBe(true);
    expect(isSnapshot(snapshot)).toBe(true);
    expect(isVolume({ apiVersion: VOLUME_API_VERSION, kind: SNAPSHOT_KIND })).toBe(false);
    expect(isSnapshot({ apiVersion: SNAPSHOT_API_VERSION, kind: VOLUME_KIND })).toBe(false);
  });
});

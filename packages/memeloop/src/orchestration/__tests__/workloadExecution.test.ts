import { describe, expect, it, vi } from 'vitest';

import type { AgentFrameworkContext, IAgentStorage } from '../../types.js';
import { createInProcessLoopRuntimeDriver, type LoopRunHandle, type LoopRuntimeDriver } from '../loopRuntimeDriver.js';
import {
  AGENT_RUN_API_VERSION,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  type AgentRunResource,
  type AgentWorkloadResource,
  createAgentRunManifest,
  createAgentWorkloadManifest,
  createModelEndpointManifest,
  createNetworkClassManifest,
  MODEL_ENDPOINT_API_VERSION,
  MODEL_ENDPOINT_KIND,
  type ModelEndpointResource,
  NETWORK_ATTACHMENT_API_VERSION,
  NETWORK_ATTACHMENT_KIND,
  type NetworkAttachmentResource,
} from '../resources.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';
import { createWorkloadExecutionController, type WorkloadExecutionControllerHandle } from '../workloadExecutionController.js';

const actor = { id: 'controller/workload-execution-test', kind: 'controller' as const };

function fakeContext(): AgentFrameworkContext {
  const storage: IAgentStorage = {
    async listConversations() {
      return [];
    },
    async getMessages() {
      return [];
    },
    async appendMessage() {},
    async upsertConversationMetadata() {},
    async insertMessagesIfAbsent() {},
    async getAttachment() {
      return null;
    },
    async saveAttachment() {},
    async getAgentDefinition() {
      return null;
    },
    async saveAgentInstance() {},
    async getConversationMeta() {
      return null;
    },
  };
  return {
    storage,
    llmProvider: { name: 'dummy', chat: async () => undefined } as never,
    tools: { registerTool: () => {}, getTool: () => undefined, listTools: () => [] } as never,
    syncAdapters: [],
    network: { start: async () => {}, stop: async () => {} },
    loopScriptPolicy: {
      allowSource: true,
      scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, trustClass: 'trusted' as const }) },
    },
  };
}

function workloadResource(name: string, spec: AgentWorkloadResource['spec']): AgentWorkloadResource {
  return {
    apiVersion: AGENT_WORKLOAD_API_VERSION,
    kind: AGENT_WORKLOAD_KIND,
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec,
  };
}

function runResource(name: string): AgentRunResource {
  return {
    apiVersion: AGENT_RUN_API_VERSION,
    kind: 'AgentRun',
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: { workloadRef: { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'w1' } },
  };
}

const OK_SCRIPT = 'export default async function* s() { yield { type: "message", data: "ok" }; }';

describe('createInProcessLoopRuntimeDriver', () => {
  it('executes a script workload to Completed with the collected summary', async () => {
    const driver = createInProcessLoopRuntimeDriver(fakeContext());
    const handle = await driver.start({
      workload: workloadResource('w1', { scriptReference: 'sha256:abc' }),
      run: runResource('w1-run'),
      scriptSource: OK_SCRIPT,
      message: 'hello',
    });

    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Completed');
    expect(outcome.summary).toContain('ok');
  });

  it('rejects a script workload without resolved source', async () => {
    const driver = createInProcessLoopRuntimeDriver(fakeContext());
    await expect(
      driver.start({ workload: workloadResource('w1', { scriptReference: 'sha256:abc' }), run: runResource('w1-run') }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('rejects a profile workload whose profile does not exist', async () => {
    const driver = createInProcessLoopRuntimeDriver(fakeContext());
    await expect(
      driver.start({ workload: workloadResource('w1', { profileId: 'missing:profile' }), run: runResource('w1-run') }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('fails closed without a valid model binding or remote transport', async () => {
    const driver = createInProcessLoopRuntimeDriver(fakeContext());
    const modelWorkload = workloadResource('w1', {
      scriptReference: 'sha256:abc',
      modelPolicy: { modelClass: 'chat' },
    });
    await expect(
      driver.start({
        workload: modelWorkload,
        run: runResource('w1-run'),
        scriptSource: OK_SCRIPT,
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });

    modelWorkload.status = { assignedNode: 'worker-a' };
    const endpoint: ModelEndpointResource = {
      apiVersion: MODEL_ENDPOINT_API_VERSION,
      kind: MODEL_ENDPOINT_KIND,
      metadata: {
        name: 'remote-model',
        uid: 'endpoint-uid',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '',
      },
      spec: {
        modelClassRef: {
          apiVersion: 'models.memeloop.io/v1alpha1',
          kind: 'ModelClass',
          name: 'chat',
        },
        nodeId: 'worker-b',
        endpoint: 'gateway://worker-b',
      },
    };
    const boundRun = runResource('w1-run');
    boundRun.status = {
      phase: 'Pending',
      assignedModelEndpoint: {
        apiVersion: endpoint.apiVersion,
        kind: endpoint.kind,
        name: endpoint.metadata.name,
        uid: endpoint.metadata.uid,
      },
    };
    await expect(
      driver.start({
        workload: modelWorkload,
        run: boundRun,
        modelEndpoint: endpoint,
        scriptSource: OK_SCRIPT,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('consumes a host-resolved provider for a bound remote endpoint', async () => {
    const resolvedProvider = { name: 'remote', chat: async () => undefined } as never;
    let resolved = 0;
    const driver = createInProcessLoopRuntimeDriver(fakeContext(), {
      resolveModelProvider: async () => {
        resolved += 1;
        return resolvedProvider;
      },
    });
    const modelWorkload = workloadResource('w1', {
      scriptReference: 'sha256:abc',
      modelPolicy: { modelClass: 'chat' },
    });
    modelWorkload.status = { assignedNode: 'worker-a' };
    const endpoint: ModelEndpointResource = {
      apiVersion: MODEL_ENDPOINT_API_VERSION,
      kind: MODEL_ENDPOINT_KIND,
      metadata: {
        name: 'remote-model',
        uid: 'endpoint-uid',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '',
      },
      spec: {
        modelClassRef: {
          apiVersion: 'models.memeloop.io/v1alpha1',
          kind: 'ModelClass',
          name: 'chat',
        },
        nodeId: 'worker-b',
        endpoint: 'gateway://worker-b',
      },
    };
    const boundRun = runResource('w1-run');
    boundRun.status = {
      phase: 'Pending',
      assignedModelEndpoint: {
        apiVersion: endpoint.apiVersion,
        kind: endpoint.kind,
        name: endpoint.metadata.name,
        uid: endpoint.metadata.uid,
      },
    };

    const handle = await driver.start({
      workload: modelWorkload,
      run: boundRun,
      modelEndpoint: endpoint,
      scriptSource: OK_SCRIPT,
    });
    expect((await handle.wait()).phase).toBe('Completed');
    expect(resolved).toBe(1);
  });

  it('cancel terminates a running loop with Cancelled', async () => {
    const driver = createInProcessLoopRuntimeDriver(fakeContext());
    const handle = await driver.start({
      workload: workloadResource('w1', { scriptReference: 'sha256:abc' }),
      run: runResource('w1-run'),
      scriptSource: `
        export default async function* s(ctx) {
          while (!ctx.isCancelled()) {
            await new Promise((r) => setTimeout(r, 5));
          }
          yield { type: 'message', data: 'stopped' };
        }
      `,
    });

    await new Promise((r) => setTimeout(r, 30));
    await handle.cancel();
    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Cancelled');
  });
});

describe('createWorkloadExecutionController', () => {
  function makeStore() {
    return new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
  }

  async function createBoundWorkload(store: QuorumControlStore, name: string, node: string, spec: AgentWorkloadResource['spec'] = {}) {
    const created = await store.create(actor, createAgentWorkloadManifest(name, spec));
    await store.updateStatus(actor, { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name, namespace: 'default' }, {
      phase: 'Scheduling',
      assignedNode: node,
    }, { resourceVersion: created.metadata.resourceVersion });
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitFor timed out');
  }

  const workloadRef = (name: string) => ({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name, namespace: 'default' });

  it('executes a workload bound to this node and writes terminal statuses', async () => {
    const store = makeStore();
    const driver: LoopRuntimeDriver = {
      async start() {
        const claimed = await store.get({
          apiVersion: AGENT_RUN_API_VERSION,
          kind: 'AgentRun',
          name: 'w-local-run',
          namespace: 'default',
        });
        expect(claimed?.status).toMatchObject({
          phase: 'Starting',
          runtimeExecutionClaim: {
            controllerInstanceId: 'controller-instance-1',
          },
        });
        const handle: LoopRunHandle = {
          wait: async () => ({ phase: 'Completed', summary: 'done' }),
          cancel: async () => {},
        };
        return handle;
      },
    };
    const controller: WorkloadExecutionControllerHandle = createWorkloadExecutionController(store, driver, {
      actor,
      nodeId: 'node-1',
      controllerInstanceId: 'controller-instance-1',
    });
    try {
      await createBoundWorkload(store, 'w-local', 'node-1');

      await waitFor(async () => {
        const workload = await store.get(workloadRef('w-local'));
        return (workload?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });

      const run = await store.get({ apiVersion: AGENT_RUN_API_VERSION, kind: 'AgentRun', name: 'w-local-run', namespace: 'default' });
      expect(run?.status).toMatchObject({ phase: 'Completed', summary: 'done', exitCode: 0 });
      const workload = await store.get(workloadRef('w-local'));
      expect((workload?.status as { runs?: unknown[] } | undefined)?.runs).toHaveLength(1);
    } finally {
      await controller.stop();
    }
  });

  it('rejects a pre-created deterministic Run whose workload binding is not canonical', async () => {
    const store = makeStore();
    const workload = await store.create(
      actor,
      createAgentWorkloadManifest('w-precreated', { profileId: 'general' }),
    );
    const runManifest = createAgentRunManifest('w-precreated-run', {
      workloadRef: {
        apiVersion: AGENT_WORKLOAD_API_VERSION,
        kind: AGENT_WORKLOAD_KIND,
        name: 'w-precreated',
        namespace: 'default',
        uid: `${workload.metadata.uid}-forged`,
      },
    });
    runManifest.metadata.namespace = 'default';
    await store.create(actor, runManifest);
    await store.updateStatus(actor, workloadRef('w-precreated'), {
      phase: 'Scheduling',
      assignedNode: 'node-1',
    }, { resourceVersion: workload.metadata.resourceVersion });
    const start = vi.fn();
    const errors: unknown[] = [];
    const controller = createWorkloadExecutionController(
      store,
      { start } as unknown as LoopRuntimeDriver,
      {
        actor,
        nodeId: 'node-1',
        controllerInstanceId: 'controller-instance-precreated',
        onError: (error) => errors.push(error),
      },
    );
    try {
      await waitFor(async () => {
        const current = await store.get(workloadRef('w-precreated'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Failed';
      });
      expect(start).not.toHaveBeenCalled();
      const failedRun = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-precreated-run',
        namespace: 'default',
      });
      expect(failedRun?.status).toMatchObject({
        phase: 'Failed',
        summary: expect.stringContaining('does not exactly match controller-owned workload'),
      });
      expect(errors).toHaveLength(1);
    } finally {
      await controller.stop();
    }
  });

  it('fails a pre-existing claimed execution as UNKNOWN_EFFECT instead of replaying it after restart', async () => {
    const store = makeStore();
    const workload = await store.create(
      actor,
      createAgentWorkloadManifest('w-unknown', { profileId: 'general' }),
    );
    await store.updateStatus(actor, workloadRef('w-unknown'), {
      phase: 'Running',
      assignedNode: 'node-1',
    }, { resourceVersion: workload.metadata.resourceVersion });
    const run = await store.create(
      actor,
      createAgentRunManifest('w-unknown-run', {
        workloadRef: {
          apiVersion: AGENT_WORKLOAD_API_VERSION,
          kind: AGENT_WORKLOAD_KIND,
          name: 'w-unknown',
          uid: workload.metadata.uid,
        },
      }),
    );
    await store.updateStatus(actor, {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: 'AgentRun',
      name: 'w-unknown-run',
      namespace: 'default',
    }, {
      phase: 'Running',
      runtimeExecutionClaim: {
        controllerInstanceId: 'dead-controller',
        claimedAt: '2026-07-26T00:00:00.000Z',
      },
    }, { resourceVersion: run.metadata.resourceVersion });
    const start = vi.fn();
    const controller = createWorkloadExecutionController(
      store,
      { start } as unknown as LoopRuntimeDriver,
      {
        actor,
        nodeId: 'node-1',
        controllerInstanceId: 'replacement-controller',
      },
    );
    try {
      await waitFor(async () => {
        const current = await store.get(workloadRef('w-unknown'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Failed';
      });
      expect(start).not.toHaveBeenCalled();
      const failedRun = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-unknown-run',
        namespace: 'default',
      });
      expect(failedRun?.status).toMatchObject({
        phase: 'Failed',
        summary: expect.stringContaining('UNKNOWN_EFFECT'),
      });
    } finally {
      await controller.stop();
    }
  });

  it('safely resumes a Running workload when no pre-effect run claim exists', async () => {
    const store = makeStore();
    const workload = await store.create(
      actor,
      createAgentWorkloadManifest('w-preclaim', { profileId: 'general' }),
    );
    await store.updateStatus(actor, workloadRef('w-preclaim'), {
      phase: 'Running',
      assignedNode: 'node-1',
    }, { resourceVersion: workload.metadata.resourceVersion });
    const start = vi.fn(async () => ({
      wait: async () => ({ phase: 'Completed' as const, summary: 'resumed safely' }),
      cancel: async () => {},
    }));
    const controller = createWorkloadExecutionController(store, { start }, {
      actor,
      nodeId: 'node-1',
      controllerInstanceId: 'replacement-controller',
    });
    try {
      await waitFor(async () => {
        const current = await store.get(workloadRef('w-preclaim'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });
      expect(start).toHaveBeenCalledOnce();
      const completedRun = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-preclaim-run',
        namespace: 'default',
      });
      expect(completedRun?.status).toMatchObject({
        phase: 'Completed',
        runtimeExecutionClaim: {
          controllerInstanceId: 'replacement-controller',
        },
      });
    } finally {
      await controller.stop();
    }
  });

  it('mirrors a terminal Run during restart without resolving or relaunching its script', async () => {
    const store = makeStore();
    const workload = await store.create(
      actor,
      createAgentWorkloadManifest('w-terminal-recovery', {
        scriptReference: `sha256:${'a'.repeat(64)}`,
      }),
    );
    await store.updateStatus(actor, workloadRef('w-terminal-recovery'), {
      phase: 'Running',
      assignedNode: 'node-1',
    }, { resourceVersion: workload.metadata.resourceVersion });
    const run = await store.create(
      actor,
      createAgentRunManifest('w-terminal-recovery-run', {
        workloadRef: {
          apiVersion: AGENT_WORKLOAD_API_VERSION,
          kind: AGENT_WORKLOAD_KIND,
          name: 'w-terminal-recovery',
          uid: workload.metadata.uid,
        },
      }),
    );
    await store.updateStatus(actor, {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: 'AgentRun',
      name: 'w-terminal-recovery-run',
      namespace: 'default',
    }, {
      phase: 'Completed',
      summary: 'already complete',
      exitCode: 0,
    }, { resourceVersion: run.metadata.resourceVersion });
    const start = vi.fn();
    const resolveScriptSource = vi.fn(async () => undefined);
    const controller = createWorkloadExecutionController(
      store,
      { start } as unknown as LoopRuntimeDriver,
      {
        actor,
        nodeId: 'node-1',
        controllerInstanceId: 'replacement-controller',
        resolveScriptSource,
      },
    );
    try {
      await waitFor(async () => {
        const current = await store.get(workloadRef('w-terminal-recovery'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });
      expect(resolveScriptSource).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it('uses the durable Run claim to prevent duplicate launch by competing node daemons', async () => {
    const store = makeStore();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const start = vi.fn(async () => ({
      wait: async () => {
        await finished;
        return { phase: 'Completed' as const, summary: 'single launch' };
      },
      cancel: async () => {},
    }));
    const first = createWorkloadExecutionController(store, { start }, {
      actor,
      nodeId: 'node-1',
      controllerInstanceId: 'controller-a',
    });
    const second = createWorkloadExecutionController(store, { start }, {
      actor,
      nodeId: 'node-1',
      controllerInstanceId: 'controller-b',
    });
    try {
      await createBoundWorkload(store, 'w-race', 'node-1', { profileId: 'general' });
      await waitFor(async () => start.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(start).toHaveBeenCalledOnce();
      const claimed = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-race-run',
        namespace: 'default',
      });
      expect(claimed?.status).toMatchObject({
        phase: 'Running',
        runtimeExecutionClaim: {
          controllerInstanceId: expect.stringMatching(/^controller-[ab]$/),
        },
      });
      finish();
      await waitFor(async () => {
        const current = await store.get(workloadRef('w-race'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });
    } finally {
      finish();
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  it('ignores workloads bound to another node', async () => {
    const store = makeStore();
    let started = 0;
    const driver: LoopRuntimeDriver = {
      async start() {
        started += 1;
        return { wait: async () => ({ phase: 'Completed' as const }), cancel: async () => {} };
      },
    };
    const controller = createWorkloadExecutionController(store, driver, { actor, nodeId: 'node-1' });
    try {
      await createBoundWorkload(store, 'w-remote', 'node-2');
      await new Promise((r) => setTimeout(r, 150));
      expect(started).toBe(0);
      const workload = await store.get(workloadRef('w-remote'));
      expect((workload?.status as { phase?: string } | undefined)?.phase).toBe('Scheduling');
    } finally {
      await controller.stop();
    }
  });

  it('waits for and preserves an independently assigned ModelEndpoint', async () => {
    const store = makeStore();
    let startedWith: ModelEndpointResource | undefined;
    const driver: LoopRuntimeDriver = {
      async start(request) {
        startedWith = request.modelEndpoint;
        return {
          wait: async () => ({ phase: 'Completed', summary: 'model-bound' }),
          cancel: async () => {},
        };
      },
    };
    const controller = createWorkloadExecutionController(store, driver, {
      actor,
      nodeId: 'node-1',
      modelBindingTimeoutMs: 2000,
    });
    try {
      await createBoundWorkload(store, 'w-model', 'node-1', {
        profileId: 'general',
        modelPolicy: { modelClass: 'chat' },
      });
      await waitFor(async () =>
        (await store.get({
          apiVersion: AGENT_RUN_API_VERSION,
          kind: 'AgentRun',
          name: 'w-model-run',
          namespace: 'default',
        })) !== null
      );

      const endpointManifest = createModelEndpointManifest('chat-node-1', {
        modelClassRef: {
          apiVersion: 'models.memeloop.io/v1alpha1',
          kind: 'ModelClass',
          name: 'chat',
        },
        nodeId: 'node-1',
        endpoint: 'local://node-1/chat',
      });
      const endpoint = await store.create(actor, endpointManifest);
      await store.updateStatus(
        actor,
        {
          apiVersion: MODEL_ENDPOINT_API_VERSION,
          kind: MODEL_ENDPOINT_KIND,
          name: 'chat-node-1',
          namespace: 'default',
        },
        { healthy: true, heartbeat: new Date().toISOString() },
        { resourceVersion: endpoint.metadata.resourceVersion },
      );
      const runReference = {
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-model-run',
        namespace: 'default',
      };
      const currentRun = await store.get(runReference);
      await store.updateStatus(actor, runReference, {
        phase: 'Pending',
        assignedModelEndpoint: {
          apiVersion: MODEL_ENDPOINT_API_VERSION,
          kind: MODEL_ENDPOINT_KIND,
          name: 'chat-node-1',
          namespace: 'default',
          uid: endpoint.metadata.uid,
        },
        modelBinding: {
          leaseEpoch: 'epoch-1',
          endpointResourceVersion: endpoint.metadata.resourceVersion,
          boundAt: '2026-07-23T00:00:00.000Z',
        },
      }, { resourceVersion: currentRun!.metadata.resourceVersion });

      await waitFor(async () => {
        const current = await store.get(workloadRef('w-model'));
        return (current?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });
      expect(startedWith?.metadata.name).toBe('chat-node-1');
      const completedRun = await store.get(runReference);
      expect(completedRun?.status).toMatchObject({
        phase: 'Completed',
        assignedModelEndpoint: { name: 'chat-node-1' },
        modelBinding: { leaseEpoch: 'epoch-1' },
      });
    } finally {
      await controller.stop();
    }
  });

  it('creates and waits for a fenced NetworkAttachment before launch', async () => {
    const store = makeStore();
    let startedWith: NetworkAttachmentResource | undefined;
    const driver: LoopRuntimeDriver = {
      async start(request) {
        startedWith = request.networkAttachment;
        return {
          wait: async () => ({ phase: 'Completed', summary: 'network-bound' }),
          cancel: async () => {},
        };
      },
    };
    const networkClass = await store.create(
      actor,
      createNetworkClassManifest('process-net', {
        driver: 'process-env',
        proxy: { httpsProxy: 'http://proxy:8080' },
        enforcement: 'best-effort',
      }),
    );
    const controller = createWorkloadExecutionController(store, driver, {
      actor,
      nodeId: 'node-1',
      networkAttachmentTimeoutMs: 2000,
    });
    try {
      await createBoundWorkload(store, 'w-network', 'node-1', {
        profileId: 'general',
        networkPolicy: { networkClass: 'process-net', minimumEnforcement: 'process' },
      });
      const attachmentReference = {
        apiVersion: NETWORK_ATTACHMENT_API_VERSION,
        kind: NETWORK_ATTACHMENT_KIND,
        name: 'w-network-run-network',
        namespace: 'default',
      };
      await waitFor(async () => (await store.get(attachmentReference)) !== null);
      expect(startedWith).toBeUndefined();
      const current = await store.get(attachmentReference);
      await store.updateStatus(actor, attachmentReference, {
        phase: 'Attached',
        assignedNode: 'node-1',
        assignedDriver: 'process-env',
        handle: 'procnet:w-network',
        binding: {
          leaseEpoch: 'network-bind-1',
          networkClassResourceVersion: networkClass.metadata.resourceVersion,
          boundAt: '2026-07-23T00:00:00.000Z',
        },
      }, { resourceVersion: current!.metadata.resourceVersion });

      await waitFor(async () => {
        const item = await store.get(workloadRef('w-network'));
        return (item?.status as { phase?: string } | undefined)?.phase === 'Completed';
      });
      expect(startedWith).toMatchObject({
        metadata: { name: 'w-network-run-network' },
        status: { phase: 'Attached', handle: 'procnet:w-network' },
      });
      const run = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-network-run',
        namespace: 'default',
      });
      expect(run?.status).toMatchObject({
        phase: 'Completed',
        networkAttachmentRef: { name: 'w-network-run-network' },
      });
      expect((await store.get(attachmentReference))?.status).toMatchObject({
        releaseRequestedAt: expect.any(String),
      });
    } finally {
      await controller.stop();
    }
  });

  it('fails the workload when the script artifact cannot be resolved', async () => {
    const store = makeStore();
    const driver: LoopRuntimeDriver = {
      async start() {
        throw new Error('driver must not be started');
      },
    };
    const controller = createWorkloadExecutionController(store, driver, {
      actor,
      nodeId: 'node-1',
      resolveScriptSource: async () => undefined,
    });
    try {
      await createBoundWorkload(store, 'w-script', 'node-1', { scriptReference: 'sha256:missing' });

      await waitFor(async () => {
        const workload = await store.get(workloadRef('w-script'));
        return (workload?.status as { phase?: string } | undefined)?.phase === 'Failed';
      });
      const workload = await store.get(workloadRef('w-script'));
      expect((workload?.status as { lastRunResult?: string } | undefined)?.lastRunResult).toContain('unavailable');
    } finally {
      await controller.stop();
    }
  });

  it('marks the AgentRun terminal when runtime launch fails', async () => {
    const store = makeStore();
    const driver: LoopRuntimeDriver = {
      async start() {
        throw new Error('runtime launch failed');
      },
    };
    const controller = createWorkloadExecutionController(store, driver, {
      actor,
      nodeId: 'node-1',
    });
    try {
      await createBoundWorkload(store, 'w-launch-failure', 'node-1');
      await waitFor(async () => {
        const workload = await store.get(workloadRef('w-launch-failure'));
        return (workload?.status as { phase?: string } | undefined)?.phase === 'Failed';
      });
      const run = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: 'AgentRun',
        name: 'w-launch-failure-run',
        namespace: 'default',
      });
      expect(run?.status).toMatchObject({
        phase: 'Failed',
        summary: expect.stringMatching(
          /^UNKNOWN_EFFECT: .*runtime launch failed$/,
        ),
        exitCode: 1,
      });
    } finally {
      await controller.stop();
    }
  });

  it('cancels the active execution when the workload is deleted', async () => {
    const store = makeStore();
    let cancelled = false;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const driver: LoopRuntimeDriver = {
      async start() {
        startedResolve();
        return {
          wait: () => new Promise(() => {}),
          cancel: async () => {
            cancelled = true;
          },
        };
      },
    };
    const controller = createWorkloadExecutionController(store, driver, { actor, nodeId: 'node-1' });
    try {
      await createBoundWorkload(store, 'w-cancel', 'node-1');
      await started;
      await store.delete(actor, workloadRef('w-cancel'));
      await waitFor(async () => cancelled);
      expect(cancelled).toBe(true);
    } finally {
      await controller.stop();
    }
  });
});

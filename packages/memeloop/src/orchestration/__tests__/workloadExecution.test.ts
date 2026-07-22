import { describe, expect, it } from 'vitest';

import type { AgentFrameworkContext, IAgentStorage } from '../../types.js';
import { createInProcessLoopRuntimeDriver, type LoopRunHandle, type LoopRuntimeDriver } from '../loopRuntimeDriver.js';
import {
  AGENT_RUN_API_VERSION,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  type AgentRunResource,
  type AgentWorkloadResource,
  createAgentWorkloadManifest,
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
    await store.create(actor, createAgentWorkloadManifest(name, spec));
    await store.updateStatus(actor, { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name, namespace: 'default' }, {
      phase: 'Scheduling',
      assignedNode: node,
    }, { resourceVersion: '1' });
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
        const handle: LoopRunHandle = {
          wait: async () => ({ phase: 'Completed', summary: 'done' }),
          cancel: async () => {},
        };
        return handle;
      },
    };
    const controller: WorkloadExecutionControllerHandle = createWorkloadExecutionController(store, driver, { actor, nodeId: 'node-1' });
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

import { describe, expect, it, vi } from 'vitest';

import type { ControlStoreActor } from '../controlStore.js';
import type { ExternalOrchestrationDriver, ExternalStatusResult } from '../drivers/externalDriver.js';
import { createExternalOrchestrationController } from '../externalOrchestrationController.js';
import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  createAgentWorkloadManifest,
  createToolOperationManifest,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
} from '../resources.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const actor: ControlStoreActor = { id: 'controller/external-test', kind: 'controller' };
const authorizeWorkloadPlacement = async () => ({
  decisionHandle: 'policy/allow-external-placement',
  policyDigest: `sha256:${'a'.repeat(64)}`,
});

function fakeDriver(statuses: ExternalStatusResult[]): ExternalOrchestrationDriver {
  let index = 0;
  const nextStatus = () => {
    const status = statuses[Math.min(index++, statuses.length - 1)];
    return status?.phase === 'Succeeded' && status.runtimeResult === undefined
      ? { ...status, runtimeResult: { phase: 'Completed' as const, summary: 'external result' } }
      : status;
  };
  return {
    getCapabilities: async () => ({
      name: 'fake',
      version: '1',
      manages: ['AgentWorkload', 'ToolOperation'],
      supportsColocation: true,
      supportsAdoption: true,
      toolContracts: [{
        kind: 'Tool',
        name: 'render-game',
        effect: 'execute',
        inputSchema: { type: 'object' },
        outputSchema: {},
        resources: { cpuMillicores: 250, memoryBytes: 134_217_728 },
        runtimeImages: ['example.invalid/render-game@sha256:test'],
      }],
      workloadRuntimes: [{
        runtimeClass: 'default',
        image: 'example.invalid/fake-worker@sha256:test',
        resources: { cpuMillicores: 1000, memoryBytes: 536_870_912 },
      }],
    }),
    placeWorkload: vi.fn(async (workload) => ({
      externalId: `external-${workload.metadata.uid}`,
      nodeName: 'worker-7',
      providerMetadata: { backend: 'fake' },
    })),
    getWorkloadStatus: vi.fn(async () => nextStatus()),
    stopWorkload: vi.fn(async () => {}),
    executeToolOperation: vi.fn(async (operation) => ({
      externalId: `external-${operation.metadata.uid}`,
      nodeName: 'worker-8',
    })),
    getToolOperationStatus: vi.fn(async () => nextStatus()),
    cancelToolOperation: vi.fn(async () => {}),
    listWorkloads: async () => [],
    listToolOperations: async () => [],
    getHealth: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
  };
}

function createStore(): QuorumControlStore {
  return new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('external orchestration controller', () => {
  it('routes a workload, persists placement, and reflects completion', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Running', observedAt: new Date().toISOString() },
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeToolOperation: async () => ({}),
      authorizeWorkloadPlacement,
    });
    try {
      const created = await store.create(
        actor,
        createAgentWorkloadManifest('external-workload', {
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'external-workload' }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(final?.status).toMatchObject({
        phase: 'Completed',
        assignedDriver: 'fake',
        assignedNode: 'worker-7',
        externalId: `external-${created.metadata.uid}`,
        externalMetadata: { backend: 'fake' },
        placementDecisionRef: 'policy/allow-external-placement',
        placementPolicyDigest: `sha256:${'a'.repeat(64)}`,
      });
      expect(driver.placeWorkload).toHaveBeenCalledTimes(1);
      const run = await store.get({
        apiVersion: AGENT_RUN_API_VERSION,
        kind: AGENT_RUN_KIND,
        name: 'external-workload-run',
      });
      expect(final?.status?.runs).toEqual([{
        apiVersion: AGENT_RUN_API_VERSION,
        kind: AGENT_RUN_KIND,
        name: 'external-workload-run',
        namespace: 'default',
      }]);
      expect(run?.status).toMatchObject({
        phase: 'Completed',
        summary: 'external result',
        exitCode: 0,
      });
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('fails closed when external workload placement has no host authority', async () => {
    const store = createStore();
    const driver = fakeDriver([]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('external-workload-no-policy', {
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () =>
          store.get({
            apiVersion: AGENT_WORKLOAD_API_VERSION,
            kind: AGENT_WORKLOAD_KIND,
            name: 'external-workload-no-policy',
          }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.lastRunResult).toContain(
        'no host-bound placement authority',
      );
      expect(driver.placeWorkload).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('resolves admitted script content for placement without storing it in control state', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const scriptReference = `sha256:${'a'.repeat(64)}`;
    const resolveScriptSource = vi.fn(async () => 'export default () => "ok"\n');
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      resolveScriptSource,
      pollIntervalMs: 1,
      authorizeWorkloadPlacement,
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('external-script', {
          scriptReference,
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'external-script' }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(resolveScriptSource).toHaveBeenCalledWith(scriptReference);
      expect(driver.placeWorkload).toHaveBeenCalledWith(
        expect.objectContaining({ spec: expect.objectContaining({ scriptReference }) }),
        actor,
        { scriptSource: 'export default () => "ok"\n' },
      );
      expect(JSON.stringify(final)).not.toContain('export default');
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('fails closed before placement when the admitted script artifact is unavailable', async () => {
    const store = createStore();
    const driver = fakeDriver([]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      resolveScriptSource: async () => undefined,
      authorizeWorkloadPlacement,
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('missing-script', {
          scriptReference: `sha256:${'b'.repeat(64)}`,
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'missing-script' }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.lastRunResult).toContain('unavailable for external placement');
      expect(driver.placeWorkload).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('routes ToolOperation independently and returns terminal status', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeWorkloadPlacement,
      authorizeToolOperation: async () => ({}),
    });
    try {
      const created = await store.create(
        actor,
        createToolOperationManifest('external-tool', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'execute',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: TOOL_OPERATION_API_VERSION, kind: TOOL_OPERATION_KIND, name: 'external-tool' }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(final?.status).toMatchObject({
        phase: 'Completed',
        assignedDriver: 'fake',
        assignedNode: 'worker-8',
        externalId: `external-${created.metadata.uid}`,
      });
      expect(driver.executeToolOperation).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('rejects an understated external tool effect before invoking the driver', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeToolOperation: async () => ({}),
    });
    try {
      await store.create(
        actor,
        createToolOperationManifest('external-tool-understated', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'read',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () =>
          store.get({
            apiVersion: TOOL_OPERATION_API_VERSION,
            kind: TOOL_OPERATION_KIND,
            name: 'external-tool-understated',
          }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.result?.error).toMatchObject({
        code: 'INVALID',
        message: expect.stringContaining("does not match host contract 'execute'"),
      });
      expect(driver.executeToolOperation).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('fails closed when external tool placement has no host policy authority', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
    });
    try {
      await store.create(
        actor,
        createToolOperationManifest('external-tool-no-policy', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'execute',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () =>
          store.get({
            apiVersion: TOOL_OPERATION_API_VERSION,
            kind: TOOL_OPERATION_KIND,
            name: 'external-tool-no-policy',
          }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.result?.error).toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('no host-bound policy authority'),
      });
      expect(driver.executeToolOperation).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('persists trusted external approval evidence before placement', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const approval = {
      approvalId: 'approval/external-1',
      actor: 'admin/alice',
      decision: 'allow' as const,
      decidedAt: '2026-07-28T00:00:00.000Z',
    };
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeToolOperation: async () => ({ approval }),
    });
    try {
      await store.create(
        actor,
        createToolOperationManifest('external-tool-approved', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'execute',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () =>
          store.get({
            apiVersion: TOOL_OPERATION_API_VERSION,
            kind: TOOL_OPERATION_KIND,
            name: 'external-tool-approved',
          }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(final?.status?.approval).toEqual(approval);
      expect(driver.executeToolOperation).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('persists a redacted structured tool result from the external runtime', async () => {
    const store = createStore();
    const driver = fakeDriver([{
      externalId: 'x',
      phase: 'Succeeded',
      observedAt: new Date().toISOString(),
      runtimeResult: {
        phase: 'Completed',
        result: { value: { output: 'ok', apiKey: 'sk-secret-value-12345678' } },
      },
    }]);
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeToolOperation: async () => ({}),
    });
    try {
      await store.create(
        actor,
        createToolOperationManifest('external-tool-result', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'execute',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: TOOL_OPERATION_API_VERSION, kind: TOOL_OPERATION_KIND, name: 'external-tool-result' }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(final?.status?.result).toEqual({ value: { output: 'ok', apiKey: '[REDACTED]' } });
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('rejects an external runtime result that violates the host output schema', async () => {
    const store = createStore();
    const driver = fakeDriver([{
      externalId: 'x',
      phase: 'Succeeded',
      observedAt: new Date().toISOString(),
      runtimeResult: {
        phase: 'Completed',
        result: { value: 42 },
      },
    }]);
    const capabilities = await driver.getCapabilities();
    capabilities.toolContracts![0].outputSchema = { type: 'string' };
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities }],
      pollIntervalMs: 1,
      authorizeToolOperation: async () => ({}),
    });
    try {
      await store.create(
        actor,
        createToolOperationManifest('external-tool-bad-result', {
          toolRef: { kind: 'Tool', name: 'render-game' },
          effect: 'execute',
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () =>
          store.get({
            apiVersion: TOOL_OPERATION_API_VERSION,
            kind: TOOL_OPERATION_KIND,
            name: 'external-tool-bad-result',
          }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.result?.error).toMatchObject({
        code: 'INVALID',
        message: expect.stringContaining('result does not match'),
      });
      expect(final?.status?.result?.value).toBeUndefined();
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('does not treat native success without a structured runtime result as loop success', async () => {
    const store = createStore();
    const driver = fakeDriver([]);
    driver.getWorkloadStatus = vi.fn(async () => ({
      externalId: 'x',
      phase: 'Succeeded',
      observedAt: new Date().toISOString(),
    }));
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
      authorizeWorkloadPlacement,
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('missing-runtime-result', {
          placement: { orchestrator: 'fake' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'missing-runtime-result' }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.lastRunResult).toContain('without a valid MEMELOOP_RESULT');
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('adopts persisted external identity after controller restart', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'adopted-1', phase: 'Succeeded', observedAt: new Date().toISOString() },
    ]);
    const created = await store.create(
      actor,
      createAgentWorkloadManifest('adopted', {
        placement: { orchestrator: 'fake' },
      }),
    );
    await store.updateStatus(actor, {
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      name: 'adopted',
    }, {
      phase: 'Running',
      assignedDriver: 'fake',
      assignedNode: 'worker-1',
      externalId: 'adopted-1',
    }, { resourceVersion: created.metadata.resourceVersion });

    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities: await driver.getCapabilities() }],
      pollIntervalMs: 1,
    });
    try {
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'adopted' }),
        (value) => value?.status?.phase === 'Completed',
      );
      expect(final?.status?.externalId).toBe('adopted-1');
      expect(driver.placeWorkload).not.toHaveBeenCalled();
      expect(driver.getWorkloadStatus).toHaveBeenCalledWith('adopted-1');
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('enforces the driver maxConcurrency before external placement', async () => {
    const store = createStore();
    const driver = fakeDriver([
      { externalId: 'x', phase: 'Running', observedAt: new Date().toISOString() },
    ]);
    const capabilities = { ...await driver.getCapabilities(), maxConcurrency: 1 };
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [{ name: 'fake', driver, capabilities }],
      pollIntervalMs: 1,
      authorizeWorkloadPlacement,
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('bounded-1', {
          placement: { orchestrator: 'fake' },
        }),
      );
      await store.create(
        actor,
        createAgentWorkloadManifest('bounded-2', {
          placement: { orchestrator: 'fake' },
        }),
      );
      await waitFor(
        async () => vi.mocked(driver.placeWorkload).mock.calls.length,
        (calls) => calls === 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(driver.placeWorkload).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
      await store.close();
    }
  });

  it('fails closed when the selected driver is absent', async () => {
    const store = createStore();
    const errors: unknown[] = [];
    const controller = createExternalOrchestrationController(store, {
      actor,
      drivers: [],
      onError: (error) => errors.push(error),
    });
    try {
      await store.create(
        actor,
        createAgentWorkloadManifest('missing-driver', {
          placement: { orchestrator: 'not-installed' },
        }),
      );
      const final = await waitFor(
        () => store.get({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND, name: 'missing-driver' }),
        (value) => value?.status?.phase === 'Failed',
      );
      expect(final?.status?.lastRunResult).toContain('not registered');
      expect(errors).toHaveLength(1);
    } finally {
      await controller.stop();
      await store.close();
    }
  });
});

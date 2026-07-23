import { describe, expect, it, vi } from 'vitest';

import type { ControlStoreActor } from '../controlStore.js';
import type { ExternalOrchestrationDriver, ExternalStatusResult } from '../drivers/externalDriver.js';
import { createExternalOrchestrationController } from '../externalOrchestrationController.js';
import {
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  createAgentWorkloadManifest,
  createToolOperationManifest,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
} from '../resources.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const actor: ControlStoreActor = { id: 'controller/external-test', kind: 'controller' };

function fakeDriver(statuses: ExternalStatusResult[]): ExternalOrchestrationDriver {
  let index = 0;
  return {
    getCapabilities: async () => ({
      name: 'fake',
      version: '1',
      manages: ['AgentWorkload', 'ToolOperation'],
      supportsColocation: true,
      supportsAdoption: true,
    }),
    placeWorkload: vi.fn(async (workload) => ({
      externalId: `external-${workload.metadata.uid}`,
      nodeName: 'worker-7',
      providerMetadata: { backend: 'fake' },
    })),
    getWorkloadStatus: vi.fn(async () => statuses[Math.min(index++, statuses.length - 1)]),
    stopWorkload: vi.fn(async () => {}),
    executeToolOperation: vi.fn(async (operation) => ({
      externalId: `external-${operation.metadata.uid}`,
      nodeName: 'worker-8',
    })),
    getToolOperationStatus: vi.fn(async () => statuses[Math.min(index++, statuses.length - 1)]),
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
      });
      expect(driver.placeWorkload).toHaveBeenCalledTimes(1);
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

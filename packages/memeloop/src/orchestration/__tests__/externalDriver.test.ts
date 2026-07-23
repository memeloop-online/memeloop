import { describe, expect, it } from 'vitest';

import type { ControlStoreActor } from '../controlStore.js';
import { parseExternalRuntimeResult } from '../drivers/externalDriver.js';
import type { ExternalDriverCapabilities, ExternalOrchestrationDriver, ExternalPlacementResult, ExternalStatusResult } from '../drivers/externalDriver.js';
import type { AgentWorkloadResource, ToolOperationResource } from '../resources.js';

/**
 * Minimal fake external driver for conformance testing.
 * Does not require Docker/K8s — returns synthetic responses.
 */
function createFakeExternalDriver(): ExternalOrchestrationDriver {
  const workloads = new Map<string, ExternalStatusResult>();
  const toolOps = new Map<string, ExternalStatusResult>();

  return {
    async getCapabilities(): Promise<ExternalDriverCapabilities> {
      return {
        name: 'fake-external-driver',
        version: '1.0.0',
        manages: ['AgentWorkload', 'ToolOperation'],
        supportsColocation: false,
        supportsAdoption: true,
        maxConcurrency: 10,
      };
    },

    async placeWorkload(workload: AgentWorkloadResource, _actor: ControlStoreActor): Promise<ExternalPlacementResult> {
      const externalId = `fake-workload-${workload.metadata.name}`;
      workloads.set(externalId, {
        externalId,
        phase: 'Running',
        observedAt: new Date().toISOString(),
      });
      return { externalId, nodeName: 'fake-node' };
    },

    async getWorkloadStatus(externalId: string): Promise<ExternalStatusResult> {
      const status = workloads.get(externalId);
      if (!status) throw new Error(`workload ${externalId} not found`);
      return status;
    },

    async stopWorkload(externalId: string, _actor: ControlStoreActor): Promise<void> {
      if (!workloads.has(externalId)) throw new Error(`workload ${externalId} not found`);
      workloads.delete(externalId);
    },

    async executeToolOperation(operation: ToolOperationResource, _actor: ControlStoreActor): Promise<ExternalPlacementResult> {
      const externalId = `fake-toolop-${operation.metadata.name}`;
      toolOps.set(externalId, {
        externalId,
        phase: 'Succeeded',
        observedAt: new Date().toISOString(),
      });
      return { externalId, nodeName: 'fake-node' };
    },

    async getToolOperationStatus(externalId: string): Promise<ExternalStatusResult> {
      const status = toolOps.get(externalId);
      if (!status) throw new Error(`tool operation ${externalId} not found`);
      return status;
    },

    async cancelToolOperation(externalId: string, _actor: ControlStoreActor): Promise<void> {
      if (!toolOps.has(externalId)) throw new Error(`tool operation ${externalId} not found`);
      toolOps.set(externalId, {
        externalId,
        phase: 'Failed',
        message: 'cancelled',
        observedAt: new Date().toISOString(),
      });
    },

    async listWorkloads(): Promise<ExternalStatusResult[]> {
      return Array.from(workloads.values());
    },

    async listToolOperations(): Promise<ExternalStatusResult[]> {
      return Array.from(toolOps.values());
    },

    async getHealth() {
      return { healthy: true, checkedAt: new Date().toISOString() };
    },
  };
}

function makeWorkloadResource(name: string): AgentWorkloadResource {
  return {
    apiVersion: 'orchestration.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
    spec: {
      loopRef: { apiVersion: 'orchestration.memeloop.io/v1alpha1', kind: 'AgentLoop', name: 'test-loop' },
      nodeSelector: { 'memeloop.io/role': 'worker' },
    },
  };
}

function makeToolOperationResource(name: string): ToolOperationResource {
  return {
    apiVersion: 'execution.memeloop.io/v1alpha1',
    kind: 'ToolOperation',
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
    spec: { toolRef: { kind: 'Tool', name: 'test-tool' }, effect: 'execute' },
  };
}

describe('ExternalOrchestrationDriver contract', () => {
  const driver = createFakeExternalDriver();
  const actor: ControlStoreActor = { id: 'test-actor', kind: 'controller' };

  it('reports capabilities with manages array', async () => {
    const caps = await driver.getCapabilities();
    expect(caps.name).toBeTruthy();
    expect(caps.manages).toContain('AgentWorkload');
    expect(caps.manages).toContain('ToolOperation');
    expect(typeof caps.supportsColocation).toBe('boolean');
    expect(caps.supportsAdoption).toBe(true);
  });

  it('places workload and returns external placement', async () => {
    const workload = makeWorkloadResource('test-workload');
    const result = await driver.placeWorkload(workload, actor);

    expect(result.externalId).toBeTruthy();
    expect(result.nodeName).toBeTruthy();
    expect(result.externalId).toContain('test-workload');
  });

  it('can get workload status after placement', async () => {
    const workload = makeWorkloadResource('status-test');
    const placed = await driver.placeWorkload(workload, actor);
    const status = await driver.getWorkloadStatus(placed.externalId);

    expect(status.externalId).toBe(placed.externalId);
    expect(status.phase).toBe('Running');
    expect(status.observedAt).toBeTruthy();
  });

  it('throws when getting status of unknown workload', async () => {
    await expect(driver.getWorkloadStatus('nonexistent')).rejects.toThrow('not found');
  });

  it('stops workload and removes it', async () => {
    const workload = makeWorkloadResource('stop-test');
    const placed = await driver.placeWorkload(workload, actor);

    await driver.stopWorkload(placed.externalId, actor);
    await expect(driver.getWorkloadStatus(placed.externalId)).rejects.toThrow('not found');
  });

  it('throws when stopping unknown workload', async () => {
    await expect(driver.stopWorkload('nonexistent', actor)).rejects.toThrow('not found');
  });

  it('executes tool operation and returns placement', async () => {
    const op = makeToolOperationResource('test-toolop');
    const result = await driver.executeToolOperation(op, actor);

    expect(result.externalId).toBeTruthy();
    expect(result.externalId).toContain('test-toolop');
  });

  it('can get tool operation status', async () => {
    const op = makeToolOperationResource('toolop-status');
    const placed = await driver.executeToolOperation(op, actor);
    const status = await driver.getToolOperationStatus(placed.externalId);

    expect(status.phase).toBe('Succeeded');
  });

  it('cancels tool operation', async () => {
    const op = makeToolOperationResource('toolop-cancel');
    const placed = await driver.executeToolOperation(op, actor);

    await driver.cancelToolOperation(placed.externalId, actor);
    const status = await driver.getToolOperationStatus(placed.externalId);

    expect(status.phase).toBe('Failed');
    expect(status.message).toBe('cancelled');
  });

  it('lists all workloads', async () => {
    const w1 = makeWorkloadResource('list-w1');
    const w2 = makeWorkloadResource('list-w2');
    await driver.placeWorkload(w1, actor);
    await driver.placeWorkload(w2, actor);

    const list = await driver.listWorkloads();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('lists all tool operations', async () => {
    const t1 = makeToolOperationResource('list-t1');
    const t2 = makeToolOperationResource('list-t2');
    await driver.executeToolOperation(t1, actor);
    await driver.executeToolOperation(t2, actor);

    const list = await driver.listToolOperations();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('reports health', async () => {
    const health = await driver.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.checkedAt).toBeTruthy();
  });

  it('parses the final structured runtime-result line only when its schema is valid', () => {
    expect(
      parseExternalRuntimeResult(
        `noise\n${String.fromCharCode(1)}MEMELOOP_RESULT {"phase":"Completed","summary":"old"}\nMEMELOOP_RESULT {"phase":"Completed","result":{"value":{"ok":true}}}\n`,
      ),
    )
      .toEqual({ phase: 'Completed', result: { value: { ok: true } } });
    expect(parseExternalRuntimeResult('MEMELOOP_RESULT {"phase":"unknown"}\n')).toBeUndefined();
    expect(
      parseExternalRuntimeResult(
        'MEMELOOP_RESULT {"phase":"Failed","error":{"code":"MADE_UP","message":"bad","retryable":false}}\n',
      ),
    ).toBeUndefined();
    expect(
      parseExternalRuntimeResult(
        'MEMELOOP_RESULT {"phase":"Completed","result":{"evidenceRef":42}}\n',
      ),
    ).toBeUndefined();
    expect(parseExternalRuntimeResult('MEMELOOP_RESULT not-json\n')).toBeUndefined();
    expect(parseExternalRuntimeResult('ordinary log line')).toBeUndefined();
  });
});

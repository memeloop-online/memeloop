import { describe, expect, it } from 'vitest';

import { OrchestrationError } from '../errors.js';
import { createRuntimeClassRoutingDriver, type LoopRunHandle, type LoopRunOutcome, type LoopRunStartRequest, type LoopRuntimeDriver } from '../loopRuntimeDriver.js';
import { AGENT_WORKLOAD_API_VERSION, AGENT_WORKLOAD_KIND, type AgentWorkloadResource } from '../resources.js';
import type { RuntimeClassSpec } from '../scripts/scriptRuntime.js';

function workloadResource(name: string, spec: AgentWorkloadResource['spec']): AgentWorkloadResource {
  return {
    apiVersion: AGENT_WORKLOAD_API_VERSION,
    kind: AGENT_WORKLOAD_KIND,
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec,
  };
}

function recordingDriver(tag: string): LoopRuntimeDriver & { started: LoopRunStartRequest[] } {
  const started: LoopRunStartRequest[] = [];
  const outcome: LoopRunOutcome = { phase: 'Completed', summary: tag };
  return {
    started,
    async start(request: LoopRunStartRequest): Promise<LoopRunHandle> {
      started.push(request);
      return { wait: async () => outcome, cancel: async () => {} };
    },
  };
}

const SCRIPT_REF = 'sha256:abc123';

describe('createRuntimeClassRoutingDriver', () => {
  it('routes process-isolation script workloads to the process driver', async () => {
    const inProcess = recordingDriver('in-process');
    const processDriver = recordingDriver('process');
    const driver = createRuntimeClassRoutingDriver({ inProcessDriver: inProcess, processDriver });
    const handle = await driver.start({
      workload: workloadResource('w1', { scriptReference: SCRIPT_REF, runtimeClass: 'trusted-process' }),
      run: {} as never,
    });
    expect(await handle.wait()).toEqual({ phase: 'Completed', summary: 'process' });
    expect(processDriver.started).toHaveLength(1);
    expect(inProcess.started).toHaveLength(0);
  });

  it('routes profile workloads to the in-process driver regardless of runtimeClass', async () => {
    const inProcess = recordingDriver('in-process');
    const processDriver = recordingDriver('process');
    const driver = createRuntimeClassRoutingDriver({ inProcessDriver: inProcess, processDriver });
    const handle = await driver.start({
      workload: workloadResource('w2', { profileId: 'profile-x', runtimeClass: 'trusted-process' }),
      run: {} as never,
    });
    expect(await handle.wait()).toEqual({ phase: 'Completed', summary: 'in-process' });
    expect(inProcess.started).toHaveLength(1);
    expect(processDriver.started).toHaveLength(0);
  });

  it('routes none-isolation classes to the in-process driver', async () => {
    const inProcess = recordingDriver('in-process');
    const processDriver = recordingDriver('process');
    const runtimeClasses: Record<string, RuntimeClassSpec> = {
      'open-class': {
        isolation: 'none',
        supportsCancellation: true,
        supportedTrustClasses: ['trusted'],
        networkAccess: 'full',
      },
    };
    const driver = createRuntimeClassRoutingDriver({ inProcessDriver: inProcess, processDriver, runtimeClasses });
    const handle = await driver.start({
      workload: workloadResource('w3', { scriptReference: SCRIPT_REF, runtimeClass: 'open-class' }),
      run: {} as never,
    });
    expect(await handle.wait()).toEqual({ phase: 'Completed', summary: 'in-process' });
  });

  it('fails closed when a process-isolation class has no process driver', async () => {
    const driver = createRuntimeClassRoutingDriver({ inProcessDriver: recordingDriver('in-process') });
    await expect(driver.start({
      workload: workloadResource('w4', { scriptReference: SCRIPT_REF, runtimeClass: 'trusted-process' }),
      run: {} as never,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('fails closed on an unknown RuntimeClass (no silent fallback)', async () => {
    const driver = createRuntimeClassRoutingDriver({
      inProcessDriver: recordingDriver('in-process'),
      processDriver: recordingDriver('process'),
    });
    const error = await driver.start({
      workload: workloadResource('w5', { scriptReference: SCRIPT_REF, runtimeClass: 'does-not-exist' }),
      run: {} as never,
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(OrchestrationError);
    expect((error as OrchestrationError).code).toBe('INVALID');
  });

  it('fails closed when a script workload has no runtimeClass', async () => {
    const driver = createRuntimeClassRoutingDriver({
      inProcessDriver: recordingDriver('in-process'),
      processDriver: recordingDriver('process'),
    });
    await expect(driver.start({
      workload: workloadResource('w6', { scriptReference: SCRIPT_REF }),
      run: {} as never,
    })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('fails closed on container isolation until a container driver exists', async () => {
    const runtimeClasses: Record<string, RuntimeClassSpec> = {
      'container-class': {
        isolation: 'container',
        supportsCancellation: true,
        supportedTrustClasses: ['trusted'],
        networkAccess: 'none',
      },
    };
    const driver = createRuntimeClassRoutingDriver({
      inProcessDriver: recordingDriver('in-process'),
      processDriver: recordingDriver('process'),
      runtimeClasses,
    });
    await expect(driver.start({
      workload: workloadResource('w7', { scriptReference: SCRIPT_REF, runtimeClass: 'container-class' }),
      run: {} as never,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('forwards cancel to the selected driver handle', async () => {
    let cancelled = false;
    const processDriver: LoopRuntimeDriver = {
      async start() {
        return {
          wait: async () => ({ phase: 'Cancelled' as const }),
          cancel: async () => {
            cancelled = true;
          },
        };
      },
    };
    const driver = createRuntimeClassRoutingDriver({ inProcessDriver: recordingDriver('in-process'), processDriver });
    const handle = await driver.start({
      workload: workloadResource('w8', { scriptReference: SCRIPT_REF, runtimeClass: 'restricted-process' }),
      run: {} as never,
    });
    await handle.cancel();
    expect(cancelled).toBe(true);
  });
});

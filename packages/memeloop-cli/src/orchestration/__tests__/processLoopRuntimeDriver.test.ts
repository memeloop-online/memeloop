import {
  type AgentRunResource,
  type AgentWorkloadResource,
  createRuntimeClassRoutingDriver,
  type LoopRunStartRequest,
  type ModelEndpointResource,
  type RuntimeClassSpec,
} from 'memeloop';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createProcessLoopRuntimeDriver } from '../processLoopRuntimeDriver.js';

function digestOf(source: string): string {
  const normalized = `${source.trim()}\n`;
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function workload(name: string, spec: AgentWorkloadResource['spec']): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: { name, namespace: 'default', uid: `uid-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec,
  } as AgentWorkloadResource;
}

function request(name: string, spec: AgentWorkloadResource['spec'], scriptSource: string): LoopRunStartRequest {
  return {
    workload: workload(name, spec),
    run: workload(name, spec) as never,
    scriptSource,
    message: 'hello',
  };
}

function modelRequest(name: string, scriptSource: string): LoopRunStartRequest {
  const base = request(name, {
    scriptReference: digestOf(scriptSource),
    runtimeClass: 'test-process',
    modelPolicy: { modelClass: 'chat' },
  }, scriptSource);
  base.workload.status = { assignedNode: 'worker-a' };
  const endpoint: ModelEndpointResource = {
    apiVersion: 'models.memeloop.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: {
      name: 'chat-worker-b',
      uid: 'endpoint-uid',
      generation: 1,
      resourceVersion: '3',
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
  base.modelEndpoint = endpoint;
  base.run = {
    apiVersion: 'run.memeloop.io/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name: `${name}-run`,
      uid: 'run-uid',
      generation: 1,
      resourceVersion: '4',
      creationTimestamp: '',
    },
    spec: {
      workloadRef: {
        apiVersion: base.workload.apiVersion,
        kind: base.workload.kind,
        name,
        uid: base.workload.metadata.uid,
      },
    },
    status: {
      phase: 'Pending',
      assignedModelEndpoint: {
        apiVersion: endpoint.apiVersion,
        kind: endpoint.kind,
        name: endpoint.metadata.name,
        uid: endpoint.metadata.uid,
      },
    },
  } satisfies AgentRunResource;
  return base;
}

const FAST_CLASS: Record<string, RuntimeClassSpec> = {
  'test-process': {
    isolation: 'process',
    cpuLimitMillis: 500,
    memoryLimitBytes: 128 * 1024 * 1024,
    timeLimitMs: 10_000,
    supportsCancellation: true,
    supportedTrustClasses: ['trusted'],
    networkAccess: 'full',
  },
};

function makeDriver(overrides: Parameters<typeof createProcessLoopRuntimeDriver>[0] = {}) {
  return createProcessLoopRuntimeDriver({
    runtimeClasses: FAST_CLASS,
    baseEnvironment: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    ...overrides,
  });
}

describe('createProcessLoopRuntimeDriver (Phase 4.2)', () => {
  it('executes a script in a child process and reports its summary', async () => {
    const source = 'export default async function* s(ctx) { yield { type: "message", data: "ok:" + ctx.input.message }; }';
    const driver = makeDriver();
    const handle = await driver.start(request('w-ok', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'ok:hello' });
  });

  it('strips inherited provider keys from the child environment (24.35)', async () => {
    const source = 'export default async function* s() { yield typeof process.env.STRIPE_API_KEY === "undefined" ? "clean" : "leaked:" + process.env.STRIPE_API_KEY; }';
    const driver = makeDriver({
      baseEnvironment: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        STRIPE_API_KEY: 'sk-live-should-never-reach-child',
      },
    });
    const handle = await driver.start(request('w-env', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'clean' });
  });

  it('passes non-secret spec.env and strips secret-shaped entries (24.14/24.35)', async () => {
    const source = 'export default async function* s() { yield process.env.MODE + "/" + String(process.env.PROVIDER_KEY); }';
    const driver = makeDriver();
    const handle = await driver.start(request(
      'w-specenv',
      {
        scriptReference: digestOf(source),
        runtimeClass: 'test-process',
        env: { MODE: 'service', PROVIDER_KEY: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      },
      source,
    ));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'service/undefined' });
  });

  it('fails closed when a model-bound process worker has no reachable gateway', async () => {
    const source = 'export default async function* s() { yield "unused"; }';
    const driver = makeDriver();
    await expect(driver.start(modelRequest('w-model-missing', source))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('consumes the selected endpoint through the host gateway resolver', async () => {
    const source = 'export default async function* s() { yield String(process.env.MEMELOOP_MODEL_GATEWAY); }';
    const driver = makeDriver({
      gatewayEndpointForModelEndpoint: async (endpoint) => `https://gateway.test/${endpoint.metadata.name}`,
    });
    const handle = await driver.start(modelRequest('w-model-routed', source));
    expect(await handle.wait()).toEqual({
      phase: 'Completed',
      summary: 'https://gateway.test/chat-worker-b',
    });
  });

  it('fails closed on a digest mismatch (end-to-end integrity)', async () => {
    const source = 'export default async function* s() { yield "tampered"; }';
    const driver = makeDriver();
    const handle = await driver.start(request(
      'w-digest',
      { scriptReference: `sha256:${'0'.repeat(64)}`, runtimeClass: 'test-process' },
      source,
    ));
    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Failed');
    expect(outcome.error?.code).toBe('INVALID');
    expect(outcome.error?.message).toContain('digest');
  });

  it('enforces the RuntimeClass wall-clock limit', async () => {
    const source = 'export default async function* s() { await new Promise(() => {}); }';
    const driver = makeDriver({
      runtimeClasses: { 'test-process': { ...FAST_CLASS['test-process'], timeLimitMs: 300 } },
      killGraceMs: 100,
    });
    const handle = await driver.start(request('w-timeout', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Failed');
    expect(outcome.error?.code).toBe('TIMEOUT');
  }, 15_000);

  it('cancel() terminates the child and reports Cancelled', async () => {
    const source = 'export default async function* s() { await new Promise(() => {}); }';
    const driver = makeDriver({ killGraceMs: 100 });
    const handle = await driver.start(request('w-cancel', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    await handle.cancel();
    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Cancelled');
  }, 15_000);

  it('reports script errors as Failed with the error message', async () => {
    const source = 'export default async function* s() { throw new Error("boom"); }';
    const driver = makeDriver();
    const handle = await driver.start(request('w-error', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome.phase).toBe('Failed');
    expect(outcome.error?.message).toContain('boom');
  });

  it('denies host-authority capabilities explicitly in the child', async () => {
    const source =
      'export default async function* s(ctx) { try { await ctx.runAgent({ profileId: "x" }); } catch (error) { yield "denied:" + /unavailable in the isolated process runtime/.test(error.message); } }';
    const driver = makeDriver();
    const handle = await driver.start(request('w-cap', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'denied:true' });
  });

  it('removes ambient fetch for networkAccess none classes', async () => {
    const source = 'export default async function* s() { yield String(typeof globalThis.fetch); }';
    const driver = makeDriver({
      runtimeClasses: { 'test-process': { ...FAST_CLASS['test-process'], networkAccess: 'none' } },
    });
    const handle = await driver.start(request('w-net', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'undefined' });
  });

  it('rejects workloads without a sha256 digest reference', async () => {
    const driver = makeDriver();
    await expect(driver.start(request('w-badref', { scriptReference: 'not-a-digest', runtimeClass: 'test-process' }, 'x')))
      .rejects.toMatchObject({ code: 'INVALID' });
  });

  it('rejects unknown runtime classes fail-closed', async () => {
    const driver = makeDriver();
    await expect(driver.start(request('w-badclass', { scriptReference: digestOf('export default async function* s() {}'), runtimeClass: 'nope' }, 'x')))
      .rejects.toMatchObject({ code: 'INVALID' });
  });

  it('routes through createRuntimeClassRoutingDriver by declared isolation', async () => {
    const source = 'export default async function* s(ctx) { yield "routed:" + ctx.input.message; }';
    const routed = makeDriver();
    let inProcessUsed = false;
    const driver = createRuntimeClassRoutingDriver({
      inProcessDriver: {
        async start() {
          inProcessUsed = true;
          return { wait: async () => ({ phase: 'Completed' as const, summary: 'in-process' }), cancel: async () => {} };
        },
      },
      processDriver: routed,
      runtimeClasses: FAST_CLASS,
    });
    const handle = await driver.start(request('w-routed', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'routed:hello' });
    expect(inProcessUsed).toBe(false);
  });
});

import {
  type AgentRunResource,
  type AgentWorkloadResource,
  BUILTIN_RUNTIME_CLASSES,
  type ControlStoreActor,
  createControlStoreLoopCheckpointStore,
  createRuntimeClassRoutingDriver,
  type LoopRunStartRequest,
  type LoopScriptCheckpointStore,
  type ModelEndpointResource,
  type NetworkAttachmentResource,
  type RuntimeClassSpec,
} from 'memeloop';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareLinuxProcessSandbox } from '../../sandbox/linuxProcessSandbox.js';
import { createProcessLoopRuntimeDriver } from '../processLoopRuntimeDriver.js';
import { SQLiteControlStore } from '../sqliteControlStore.js';

const directories: string[] = [];
const CHECKPOINT_ACTOR: ControlStoreActor = { id: 'controller/process-checkpoint-test', kind: 'controller' };

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function memoryCheckpointStore(): LoopScriptCheckpointStore {
  const values = new Map<string, unknown>();
  return {
    async saveCheckpoint(conversationId, key, value) {
      values.set(JSON.stringify([conversationId, key]), structuredClone(value));
    },
    async loadCheckpoint<T>(conversationId: string, key: string): Promise<T | undefined> {
      const value = values.get(JSON.stringify([conversationId, key]));
      return value === undefined ? undefined : structuredClone(value) as T;
    },
  };
}

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

function networkRequest(name: string, scriptSource: string): LoopRunStartRequest {
  const base = request(name, {
    scriptReference: digestOf(scriptSource),
    runtimeClass: 'test-process',
    networkPolicy: { networkClass: 'process-net', minimumEnforcement: 'process' },
  }, scriptSource);
  base.workload.status = { assignedNode: 'worker-a' };
  base.networkAttachment = {
    apiVersion: 'network.memeloop.io/v1alpha1',
    kind: 'NetworkAttachment',
    metadata: {
      name: `${name}-network`,
      uid: 'network-uid',
      generation: 1,
      resourceVersion: '3',
      creationTimestamp: '',
    },
    spec: {
      networkClassRef: {
        apiVersion: 'network.memeloop.io/v1alpha1',
        kind: 'NetworkClass',
        name: 'process-net',
      },
      nodeId: 'worker-a',
    },
    status: {
      phase: 'Attached',
      assignedNode: 'worker-a',
      assignedDriver: 'process-env',
      handle: 'procnet:1',
    },
  } satisfies NetworkAttachmentResource;
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
    checkpointStore: memoryCheckpointStore(),
    ...overrides,
  });
}

describe('createProcessLoopRuntimeDriver (Phase 4.2)', () => {
  it.runIf(process.platform === 'linux')(
    'runs the smallest built-in class under real OS resource and network isolation',
    async ({ skip }) => {
      const osSandbox = await prepareLinuxProcessSandbox();
      if (!osSandbox) skip();
      expect(osSandbox).toBeDefined();
      const source = [
        'export default async function* s() {',
        '  try { await fetch("http://127.0.0.1:9", { signal: AbortSignal.timeout(250) }); yield "network-open"; }',
        '  catch { yield "isolated"; }',
        '}',
      ].join('\n');
      const driver = createProcessLoopRuntimeDriver({
        runtimeClasses: BUILTIN_RUNTIME_CLASSES,
        osSandbox,
        checkpointStore: memoryCheckpointStore(),
      });
      const handle = await driver.start(request(
        'w-quarantine-linux',
        {
          scriptReference: digestOf(source),
          runtimeClass: 'quarantine-process',
        },
        source,
      ));
      expect(await handle.wait()).toEqual({ phase: 'Completed', summary: 'isolated' });
    },
    15_000,
  );

  it('executes a script in a child process and reports its summary', async () => {
    const source = 'export default async function* s(ctx) { yield { type: "message", data: "ok:" + ctx.input.message }; }';
    const driver = makeDriver();
    const handle = await driver.start(request('w-ok', { scriptReference: digestOf(source), runtimeClass: 'test-process' }, source));
    const outcome = await handle.wait();
    expect(outcome).toEqual({ phase: 'Completed', summary: 'ok:hello' });
  });

  it('runs profile agents through bounded inherited IPC without exposing host authority', async () => {
    const source = [
      'export default async function* s(ctx) {',
      '  const result = await ctx.runAgent({ profileId: "code", prompt: "build", conversationId: "child-1" });',
      '  yield { type: "message", data: result.text + "/" + typeof process.send };',
      '}',
    ].join('\n');
    const driver = makeDriver({
      runChildAgent: async function*(input) {
        expect(input).toEqual(expect.objectContaining({
          profileId: 'code',
          prompt: 'build',
          conversationId: 'child-1',
          signal: expect.any(AbortSignal),
        }));
        yield { type: 'message', data: 'child-result' };
      },
    });
    const handle = await driver.start(request(
      'w-child-agent',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ));
    expect(await handle.wait()).toEqual({
      phase: 'Completed',
      summary: 'child-result/undefined',
    });
  });

  it('restores durable checkpoint and state after cancellation, store restart, and worker migration', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-process-checkpoint-'));
    directories.push(directory);
    const filename = path.join(directory, 'control.db');
    let store = sqliteControlStore(filename);
    let persisted!: () => void;
    const persistedPromise = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const firstBackingStore = createControlStoreLoopCheckpointStore(store, CHECKPOINT_ACTOR);
    const observedStore: LoopScriptCheckpointStore = {
      async saveCheckpoint(conversationId, key, value, options) {
        await firstBackingStore.saveCheckpoint(conversationId, key, value, options);
        if (key === 'phase') persisted();
      },
      loadCheckpoint: (conversationId, key, options) => firstBackingStore.loadCheckpoint(conversationId, key, options),
      loadCheckpointRecord: (conversationId, key, options) => firstBackingStore.loadCheckpointRecord?.(conversationId, key, options),
    };
    const firstSource = [
      'export default async function s(ctx) {',
      '  const phase = await ctx.loadCheckpoint("phase");',
      '  if (phase) { const counter = await ctx.state.get("counter"); return String(counter) + "/" + phase.text + "/" + process.pid; }',
      '  await ctx.state.set("counter", 1);',
      '  await ctx.state.update("counter", (value) => value + 1);',
      '  await ctx.checkpoint("phase", { text: "draft-v1" });',
      '  await new Promise(() => {});',
      '}',
    ].join('\n');
    const first = await makeDriver({ checkpointStore: observedStore, killGraceMs: 50 }).start(request(
      'w-checkpoint-migrate',
      { scriptReference: digestOf(firstSource), runtimeClass: 'test-process' },
      firstSource,
    ));
    await persistedPromise;
    await first.cancel();
    await expect(first.wait()).resolves.toMatchObject({ phase: 'Cancelled' });
    await store.close();

    // A new ControlStore and a new driver spawn a distinct worker process but
    // derive the same run-scoped durable identity.
    store = sqliteControlStore(filename);
    const restoredStore = createControlStoreLoopCheckpointStore(store, CHECKPOINT_ACTOR);
    const secondSource = firstSource;
    const second = await makeDriver({ checkpointStore: restoredStore }).start(request(
      'w-checkpoint-migrate',
      { scriptReference: digestOf(secondSource), runtimeClass: 'test-process' },
      secondSource,
    ));
    const restored = await second.wait();
    expect(restored).toMatchObject({ phase: 'Completed' });
    expect(restored.summary).toMatch(/^2\/draft-v1\/\d+$/u);
    await store.close();
  }, 30_000);

  it('fences durable values by immutable run uid and generation, not retry policy', async () => {
    const checkpointStore = memoryCheckpointStore();
    const saveSource = 'export default async function s(ctx) { await ctx.checkpoint("done", "run-one"); }';
    await expect((await makeDriver({ checkpointStore }).start(request(
      'w-run-fence',
      { scriptReference: digestOf(saveSource), runtimeClass: 'test-process' },
      saveSource,
    ))).wait()).resolves.toMatchObject({ phase: 'Completed' });

    const loadSource = 'export default async function* s(ctx) { yield String((await ctx.loadCheckpoint("done")) || "missing"); }';
    const changedRun = request(
      'w-run-fence',
      { scriptReference: digestOf(loadSource), runtimeClass: 'test-process' },
      loadSource,
    );
    changedRun.run.metadata.uid = 'different-run-uid';
    await expect((await makeDriver({ checkpointStore }).start(changedRun)).wait())
      .resolves.toEqual({ phase: 'Completed', summary: 'missing' });

    const changedGeneration = request(
      'w-run-fence',
      { scriptReference: digestOf(loadSource), runtimeClass: 'test-process' },
      loadSource,
    );
    changedGeneration.run.metadata.generation += 1;
    await expect((await makeDriver({ checkpointStore }).start(changedGeneration)).wait())
      .resolves.toEqual({ phase: 'Completed', summary: 'missing' });

    const changedRetryPolicy = request(
      'w-run-fence',
      { scriptReference: digestOf(loadSource), runtimeClass: 'test-process' },
      loadSource,
    );
    changedRetryPolicy.run.spec.retry = 1;
    await expect((await makeDriver({ checkpointStore }).start(changedRetryPolicy)).wait())
      .resolves.toEqual({ phase: 'Completed', summary: 'missing' });
  }, 30_000);

  it('persists and resumes more than one hundred sequential checkpoints without a lifetime cap', async () => {
    const checkpointStore = memoryCheckpointStore();
    const source = [
      'export default async function* s(ctx) {',
      '  const restored = await ctx.loadCheckpoint("step:139");',
      '  if (restored) {',
      '    yield "restored:" + String(restored.index);',
      '    return;',
      '  }',
      '  for (let index = 0; index < 140; index += 1) {',
      '    await ctx.checkpoint("step:" + index, { index });',
      '  }',
      '  yield "saved";',
      '}',
    ].join('\n');
    const first = await makeDriver({ checkpointStore }).start(request(
      'w-many-checkpoints',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ));
    await expect(first.wait()).resolves.toEqual({ phase: 'Completed', summary: 'saved' });

    const resumed = await makeDriver({ checkpointStore }).start(request(
      'w-many-checkpoints',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ));
    await expect(resumed.wait()).resolves.toEqual({ phase: 'Completed', summary: 'restored:139' });
  }, 30_000);

  it('rejects non-canonical or oversized checkpoint values before durable storage', async () => {
    let writes = 0;
    const checkpointStore: LoopScriptCheckpointStore = {
      async saveCheckpoint() {
        writes += 1;
      },
      async loadCheckpoint() {
        return undefined;
      },
    };
    for (
      const [name, expression] of [
        ['oversized', '"x".repeat(512 * 1024 + 1)'],
        ['non-finite', 'Number.NaN'],
        ['sparse', 'Array(3)'],
        ['deceptive-to-json', '({ payload: "x".repeat(512 * 1024 + 1), toJSON() { return "small"; } })'],
      ]
    ) {
      const source = `export default async function s(ctx) { await ctx.checkpoint("${name}", ${expression}); }`;
      const handle = await makeDriver({ checkpointStore }).start(request(
        `w-checkpoint-${name}`,
        { scriptReference: digestOf(source), runtimeClass: 'test-process' },
        source,
      ));
      await expect(handle.wait()).resolves.toMatchObject({ phase: 'Failed' });
    }
    expect(writes).toBe(0);
  }, 30_000);

  it('rejects invalid identifiers and unbounded durable load responses', async () => {
    let reads = 0;
    let writes = 0;
    const checkpointStore: LoopScriptCheckpointStore = {
      async saveCheckpoint() {
        writes += 1;
      },
      async loadCheckpoint() {
        reads += 1;
        return 'x'.repeat(512 * 1024 + 1);
      },
    };
    for (
      const [suffix, keyExpression] of [
        ['control', '"bad\\nkey"'],
        ['nfd', '"e\\u0301"'],
        ['long', '"x".repeat(513)'],
      ]
    ) {
      const invalidKeySource = `export default async function s(ctx) { await ctx.checkpoint(${keyExpression}, "value"); }`;
      const invalidKey = await makeDriver({ checkpointStore }).start(request(
        `w-checkpoint-invalid-key-${suffix}`,
        { scriptReference: digestOf(invalidKeySource), runtimeClass: 'test-process' },
        invalidKeySource,
      ));
      await expect(invalidKey.wait()).resolves.toMatchObject({ phase: 'Failed' });
    }
    expect(writes).toBe(0);

    const loadSource = 'export default async function s(ctx) { await ctx.loadCheckpoint("large-result"); }';
    const load = await makeDriver({ checkpointStore }).start(request(
      'w-checkpoint-large-load',
      { scriptReference: digestOf(loadSource), runtimeClass: 'test-process' },
      loadSource,
    ));
    await expect(load.wait()).resolves.toMatchObject({ phase: 'Failed' });
    expect(reads).toBe(1);

    const invalidIdentity = request(
      'w-checkpoint-invalid-run',
      { scriptReference: digestOf(loadSource), runtimeClass: 'test-process' },
      loadSource,
    );
    invalidIdentity.run.metadata.uid = 'bad\nrun';
    await expect(makeDriver({ checkpointStore }).start(invalidIdentity))
      .rejects.toMatchObject({ code: 'INVALID' });
  }, 30_000);

  it('bounds child-side pending capability promises before parent admission', async () => {
    const releases: Array<() => void> = [];
    const checkpointStore: LoopScriptCheckpointStore = {
      async saveCheckpoint() {},
      async loadCheckpoint() {
        return new Promise<undefined>((resolve) => {
          releases.push(() => {
            resolve(undefined);
          });
        });
      },
    };
    const source = [
      'export default async function* s(ctx) {',
      '  const pending = [];',
      '  for (let index = 0; index < 9; index += 1) pending.push(ctx.loadCheckpoint("pending:" + index));',
      '  try { await Promise.all(pending); yield "unbounded"; }',
      '  catch (error) { yield /concurrency/.test(error.message) ? "bounded" : "wrong-error"; }',
      '}',
    ].join('\n');
    const handle = await makeDriver({ checkpointStore }).start(request(
      'w-checkpoint-pending-cap',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ));
    await expect(handle.wait()).resolves.toEqual({ phase: 'Completed', summary: 'bounded' });
    for (const release of releases) release();
    expect(releases).toHaveLength(8);
  }, 10_000);

  it('interrupts wait while a durable capability is blocked', async () => {
    let loadStarted!: () => void;
    const loadStartedPromise = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const checkpointStore: LoopScriptCheckpointStore = {
      async saveCheckpoint() {},
      async loadCheckpoint() {
        loadStarted();
        return new Promise<never>(() => {});
      },
    };
    const source = 'export default async function s(ctx) { await ctx.loadCheckpoint("blocked"); }';
    const handle = await makeDriver({ checkpointStore, killGraceMs: 50 }).start(request(
      'w-checkpoint-cancel',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ));
    await loadStartedPromise;
    await handle.cancel();
    await expect(Promise.race([
      handle.wait(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('cancel wait did not settle'));
        }, 2_000);
      }),
    ])).resolves.toMatchObject({ phase: 'Cancelled' });
  }, 10_000);

  it('fails closed before spawning when no durable checkpoint port is configured', async () => {
    const source = 'export default async function* s() { yield "unreachable"; }';
    const driver = createProcessLoopRuntimeDriver({
      runtimeClasses: FAST_CLASS,
      baseEnvironment: { PATH: process.env.PATH ?? '' },
    });
    await expect(driver.start(request(
      'w-checkpoint-required',
      { scriptReference: digestOf(source), runtimeClass: 'test-process' },
      source,
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
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

  it('consumes the prepared network environment in the isolated child', async () => {
    const source = 'export default async function* s() { yield String(process.env.HTTPS_PROXY) + "/" + String(process.env.NO_PROXY); }';
    const driver = makeDriver({
      environmentForNetworkAttachment: async (handle) =>
        handle === 'procnet:1'
          ? { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost' }
          : undefined,
    });
    const handle = await driver.start(networkRequest('w-network', source));
    expect(await handle.wait()).toEqual({
      phase: 'Completed',
      summary: 'http://proxy:8080/localhost',
    });
  });

  it('fails closed when a network policy has no consumable attachment', async () => {
    const source = 'export default async function* s() { yield "unused"; }';
    const missing = networkRequest('w-network-missing', source);
    delete missing.networkAttachment;
    await expect(makeDriver().start(missing)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('injects ephemeral volume mounts without persisting them on the Run', async () => {
    const source = 'export default async function* s() { yield process.env.MEMELOOP_VOLUME_DATA + "/" + process.env.MEMELOOP_VOLUME_DATA_READ_ONLY; }';
    const startRequest = request('w-volume', {
      scriptReference: digestOf(source),
      runtimeClass: 'test-process',
      storagePolicy: { volumes: [{ name: 'data', claimRef: 'claim-1' }] },
    }, source);
    startRequest.volumeMounts = [{
      name: 'data',
      mountPath: '/host/volume/opaque',
      readOnly: false,
    }];
    const handle = await makeDriver().start(startRequest);
    expect(await handle.wait()).toEqual({
      phase: 'Completed',
      summary: '/host/volume/opaque/false',
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
      'export default async function* s(ctx) { try { await ctx.runAgent({ profileId: "x" }); } catch (error) { yield "denied:" + /unavailable|policy/.test(error.message); } }';
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

function sqliteControlStore(filename: string): SQLiteControlStore {
  return new SQLiteControlStore({
    filename,
    pollIntervalMs: 1,
    authorizer: { authorize() {} },
  });
}

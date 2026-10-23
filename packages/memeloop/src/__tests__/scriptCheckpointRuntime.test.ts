import { describe, expect, it, vi } from 'vitest';

import { ProviderRegistry } from '../llm/providerRegistry.js';
import { createScriptCheckpointRuntime } from '../loopAPI/scriptCheckpointRuntime.js';
import {
  type AgentLoopGenerator,
  type AgentLoopStep,
  type LoopCheckpointRecord,
  type LoopProfile,
  type LoopScriptCheckpointBinding,
  type LoopScriptCheckpointStore,
  scopedLoopCheckpointKey,
} from '../loopAPI/types.js';
import type { ControlLeaseIdentity } from '../orchestration/controlStore.js';
import { MemoryAgentRunStateStore } from '../runState.js';
import { createAgentLoopScriptRunner, createMemeLoopRuntime, LoopCheckpointIdentityMismatchError } from '../runtime.js';
import type { AgentFrameworkContext } from '../types.js';
import { createTestStorage } from './testStorage.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) steps.push(step);
  return steps;
}

function checkpointStore(): LoopScriptCheckpointStore {
  const values = new Map<string, LoopCheckpointRecord>();
  const executionFences = new Map<string, ControlLeaseIdentity>();
  let nextFenceEpoch = 0;
  const storageKey = (conversationId: string, key: string, scope: Parameters<LoopScriptCheckpointStore['loadCheckpoint']>[2]) =>
    `${conversationId}:${scopedLoopCheckpointKey(key, scope?.scope)}`;
  const save = async (
    conversationId: string,
    key: string,
    result: unknown,
    expectedRevision: number | undefined,
    options: Parameters<NonNullable<LoopScriptCheckpointStore['compareAndSetCheckpoint']>>[4],
  ): Promise<LoopCheckpointRecord> => {
    const precondition = options?.leasePrecondition;
    if (precondition) {
      const currentFence = executionFences.get(precondition.name);
      if (
        !currentFence ||
        currentFence.holder !== precondition.holder ||
        currentFence.leaseId !== precondition.leaseId ||
        currentFence.epoch !== precondition.epoch
      ) throw new Error('checkpoint lease precondition failed');
    }
    const storedKey = storageKey(conversationId, key, options);
    const existing = values.get(storedKey);
    if (expectedRevision !== (existing?.revision)) {
      throw new Error('checkpoint compare-and-set conflict');
    }
    const fencingEpoch = options?.fencingEpoch ?? existing?.fencingEpoch ?? 0;
    if (fencingEpoch < (existing?.fencingEpoch ?? 0)) throw new Error('checkpoint stale fence');
    const record: LoopCheckpointRecord = {
      result: structuredClone(result),
      revision: (existing?.revision ?? 0) + 1,
      fencingEpoch,
      ...(options?.scope ? { scope: structuredClone(options.scope) } : {}),
    };
    values.set(storedKey, record);
    return structuredClone(record);
  };
  return {
    async saveCheckpoint(conversationId, key, result, options = {}) {
      const existing = values.get(storageKey(conversationId, key, options));
      await save(conversationId, key, result, options.expectedRevision ?? existing?.revision, options);
    },
    async loadCheckpoint<T>(conversationId: string, key: string, options) {
      const record = values.get(storageKey(conversationId, key, options));
      return record === undefined ? undefined : structuredClone(record.result) as T;
    },
    async loadCheckpointRecord<T>(conversationId, key, options) {
      const record = values.get(storageKey(conversationId, key, options));
      return record === undefined ? undefined : structuredClone(record) as LoopCheckpointRecord<T>;
    },
    async compareAndSetCheckpoint(conversationId, key, expectedRevision, result, options) {
      return save(conversationId, key, result, expectedRevision, options);
    },
    checkpointFenceStore: {
      async acquireCheckpointFence(runId, holder) {
        const name = `checkpoint-fence/${runId}`;
        if (executionFences.has(name)) throw new Error('checkpoint fence already held');
        const fence = {
          name,
          holder,
          leaseId: `checkpoint-fence-${nextFenceEpoch + 1}`,
          epoch: String(++nextFenceEpoch),
        };
        executionFences.set(name, fence);
        return fence;
      },
      async renewCheckpointFence(fence) {
        const current = executionFences.get(fence.name);
        if (!current || current.leaseId !== fence.leaseId || current.epoch !== fence.epoch) {
          throw new Error('checkpoint fence is stale');
        }
        return { ...current };
      },
      async releaseCheckpointFence(fence) {
        const current = executionFences.get(fence.name);
        if (current?.leaseId === fence.leaseId && current.epoch === fence.epoch) {
          executionFences.delete(fence.name);
        }
      },
    },
  };
}

function checkpointBinding(profileId: string, runId?: string): LoopScriptCheckpointBinding {
  return {
    accepted: true,
    identity: {
      id: 'shared-checkpoint',
      scriptVersion: '1',
      profileId,
      profileVersion: '1',
      scriptDigest: 'same-script-digest',
      apiVersion: 'loops.memeloop.io/v1alpha1',
      schemaVersion: '1',
      ...(runId ? { runId } : {}),
    },
  };
}

function context(loopCheckpoints: LoopScriptCheckpointStore): AgentFrameworkContext {
  return {
    storage: createTestStorage(),
    localNodeId: 'checkpoint-test-node',
    llmProvider: { name: 'checkpoint-test-provider', chat: vi.fn() },
    tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
    syncAdapters: [],
    network: { start: vi.fn(), stop: vi.fn() },
    loopCheckpoints,
    loopScriptPolicy: {
      allowSource: true,
      scriptLoadGate: {
        admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true, trustClass: 'trusted' }),
      },
    },
  };
}

function profile(source: string): LoopProfile {
  return {
    id: 'profile:checkpoint-test',
    name: 'Checkpoint test',
    description: 'Exercises durable script checkpoints.',
    loopId: 'agent-agent-loop',
    version: 'profile-v1',
    scriptReference: { kind: 'source', source, name: 'checkpoint-test.mjs' },
  };
}

const V1 = `
  export const checkpoint = { id: 'script-checkpoint-test', version: '1' };
  export default async function run(ctx) {
    const progress = await ctx.loadCheckpoint('progress');
    if (progress) { ctx.finish('resumed:' + progress.step); return; }
    await ctx.checkpoint('progress', { step: 1 });
    throw new Error('simulated process crash');
  }
`;

describe('script checkpoint runtime', () => {
  it('restores an accepted checkpoint after a fresh runner starts', async () => {
    const store = checkpointStore();
    const first = await createAgentLoopScriptRunner(context(store), profile(V1), 'checkpoint-conversation');
    expect(first).not.toBeNull();
    await expect(collect(first!({
      conversationId: 'checkpoint-conversation',
      message: 'resume me',
      runId: 'run:checkpoint',
    }))).rejects.toThrow('simulated process crash');

    const resumed = await createAgentLoopScriptRunner(context(store), profile(V1), 'checkpoint-conversation');
    const steps = await collect(resumed!({
      conversationId: 'checkpoint-conversation',
      message: 'resume me',
      runId: 'run:checkpoint',
    }));

    expect(steps).toContainEqual({ type: 'message', data: 'resumed:1' });
  });

  it('rejects a changed script checkpoint unless the script exports a migration', async () => {
    const store = checkpointStore();
    const first = await createAgentLoopScriptRunner(context(store), profile(V1), 'checkpoint-mismatch');
    await expect(collect(first!({
      conversationId: 'checkpoint-mismatch',
      message: 'resume me',
      runId: 'run:mismatch',
    }))).rejects.toThrow('simulated process crash');

    const changed = `
      export const checkpoint = { id: 'script-checkpoint-test', version: '2' };
      export default async function run(ctx) { await ctx.loadCheckpoint('progress'); }
    `;
    const resumed = await createAgentLoopScriptRunner(context(store), profile(changed), 'checkpoint-mismatch');
    await expect(collect(resumed!({
      conversationId: 'checkpoint-mismatch',
      message: 'resume me',
      runId: 'run:mismatch',
    }))).rejects.toBeInstanceOf(LoopCheckpointIdentityMismatchError);
  });

  it('migrates a changed checkpoint only through the explicit script converter', async () => {
    const store = checkpointStore();
    const first = await createAgentLoopScriptRunner(context(store), profile(V1), 'checkpoint-migrate');
    await expect(collect(first!({
      conversationId: 'checkpoint-migrate',
      message: 'resume me',
      runId: 'run:migrate',
    }))).rejects.toThrow('simulated process crash');

    const migrated = `
      export const checkpoint = {
        id: 'script-checkpoint-test',
        version: '2',
        migrate(previous) { return { step: previous.result.step + 1 }; },
      };
      export default async function run(ctx) {
        const progress = await ctx.loadCheckpoint('progress');
        ctx.finish('migrated:' + progress.step);
      }
    `;
    const resumed = await createAgentLoopScriptRunner(context(store), profile(migrated), 'checkpoint-migrate');
    const steps = await collect(resumed!({
      conversationId: 'checkpoint-migrate',
      message: 'resume me',
      runId: 'run:migrate',
    }));

    expect(steps).toContainEqual({ type: 'message', data: 'migrated:2' });
  });

  it('tracks migration independently for every durable checkpoint business key', async () => {
    const store = checkpointStore();
    const v1 = `
      export const checkpoint = { id: 'multi-key-checkpoint', version: '1' };
      export default async function run(ctx) {
        await ctx.checkpoint('first', { value: 1 });
        await ctx.checkpoint('second', { value: 2 });
        throw new Error('simulated process crash');
      }
    `;
    const first = await createAgentLoopScriptRunner(context(store), profile(v1), 'checkpoint-multi-key');
    await expect(collect(first!({
      conversationId: 'checkpoint-multi-key',
      message: 'resume me',
      runId: 'run:multi-key',
    }))).rejects.toThrow('simulated process crash');

    const v2 = `
      export const checkpoint = {
        id: 'multi-key-checkpoint',
        version: '2',
        migrate(previous) { return { value: previous.result.value + 10 }; },
      };
      export default async function run(ctx) {
        const first = await ctx.loadCheckpoint('first');
        const second = await ctx.loadCheckpoint('second');
        ctx.finish(first.value + ':' + second.value);
      }
    `;
    const resumed = await createAgentLoopScriptRunner(context(store), profile(v2), 'checkpoint-multi-key');
    const steps = await collect(resumed!({
      conversationId: 'checkpoint-multi-key',
      message: 'resume me',
      runId: 'run:multi-key',
    }));

    expect(steps).toContainEqual({ type: 'message', data: '11:12' });
  });

  it('repairs a migrated current-scope record before a later version migrates', async () => {
    const backing = checkpointStore();
    let failLatestPointer = false;
    const { compareAndSetCheckpoint: _compareAndSetCheckpoint, loadCheckpointRecord: _loadCheckpointRecord, ...legacyBacking } = backing;
    const store: LoopScriptCheckpointStore = {
      ...legacyBacking,
      async saveCheckpoint(conversationId, key, result, options) {
        if (failLatestPointer && key.startsWith('__memeloop_script_checkpoint_latest__:')) {
          failLatestPointer = false;
          throw new Error('simulated crash before latest pointer acknowledgement');
        }
        return backing.saveCheckpoint(conversationId, key, result, options);
      },
    };
    const first = await createAgentLoopScriptRunner(context(store), profile(V1), 'checkpoint-pointer-crash');
    await expect(collect(first!({
      conversationId: 'checkpoint-pointer-crash',
      message: 'resume me',
      runId: 'run:pointer-crash',
    }))).rejects.toThrow('simulated process crash');

    const migrated = `
      export const checkpoint = {
        id: 'script-checkpoint-test',
        version: '2',
        migrate(previous) { return { step: previous.result.step + 1 }; },
      };
      export default async function run(ctx) {
        const progress = await ctx.loadCheckpoint('progress');
        ctx.finish('migrated:' + progress.step);
      }
    `;
    failLatestPointer = true;
    const interrupted = await createAgentLoopScriptRunner(context(store), profile(migrated), 'checkpoint-pointer-crash');
    await expect(collect(interrupted!({
      conversationId: 'checkpoint-pointer-crash',
      message: 'resume me',
      runId: 'run:pointer-crash',
    }))).rejects.toThrow('simulated crash before latest pointer acknowledgement');

    const resumed = await createAgentLoopScriptRunner(context(store), profile(migrated), 'checkpoint-pointer-crash');
    const steps = await collect(resumed!({
      conversationId: 'checkpoint-pointer-crash',
      message: 'resume me',
      runId: 'run:pointer-crash',
    }));
    expect(steps).toContainEqual({ type: 'message', data: 'migrated:2' });

    const v3 = `
      export const checkpoint = {
        id: 'script-checkpoint-test',
        version: '3',
        migrate(previous) { return { step: previous.result.step + 10 }; },
      };
      export default async function run(ctx) {
        const progress = await ctx.loadCheckpoint('progress');
        ctx.finish('v3:' + progress.step);
      }
    `;
    const v3Runner = await createAgentLoopScriptRunner(context(store), profile(v3), 'checkpoint-pointer-crash');
    const v3Steps = await collect(v3Runner!({
      conversationId: 'checkpoint-pointer-crash',
      message: 'resume me',
      runId: 'run:pointer-crash',
    }));
    // The v3 converter must receive the repaired v2 result (2), rather than
    // following the stale v1 latest pointer (1) and silently skipping v2.
    expect(v3Steps).toContainEqual({ type: 'message', data: 'v3:12' });
  });

  it('rejects an in-flight checkpoint write after another execution lease takes over', async () => {
    const runState = new MemoryAgentRunStateStore();
    await runState.createOrGet({
      runId: 'run:checkpoint-fence',
      conversationId: 'checkpoint-fence-conversation',
      definitionId: 'profile:fenced',
      turnId: 'turn:checkpoint-fence',
      requestPeerId: 'peer:checkpoint-fence',
      requestId: 'request:checkpoint-fence',
      payloadDigest: 'digest:checkpoint-fence',
      state: 'running',
      acceptedAt: 1_000,
      updatedAt: 1_000,
      startedAt: 1_000,
    });
    const staleLease = await runState.claimExecution('run:checkpoint-fence', 'runtime:a', 1_000, 100);
    if (!staleLease) throw new Error('failed to claim initial execution lease');
    const currentLease = await runState.claimExecution('run:checkpoint-fence', 'runtime:b', 1_101, 100);
    if (!currentLease) throw new Error('failed to take over execution lease');

    const backing = checkpointStore();
    const writes = vi.fn();
    const store: LoopScriptCheckpointStore = {
      ...backing,
      async saveCheckpoint(...args) {
        writes();
        return backing.saveCheckpoint(...args);
      },
      async compareAndSetCheckpoint(...args) {
        writes();
        return backing.compareAndSetCheckpoint!(...args);
      },
    };
    const checkpoints = createScriptCheckpointRuntime({
      conversationId: 'checkpoint-fence-conversation',
      store,
      state: new Map(),
      locks: new Map(),
      records: new Map(),
      fencingEpoch: staleLease.fencingEpoch,
      leasePrecondition: () => undefined,
    });
    checkpoints.bindScriptCheckpoint?.(checkpointBinding('profile:fenced', 'run:checkpoint-fence'));

    await expect(checkpoints.checkpoint('must-not-exist', { stale: true })).rejects.toThrow('no longer current');
    expect(writes).not.toHaveBeenCalled();
    expect(currentLease.fencingEpoch).toBeGreaterThan(staleLease.fencingEpoch);
  });

  it('fences an in-flight script ctx.checkpoint when its atomic mutation lease is taken over', async () => {
    class TakeoverRunStateStore extends MemoryAgentRunStateStore {
      rejectOwnerId: string | undefined;

      override async renewExecution(...args: Parameters<MemoryAgentRunStateStore['renewExecution']>) {
        if (args[0].ownerId === this.rejectOwnerId) return undefined;
        return super.renewExecution(...args);
      }
    }
    const runStateStore = new TakeoverRunStateStore();
    const backing = checkpointStore();
    const backingFenceStore = backing.checkpointFenceStore!;
    let rejectCheckpointRenewal = false;
    let resolveMutationStarted!: () => void;
    const mutationStarted = new Promise<void>(resolve => {
      resolveMutationStarted = resolve;
    });
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>(resolve => {
      releaseMutation = resolve;
    });
    const committedCheckpointWrites = vi.fn();
    const store: LoopScriptCheckpointStore = {
      ...backing,
      checkpointFenceStore: {
        async acquireCheckpointFence(...args) {
          return backingFenceStore.acquireCheckpointFence(...args);
        },
        async renewCheckpointFence(fence, ttlMs) {
          if (rejectCheckpointRenewal && fence.holder === 'runtime:lease-fenced-a') {
            throw new Error('checkpoint execution fence was taken over');
          }
          return backingFenceStore.renewCheckpointFence(fence, ttlMs);
        },
        async releaseCheckpointFence(fence) {
          await backingFenceStore.releaseCheckpointFence(fence);
        },
      },
      async compareAndSetCheckpoint(...args) {
        if (args[1] !== 'after-takeover') return backing.compareAndSetCheckpoint!(...args);
        resolveMutationStarted();
        await mutationBlocked;
        const saved = await backing.compareAndSetCheckpoint!(...args);
        committedCheckpointWrites(args[4]?.leasePrecondition);
        return saved;
      },
    };
    const source = `
      export const checkpoint = { id: 'lease-fenced-script', version: '1' };
      export default async function run(ctx) {
        await ctx.checkpoint('after-takeover', { stale: true });
        ctx.finish('should not persist');
      }
    `;
    const storage = createTestStorage(undefined, {
      getAgentDefinition: vi.fn().mockResolvedValue({
        ...profile(source),
        id: 'profile:lease-fenced-script',
      }),
    });
    const provider = { name: 'lease-fenced-provider', chat: vi.fn() };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test:lease-fenced-provider', kind: 'host' },
      provider,
      { models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }] },
    );
    const runtime = createMemeLoopRuntime({
      storage,
      localNodeId: 'lease-fenced-node',
      runtimeId: 'runtime:lease-fenced-a',
      llmProvider: provider,
      modelProviderRegistry: providers,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      loopCheckpoints: store,
      loopScriptPolicy: {
        allowSource: true,
        scriptLoadGate: {
          admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true, trustClass: 'trusted' }),
        },
      },
    }, { runStateStore, executionLeaseMs: 100 });
    const handle = await runtime.sendMessage({
      conversationId: 'checkpoint-lease-takeover',
      definitionId: 'profile:lease-fenced-script',
      message: 'checkpoint after takeover',
    });
    await mutationStarted;

    // The write has already passed the runtime and adapter layers with A's
    // fence, but has not reached the store's atomic precondition yet. Let A
    // lose both leases, then install B's durable run and checkpoint fences.
    runStateStore.rejectOwnerId = 'runtime:lease-fenced-a';
    rejectCheckpointRenewal = true;
    await new Promise(resolve => setTimeout(resolve, 120));
    const takeover = await runStateStore.claimExecution(handle.runId, 'runtime:lease-fenced-b', Date.now(), 100);
    expect(takeover?.fencingEpoch).toBe(2);
    const checkpointTakeover = await store.checkpointFenceStore!.acquireCheckpointFence(
      handle.runId,
      'runtime:lease-fenced-b',
      100,
    );
    expect(checkpointTakeover.epoch).toBe('2');

    releaseMutation();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await runStateStore.get(handle.runId))?.state === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(committedCheckpointWrites).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('keeps parent and child profile state, locks, and record caches fully scoped', async () => {
    const store = checkpointStore();
    const state = new Map<string, unknown>();
    const locks = new Map<string, Promise<unknown>>();
    const records = new Map<string, LoopCheckpointRecord>();
    const parent = createScriptCheckpointRuntime({
      conversationId: 'shared-parent-child-conversation',
      store,
      state,
      locks,
      records,
    });
    const child = createScriptCheckpointRuntime({
      conversationId: 'shared-parent-child-conversation',
      store,
      state,
      locks,
      records,
    });
    parent.bindScriptCheckpoint?.(checkpointBinding('profile:parent'));
    child.bindScriptCheckpoint?.(checkpointBinding('profile:child'));

    await parent.state.set('shared', 'parent');
    await child.state.set('shared', 'child');
    await parent.checkpoint('shared', { owner: 'parent' });
    await child.checkpoint('shared', { owner: 'child' });

    await expect(parent.state.get<string>('shared')).resolves.toBe('parent');
    await expect(child.state.get<string>('shared')).resolves.toBe('child');
    await expect(parent.loadCheckpoint<{ owner: string }>('shared')).resolves.toEqual({ owner: 'parent' });
    await expect(child.loadCheckpoint<{ owner: string }>('shared')).resolves.toEqual({ owner: 'child' });
  });

  it('lets hosts wait for, observe, and acknowledge an accepted checkpoint', async () => {
    const loopCheckpoints = checkpointStore();
    const source = `
      export const checkpoint = { id: 'host-observable', version: '1' };
      export default async function run(ctx) {
        await ctx.checkpoint('ready', { completed: false });
        await ctx.checkpoint('ready', { completed: true });
        ctx.finish('done');
      }
    `;
    const storage = createTestStorage(undefined, {
      getAgentDefinition: vi.fn().mockResolvedValue({
        ...profile(source),
        id: 'profile:host-checkpoint',
      }),
    });
    const provider = { name: 'host-checkpoint-provider', chat: vi.fn() };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test:host-checkpoint-provider', kind: 'host' },
      provider,
      { models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }] },
    );
    const runtime = createMemeLoopRuntime({
      storage,
      localNodeId: 'host-checkpoint-node',
      llmProvider: provider,
      modelProviderRegistry: providers,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      loopCheckpoints,
      loopScriptPolicy: {
        allowSource: true,
        scriptLoadGate: {
          admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true, trustClass: 'trusted' }),
        },
      },
    }, { allowEphemeralRunState: true });
    const { conversationId } = await runtime.createAgent({ definitionId: 'profile:host-checkpoint' });
    const updates: string[] = [];
    const unsubscribe = runtime.subscribeToUpdates(conversationId, update => {
      updates.push(update.type);
    });
    const waiting = runtime.waitForCheckpoint({
      conversationId,
      checkpointId: 'host-observable',
      key: 'ready',
      timeoutMs: 1_000,
    });

    await runtime.sendMessage({ conversationId, definitionId: 'profile:host-checkpoint', message: 'checkpoint' });
    const accepted = await waiting;

    expect(accepted.checkpoint).toMatchObject({
      key: 'ready',
      result: { completed: false },
      identity: { id: 'host-observable', profileVersion: 'profile-v1' },
    });
    expect(updates).toContain('checkpoint-accepted');
    expect(runtime.ackCheckpoint(accepted)).toBe(true);
    expect(runtime.ackCheckpoint(accepted)).toBe(false);
    const newer = await runtime.waitForCheckpoint({
      conversationId,
      checkpointId: 'host-observable',
      key: 'ready',
      afterRevision: accepted.checkpoint.revision,
      timeoutMs: 1_000,
    });
    expect(newer.checkpoint).toMatchObject({ result: { completed: true } });
    expect(newer.checkpoint.revision).toBeGreaterThan(accepted.checkpoint.revision);
    expect(runtime.ackCheckpoint(newer)).toBe(true);
    await expect(runtime.waitForCheckpoint({
      conversationId,
      checkpointId: 'host-observable',
      key: 'ready',
      afterRevision: newer.checkpoint.revision,
      timeoutMs: 1,
    })).rejects.toThrow('checkpoint wait timed out');
    unsubscribe();
    await runtime.dispose();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ProviderRegistry } from '../llm/providerRegistry.js';
import { type AgentLoopGenerator, type AgentLoopStep, type LoopProfile, type LoopScriptCheckpointStore, scopedLoopCheckpointKey } from '../loopAPI/types.js';
import { createAgentLoopScriptRunner, createMemeLoopRuntime, LoopCheckpointIdentityMismatchError } from '../runtime.js';
import type { AgentFrameworkContext } from '../types.js';
import { createTestStorage } from './testStorage.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) steps.push(step);
  return steps;
}

function checkpointStore(): LoopScriptCheckpointStore {
  const values = new Map<string, unknown>();
  const storageKey = (conversationId: string, key: string, scope: Parameters<LoopScriptCheckpointStore['loadCheckpoint']>[2]) =>
    `${conversationId}:${scopedLoopCheckpointKey(key, scope?.scope)}`;
  return {
    async saveCheckpoint(conversationId, key, result, options) {
      values.set(storageKey(conversationId, key, options), structuredClone(result));
    },
    async loadCheckpoint<T>(conversationId: string, key: string, options) {
      const result = values.get(storageKey(conversationId, key, options));
      return result === undefined ? undefined : structuredClone(result) as T;
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

  it('lets hosts wait for, observe, and acknowledge an accepted checkpoint', async () => {
    const loopCheckpoints = checkpointStore();
    const source = `
      export const checkpoint = { id: 'host-observable', version: '1' };
      export default async function run(ctx) {
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
      result: { completed: true },
      identity: { id: 'host-observable', profileVersion: 'profile-v1' },
    });
    expect(updates).toContain('checkpoint-accepted');
    expect(runtime.ackCheckpoint(accepted)).toBe(true);
    expect(runtime.ackCheckpoint(accepted)).toBe(false);
    await expect(runtime.waitForCheckpoint({ conversationId, checkpointId: 'host-observable' }))
      .resolves.toEqual(accepted);
    unsubscribe();
    await runtime.dispose();
  });
});

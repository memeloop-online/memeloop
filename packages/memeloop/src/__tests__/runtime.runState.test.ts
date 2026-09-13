import { describe, expect, it, vi } from 'vitest';

import type { ConversationEvent } from '../conversation/index.js';
import { MemoryAgentRunStateStore } from '../runState.js';
import { createMemeLoopRuntime, type MemeLoopRunState, type MemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, FullAgentStorage } from '../types.js';
import { createTestStorage } from './testStorage.js';

function createContext(runAgentToolLoop?: AgentFrameworkContext['runAgentToolLoop']): {
  context: AgentFrameworkContext;
  events: ConversationEvent[];
} {
  const events: ConversationEvent[] = [];
  const storage: FullAgentStorage = createTestStorage({ events }, {
    upsertConversationMetadata: vi.fn().mockRejectedValue(new Error('snapshot writer must not be used')),
  });
  return {
    events,
    context: {
      storage,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn().mockResolvedValue('') },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop,
    },
  };
}

async function waitForState(
  runtime: MemeLoopRuntime,
  runId: string,
  state: MemeLoopRunState,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runtime.getRunStatus(runId))?.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${state}`);
}

describe('MemeLoopRuntime durable run state', () => {
  it('fails closed without an explicit durable or ephemeral run store', () => {
    const { context } = createContext();
    expect(() => createMemeLoopRuntime(context)).toThrow('requires a durable runStateStore');
  });

  it('returns a bounded handle and persists terminal status', async () => {
    const { context } = createContext(async function*() {
      yield { type: 'thinking', data: 'ok' };
    });
    const store = new MemoryAgentRunStateStore();
    const runtime = createMemeLoopRuntime(context, { runStateStore: store });
    const handle = await runtime.sendMessage({
      conversationId: 'conversation-1',
      message: 'hello',
      definitionId: 'definition-1',
      requestPeerId: 'peer-local',
      requestId: 'request-1',
      turnId: 'turn-1',
    });

    expect(handle).toMatchObject({
      conversationId: 'conversation-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      state: 'accepted',
    });
    await waitForState(runtime, handle.runId, 'completed');
    expect((await store.get(handle.runId))?.conversationId).toBe('conversation-1');
  });

  it('deduplicates retries and rejects request payload drift', async () => {
    const executed = vi.fn();
    const { context } = createContext(async function*() {
      executed();
      yield { type: 'thinking', data: 'ok' };
    });
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const request = {
      conversationId: 'conversation-1',
      message: 'hello',
      definitionId: 'definition-1',
      requestPeerId: 'peer-local',
      requestId: 'request-stable',
      turnId: 'turn-stable',
    };
    const first = await runtime.sendMessage(request);
    const second = await runtime.sendMessage(request);
    expect(second.runId).toBe(first.runId);
    await waitForState(runtime, first.runId, 'completed');
    expect(executed).toHaveBeenCalledTimes(1);
    await expect(runtime.sendMessage({ ...request, message: 'changed' })).rejects.toThrow(
      'payload drift',
    );
  });

  it('canonicalizes metadata key order and bounds payload hashing before acceptance', async () => {
    const { context } = createContext(async function*() {
      yield { type: 'thinking', data: 'ok' };
    });
    const runtime = createMemeLoopRuntime(context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });
    const base = {
      conversationId: 'conversation-canonical',
      message: 'hello',
      definitionId: 'definition-1',
      requestPeerId: 'peer-local',
      requestId: 'request-canonical',
      turnId: 'turn-canonical',
    };
    const first = await runtime.sendMessage({
      ...base,
      userMessage: {
        messageId: base.turnId,
        metadata: { z: 1, a: 2 },
      },
    });
    const replay = await runtime.sendMessage({
      ...base,
      userMessage: {
        messageId: base.turnId,
        metadata: { a: 2, z: 1 },
      },
    });
    expect(replay.runId).toBe(first.runId);

    await expect(runtime.sendMessage({
      ...base,
      requestId: 'request-oversized',
      turnId: 'turn-oversized',
      message: 'x'.repeat(1_048_577),
    })).rejects.toThrow('canonical_json_max_string_code_units');
  });

  it('does not overwrite cancellation with late completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { context } = createContext(async function*() {
      await gate;
      yield { type: 'thinking', data: 'late' };
    });
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const handle = await runtime.sendMessage({
      conversationId: 'conversation-cancel',
      message: 'wait',
      definitionId: 'definition-1',
      requestPeerId: 'peer-local',
      requestId: 'request-cancel',
      turnId: 'turn-cancel',
    });
    await waitForState(runtime, handle.runId, 'running');
    expect(await runtime.cancelRun(handle.runId)).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await runtime.getRunStatus(handle.runId))?.state).toBe('cancelled');
  });

  it('keeps an accepted record without a persisted turn replayable after restart', async () => {
    const store = new MemoryAgentRunStateStore();
    const now = Date.now();
    const active = await store.createOrGet({
      runId: 'old-run',
      conversationId: 'old-conversation',
      definitionId: 'definition-1',
      turnId: 'old-turn',
      requestPeerId: 'peer-local',
      requestId: 'old-request',
      payloadDigest: 'digest',
      state: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    });
    expect(active.state).toBe('accepted');
    const { context } = createContext();
    const runtime = createMemeLoopRuntime(context, { runStateStore: store });
    const recovered = await runtime.getRunStatus('old-run');
    expect(recovered).toMatchObject({ state: 'accepted' });
  });

  it('owns isolated registries and disposes only its own pending state', async () => {
    const runner = async function*() {
      yield { type: 'thinking' as const, data: 'ok' };
    };
    const first = createContext(runner);
    const second = createContext(runner);
    const firstRuntime = createMemeLoopRuntime(first.context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });
    const secondRuntime = createMemeLoopRuntime(second.context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    for (const context of [first.context, second.context]) {
      expect(context.loopRegistry).toBeUndefined();
      expect(context.hooks).toBeUndefined();
      expect(context.toolSchemas).toBeUndefined();
      expect(context.promptPlugins).toBeUndefined();
      expect(context.toolApprovals).toBeUndefined();
      expect(context.todoStore).toBeUndefined();
      expect(context.questionWaits).toBeUndefined();
    }

    await firstRuntime.dispose();
    await expect(secondRuntime.createAgent({
      definitionId: 'definition-2',
      conversationId: 'second-still-live',
    })).resolves.toEqual({ conversationId: 'second-still-live' });
    await secondRuntime.dispose();
  });
});

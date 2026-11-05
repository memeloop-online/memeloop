import { describe, expect, it, vi } from 'vitest';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentGoal, GoalClient } from '../../agent-management/goal.js';
import type { GoalRuntime, GoalStore } from '../../agent-management/goal.js';
import { GoalCoordinator } from '../../agent-management/GoalCoordinator.js';
import type { MemeLoopRunStatus, MemeLoopRuntime } from '../../runtime.js';
import { createAgentDeviceRpcClient } from '../agentDeviceRpcClient.js';
import { type AgentRuntimeRpcStorage, createAgentRuntimeDeviceRpcHandler } from '../agentRuntimeRpcHandler.js';
import { GOAL_RPC_METHODS } from '../goalRpc.js';

function fixture() {
  const goal: AgentGoal = {
    id: 'goal',
    conversationId: 'chat',
    definitionId: 'assistant',
    executionNodeId: 'desktop',
    objective: 'Finish the work',
    status: 'active',
    revision: 1,
    round: 0,
    updatedAt: new Date().toISOString(),
  };
  const goals: GoalClient = {
    get: vi.fn(async () => null),
    start: vi.fn(async () => goal),
    pause: vi.fn(async () => ({ ...goal, status: 'paused', revision: 2 })),
    resume: vi.fn(async () => ({ ...goal, revision: 3 })),
    complete: vi.fn(async () => ({ ...goal, status: 'completed', revision: 4, evidence: 'Verified' })),
  };
  const storage = createTestStorage();
  storage.state.conversations.set('chat', {
    conversationId: 'chat',
    definitionId: 'assistant',
    title: 'Chat',
    isUserInitiated: true,
    lastMessagePreview: '',
    lastMessageTimestamp: 0,
    messageCount: 0,
    originNodeId: 'desktop',
    originClock: 0,
  });
  const authorize = vi.fn(async () => true);
  const handler = createAgentRuntimeDeviceRpcHandler({
    storage: storage as AgentRuntimeRpcStorage,
    runtime: {} as MemeLoopRuntime,
    scheduledTaskHandler: vi.fn(),
    goals,
    localNodeId: 'desktop',
    authorize,
  });
  const client = createAgentDeviceRpcClient({
    peerId: 'desktop',
    sendRpc: (_peer, method, parameters) => handler({ remotePeerId: 'mobile', method, parameters }),
  });
  return { goals, client, handler, authorize, goal };
}

describe('goal RPC', () => {
  it('lets an authorized phone Stop pause the matching desktop goal and prevents continuation', async () => {
    vi.useFakeTimers();
    let saved: AgentGoal | null = null;
    const records = new Map<string, MemeLoopRunStatus>();
    const store: GoalStore = {
      get: async () => structuredClone(saved),
      save: async (goal, expected) => {
        if ((saved?.revision ?? null) !== expected) return false;
        saved = structuredClone(goal);
        return true;
      },
      listActive: async () => ({ items: saved?.status === 'active' ? [saved] : [] }),
    };
    const runtime: GoalRuntime = {
      sendMessage: vi.fn(async input => {
        const runId = 'run-goal';
        records.set(runId, {
          runId,
          conversationId: input.conversationId,
          definitionId: input.definitionId!,
          turnId: input.turnId!,
          requestId: input.requestId!,
          requestPeerId: input.requestPeerId!,
          payloadDigest: 'a'.repeat(64),
          state: 'running',
          acceptedAt: Date.now(),
          updatedAt: Date.now(),
        });
        return { runId, conversationId: input.conversationId, turnId: input.turnId!, requestId: input.requestId!, state: 'accepted' as const };
      }),
      getRunStatus: async id => records.get(id),
      cancelRun: vi.fn(async id => {
        const run = records.get(id);
        if (run?.state === 'cancelled') return false;
        if (run) records.set(id, { ...run, state: 'cancelled' });
        return true;
      }),
      subscribeToUpdates: () => () => {},
    };
    const coordinator = new GoalCoordinator({ store, executionNodeId: 'desktop', getRuntime: async () => runtime });
    const storage = createTestStorage();
    storage.state.conversations.set('chat', {
      conversationId: 'chat',
      definitionId: 'assistant',
      title: 'Chat',
      isUserInitiated: true,
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: 'desktop',
      originClock: 0,
    });
    const authorize = vi.fn(async () => true);
    const handler = createAgentRuntimeDeviceRpcHandler({
      storage: storage as AgentRuntimeRpcStorage,
      runtime: { ...runtime, createAgent: vi.fn() },
      scheduledTaskHandler: vi.fn(),
      goals: coordinator,
      localNodeId: 'desktop',
      authorize,
    });
    const client = createAgentDeviceRpcClient({
      peerId: 'desktop',
      sendRpc: (_peer, method, parameters) => handler({ remotePeerId: 'mobile', method, parameters }),
    });
    try {
      await client.goals.start({ conversationId: 'chat', definitionId: 'assistant', objective: 'Continue until verified.' });
      await vi.advanceTimersByTimeAsync(0);
      const result = await client.cancel({ runId: 'run-goal' });
      expect(result.ok).toBe(true);
      expect(result.status?.state).toBe('cancelled');
      expect((await client.goals.get('chat'))?.status).toBe('paused');
      await vi.advanceTimersByTimeAsync(5000);
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ permission: 'agent.cancel', conversationId: 'chat', definitionId: 'assistant' }));
      records.set('unrelated', { ...records.get('run-goal')!, runId: 'unrelated', requestId: 'other-request', state: 'running' });
      await expect(client.cancel({ runId: 'unrelated' })).rejects.toThrow('rpc_resource_not_found');
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('round-trips get/start/pause/resume/complete through actual clients and authorized handlers', async () => {
    const f = fixture();
    expect(await f.client.goals.get('chat')).toBeNull();
    const started = await f.client.goals.start({ conversationId: 'chat', definitionId: 'assistant', objective: 'Finish the work' });
    expect(started.status).toBe('active');
    expect((await f.client.goals.pause({ conversationId: 'chat', expectedRevision: 1 })).status).toBe('paused');
    expect((await f.client.goals.resume({ conversationId: 'chat', expectedRevision: 2 })).status).toBe('active');
    expect((await f.client.goals.complete({ conversationId: 'chat', expectedRevision: 3, evidence: 'Verified' })).status).toBe('completed');
    expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({
      method: GOAL_RPC_METHODS.pause,
      permission: 'agent.cancel',
      conversationId: 'chat',
      definitionId: 'assistant',
    }));
  });

  it('checks the real conversation definition before goal creation', async () => {
    const f = fixture();
    await expect(f.client.goals.start({ conversationId: 'chat', definitionId: 'other', objective: 'Work' }))
      .rejects.toThrow('rpc_resource_not_found');
    expect(f.goals.start).not.toHaveBeenCalled();
  });

  it('rejects responses for another conversation and malformed completion input', async () => {
    const f = fixture();
    vi.mocked(f.goals.get).mockResolvedValue({ ...f.goal, conversationId: 'other' });
    await expect(f.client.goals.get('chat')).rejects.toThrow('goal_rpc_conversation_mismatch');
    await expect(f.client.goals.complete({ conversationId: 'chat', expectedRevision: 1, evidence: '' })).rejects.toThrow('invalid_goal_rpc_text');
  });

  it('enforces the existing permission callback on control operations', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    await expect(f.client.goals.pause({ conversationId: 'chat', expectedRevision: 1 })).rejects.toThrow('rpc_permission_denied');
    expect(f.goals.pause).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunFailure, createAgentRunError } from '../../runState.js';
import type { MemeLoopRunStatus, MemeLoopRuntimeUpdate } from '../../runtime.js';
import type { AgentGoal, GoalRuntime, GoalStore } from '../goal.js';
import { GoalCoordinator, type GoalCoordinatorOptions } from '../GoalCoordinator.js';

class TestGoalStore implements GoalStore {
  readonly values = new Map<string, AgentGoal>();
  async get(conversationId: string) {
    return structuredClone(this.values.get(conversationId) ?? null);
  }
  async save(goal: AgentGoal, revision: number | null) {
    if ((this.values.get(goal.conversationId)?.revision ?? null) !== revision) return false;
    this.values.set(goal.conversationId, structuredClone(goal));
    return true;
  }
  async listActive(executionNodeId: string) {
    return { items: [...this.values.values()].filter(goal => goal.status === 'active' && goal.executionNodeId === executionNodeId) };
  }
}

function fixture(supportsGoal?: GoalCoordinatorOptions['supportsGoal']) {
  const store = new TestGoalStore();
  const records = new Map<string, MemeLoopRunStatus>();
  const listeners = new Set<(update: MemeLoopRuntimeUpdate) => void>();
  const runtime: GoalRuntime = {
    sendMessage: vi.fn(async input => {
      const runId = input.requestId!;
      if (!records.has(runId)) {
        records.set(runId, {
          runId,
          conversationId: input.conversationId,
          definitionId: input.definitionId!,
          requestId: input.requestId!,
          turnId: input.turnId!,
          requestPeerId: input.requestPeerId!,
          payloadDigest: input.message,
          state: 'running',
          acceptedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return { runId, conversationId: input.conversationId, turnId: input.turnId!, requestId: input.requestId!, state: 'accepted' as const };
    }),
    getRunStatus: vi.fn(async id => records.get(id)),
    cancelRun: vi.fn(async id => {
      const run = records.get(id);
      if (run) records.set(id, { ...run, state: 'cancelled' });
      return true;
    }),
    subscribeToUpdates: vi.fn((_id, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const errors = vi.fn();
  const makeCoordinator = () =>
    new GoalCoordinator({
      store,
      executionNodeId: 'desktop',
      getRuntime: async () => runtime,
      supportsGoal,
      idFactory: () => 'goal-1',
      onError: errors,
    });
  const coordinator = makeCoordinator();
  const current = async () => (await coordinator.get('chat'))!;
  const start = () => coordinator.start({ conversationId: 'chat', definitionId: 'agent', objective: 'Verify the deliverable' });
  const finish = (runId: string, state: MemeLoopRunStatus['state'] = 'completed') => {
    records.set(runId, { ...records.get(runId)!, state });
    for (const listener of listeners) listener({ type: 'agent-done', conversationId: 'chat', runId });
  };
  return { coordinator, makeCoordinator, store, records, runtime, current, start, finish, errors, listeners };
}

describe('GoalCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('rejects unsupported starts before persisting or scheduling a goal', async () => {
    const supportsGoal = vi.fn(async () => false);
    const f = fixture(supportsGoal);
    const save = vi.spyOn(f.store, 'save');
    await expect(f.start()).rejects.toThrow('goal_workflow_unsupported');
    expect(supportsGoal).toHaveBeenCalledWith({ conversationId: 'chat', definitionId: 'agent' });
    expect(save).not.toHaveBeenCalled();
    expect(await f.coordinator.get('chat')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('rechecks the stored workflow on resume while preserving read, pause and completion', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    const initial = await f.start();
    supportsGoal.mockResolvedValue(false);
    const paused = await f.coordinator.pause({ conversationId: 'chat', expectedRevision: initial.revision });
    expect(supportsGoal).toHaveBeenCalledTimes(1);
    await expect(f.coordinator.resume({ conversationId: 'chat', expectedRevision: paused.revision })).rejects.toThrow('goal_workflow_unsupported');
    expect(supportsGoal).toHaveBeenLastCalledWith({ conversationId: 'chat', definitionId: 'agent' });
    expect(await f.current()).toEqual(paused);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
    const completed = await f.coordinator.complete({ conversationId: 'chat', expectedRevision: paused.revision, evidence: 'Handled externally' });
    expect(completed.status).toBe('completed');
    expect(supportsGoal).toHaveBeenCalledTimes(2);
  });

  it('propagates capability lookup failures without changing a paused goal', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    const initial = await f.start();
    const paused = await f.coordinator.pause({ conversationId: 'chat', expectedRevision: initial.revision });
    supportsGoal.mockRejectedValue(new Error('script load denied'));
    await expect(f.coordinator.resume({ conversationId: 'chat', expectedRevision: paused.revision })).rejects.toThrow('script load denied');
    expect(await f.current()).toEqual(paused);
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('rechecks support when a resume write loses a revision race', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    const initial = await f.start();
    const paused = await f.coordinator.pause({ conversationId: 'chat', expectedRevision: initial.revision });
    supportsGoal.mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.spyOn(f.store, 'save').mockResolvedValueOnce(false);
    await expect(f.coordinator.resume({ conversationId: 'chat', expectedRevision: paused.revision })).rejects.toThrow('goal_workflow_unsupported');
    expect(supportsGoal).toHaveBeenCalledTimes(3);
    expect(await f.current()).toEqual(paused);
  });

  it('pauses an active goal when its workflow loses support before the first round', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    const initial = await f.start();
    supportsGoal.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.current()).toMatchObject({ status: 'paused', objective: initial.objective, round: 0 });
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.runtime.cancelRun).not.toHaveBeenCalled();
  });

  it('stops the next goal round without cancelling a running ordinary turn', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const initial = await f.current();
    await f.runtime.sendMessage({ conversationId: 'chat', definitionId: 'agent', requestId: 'ordinary', message: 'ordinary work' });
    supportsGoal.mockResolvedValue(false);
    f.finish(initial.pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.current()).toMatchObject({ status: 'paused', objective: initial.objective, round: 1 });
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect((await f.runtime.getRunStatus('ordinary'))?.state).toBe('running');
    expect(f.runtime.cancelRun).not.toHaveBeenCalled();
  });

  it('settles a recovered pending goal without replaying it or deleting evidence', async () => {
    const supportsGoal = vi.fn(async () => true);
    const f = fixture(supportsGoal);
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const initial = await f.current();
    await f.store.save({ ...initial, evidence: 'Earlier verified progress' }, initial.revision);
    f.coordinator.dispose();
    supportsGoal.mockResolvedValue(false);
    const reopened = f.makeCoordinator();
    await reopened.restore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.current()).toMatchObject({ status: 'paused', objective: initial.objective, pendingRound: initial.pendingRound, evidence: 'Earlier verified progress' });
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.runtime.cancelRun).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it('continues after three successful turns and stops only on explicit evidence-backed completion', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(f.runtime.sendMessage).mock.calls[0][0].message).toBe('Verify the deliverable');
    for (let index = 0; index < 3; index++) {
      const goal = await f.current();
      expect(goal.status).toBe('active');
      f.finish(goal.pendingRound!.runId!);
      await vi.advanceTimersByTimeAsync(250);
    }
    const goal = await f.current();
    expect(goal.round).toBe(4);
    await f.coordinator.completeFromRun('chat', goal.pendingRound!.runId!, 'The integration test and saved output agree.');
    f.finish(goal.pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await f.current()).status).toBe('completed');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(4);
    expect(f.listeners.size).toBe(0);
  });

  it('keeps one pending round during a long run', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect((await f.current()).round).toBe(1);
    f.coordinator.dispose();
  });

  it('lets pause win over stale completion and resumes with a new round identity', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const original = await f.current();
    const paused = await f.coordinator.pause({ conversationId: 'chat', expectedRevision: original.revision });
    await expect(f.coordinator.complete({ conversationId: 'chat', expectedRevision: original.revision, evidence: 'Old result' }))
      .rejects.toThrow('goal_revision_conflict');
    await expect(f.coordinator.completeFromRun('chat', original.pendingRound!.runId!, 'Old result')).rejects.toThrow('goal_run_is_stale');
    await f.coordinator.resume({ conversationId: 'chat', expectedRevision: paused.revision });
    await vi.advanceTimersByTimeAsync(1);
    const resumed = await f.current();
    expect(resumed.objective).toBe(original.objective);
    expect(resumed.pendingRound!.requestId).not.toBe(original.pendingRound!.requestId);
    await expect(f.coordinator.completeFromRun('chat', original.pendingRound!.runId!, 'Old result')).rejects.toThrow('goal_run_is_stale');
    f.coordinator.dispose();
  });

  it('restores an accepted round through the identical durable request instead of creating another execution', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const previous = await f.current();
    f.coordinator.dispose();
    const recovered = f.makeCoordinator();
    await recovered.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.records.size).toBe(1);
    expect((await f.current()).pendingRound).toEqual(previous.pendingRound);
    const calls = vi.mocked(f.runtime.sendMessage).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(f.runtime.cancelRun).not.toHaveBeenCalled();
    recovered.dispose();
  });

  it('restores a persisted round before dispatch with its saved prompt and request identity', async () => {
    const f = fixture();
    const initial = await f.start();
    f.coordinator.dispose();
    const pending = {
      ...initial,
      revision: initial.revision + 1,
      round: 1,
      pendingRound: { requestId: 'saved-request', turnId: 'saved-turn', message: 'Saved exact prompt' },
    };
    await f.store.save(pending, initial.revision);
    const recovered = f.makeCoordinator();
    await recovered.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining(pending.pendingRound));
    recovered.dispose();
  });

  it('restores a completed pending run and schedules its successor once', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const previous = await f.current();
    f.coordinator.dispose();
    f.finish(previous.pendingRound!.runId!);
    const recovered = f.makeCoordinator();
    await recovered.restore();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.records.size).toBe(2);
    expect((await f.current()).round).toBe(2);
    recovered.dispose();
  });

  it('cancels a run accepted while the user was pausing', async () => {
    const f = fixture();
    const send = f.runtime.sendMessage;
    let release!: () => void;
    f.runtime.sendMessage = vi.fn(async input => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return send(input);
    });
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const goal = await f.current();
    await f.coordinator.pause({ conversationId: 'chat', expectedRevision: goal.revision });
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.cancelRun).toHaveBeenCalledWith(goal.pendingRound!.requestId);
    expect((await f.current()).status).toBe('paused');
  });

  it('persists explicit blocked state and preserves the objective on resume', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const goal = await f.current();
    const blocked = await f.coordinator.blockFromRun('chat', goal.pendingRound!.runId!, 'Choose the destination workspace.');
    f.finish(goal.pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    await f.coordinator.resume({ conversationId: 'chat', expectedRevision: blocked.revision });
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.current()).objective).toBe(goal.objective);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(2);
    f.coordinator.dispose();
  });

  it('requires completion evidence and retains an active goal after an empty completion attempt', async () => {
    const f = fixture();
    const goal = await f.start();
    await expect(f.coordinator.complete({ conversationId: 'chat', expectedRevision: goal.revision, evidence: ' ' }))
      .rejects.toThrow('goal_evidence_required');
    expect((await f.current()).status).toBe('active');
    f.coordinator.dispose();
  });

  it('retries a transient failure after its durable backoff without filling the conversation queue', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const goal = await f.current();
    const runId = goal.pendingRound!.runId!;
    f.records.set(runId, {
      ...f.records.get(runId)!,
      error: createAgentRunError({ code: 'RATE_LIMITED', messageKey: 'agent.run.error.rateLimited', retryable: true }),
    });
    f.finish(runId, 'failed');
    await vi.advanceTimersByTimeAsync(59_999);
    const waiting = await f.current();
    expect(waiting.status).toBe('active');
    expect(waiting.lastRunError?.code).toBe('RATE_LIMITED');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(2);
    const retry = await f.current();
    f.finish(retry.pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.current()).lastRunError).toBeUndefined();
    f.coordinator.dispose();
  });

  it('keeps a non-retryable run failure as a structured blocked reason for all clients', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const goal = await f.current();
    const runId = goal.pendingRound!.runId!;
    f.records.set(runId, {
      ...f.records.get(runId)!,
      error: createAgentRunError({ code: 'PROVIDER_AUTH_MISSING', messageKey: 'agent.run.error.providerAuthMissing', retryable: false }),
    });
    f.finish(runId, 'failed');
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await f.current()).status).toBe('blocked');
    expect((await f.current()).lastRunError?.code).toBe('PROVIDER_AUTH_MISSING');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    f.coordinator.dispose();
  });

  it.each([false, true])('retries transient acceptance errors with the saved request identity (accepted: %s)', async accepted => {
    const f = fixture();
    const send = f.runtime.sendMessage;
    f.runtime.sendMessage = vi.fn(send).mockImplementationOnce(async input => {
      if (accepted) await send(input);
      throw new AgentRunFailure(createAgentRunError({ code: 'RATE_LIMITED', messageKey: 'agent.run.error.rateLimited', retryable: true }));
    });
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = await f.current();
    expect(waiting.status).toBe('active');
    expect(waiting.lastRunError?.code).toBe('RATE_LIMITED');
    expect(waiting.consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(f.runtime.sendMessage).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(f.records.size).toBe(1);
    expect((await f.current()).round).toBe(1);
    f.finish((await f.current()).pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.current()).lastRunError).toBeUndefined();
    f.coordinator.dispose();
  });

  it('blocks on a hard authentication error during acceptance', async () => {
    const f = fixture();
    vi.mocked(f.runtime.sendMessage).mockRejectedValueOnce(
      new AgentRunFailure(createAgentRunError({ code: 'PROVIDER_AUTH_MISSING', messageKey: 'agent.run.error.providerAuthMissing', retryable: false })),
    );
    await f.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await f.current()).status).toBe('blocked');
    expect((await f.current()).lastRunError?.code).toBe('PROVIDER_AUTH_MISSING');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    f.coordinator.dispose();
  });

  it('backs off a storage interruption before dispatch and then uses the original next round', async () => {
    const f = fixture();
    await f.start();
    vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('database busy'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.errors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect((await f.current()).round).toBe(1);
    f.coordinator.dispose();
  });

  it('accepts a displayed pause revision after ordinary round progress', async () => {
    const f = fixture();
    const displayed = await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = await f.current();
    f.finish(first.pendingRound!.runId!);
    await vi.advanceTimersByTimeAsync(250);
    expect((await f.current()).revision).toBeGreaterThan(displayed.revision);
    const paused = await f.coordinator.pause({ conversationId: 'chat', expectedRevision: displayed.revision });
    expect(paused.status).toBe('paused');
    expect(paused.controlRevision).toBe(paused.revision);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('drains orderly shutdown before storage closes and continues the objective on reopen', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = await f.current();
    await f.coordinator.suspend();
    expect(f.runtime.cancelRun).toHaveBeenCalledWith(before.pendingRound!.runId);
    const suspended = await f.current();
    expect(suspended.status).toBe('active');
    expect(suspended.pendingRound).toBeUndefined();
    const readsAfterClose = vi.spyOn(f.store, 'get').mockRejectedValue(new Error('database closed'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readsAfterClose).not.toHaveBeenCalled();
    readsAfterClose.mockRestore();
    const reopened = f.makeCoordinator();
    await reopened.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.current()).objective).toBe(before.objective);
    expect((await f.current()).round).toBe(2);
    reopened.dispose();
  });

  it('finishes a pending acceptance before cancelling and clearing it during suspend', async () => {
    const f = fixture();
    const send = f.runtime.sendMessage;
    let release!: () => void;
    f.runtime.sendMessage = vi.fn(async input => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return send(input);
    });
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const suspension = f.coordinator.suspend();
    release();
    await suspension;
    expect(f.runtime.cancelRun).toHaveBeenCalledTimes(1);
    expect((await f.current()).pendingRound).toBeUndefined();
    expect((await f.current()).status).toBe('active');
  });

  it('preserves a user pause racing with orderly shutdown', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const cancel = f.runtime.cancelRun;
    f.runtime.cancelRun = vi.fn(async runId => {
      const current = await f.current();
      await f.store.save({
        ...current,
        status: 'paused',
        revision: current.revision + 1,
        controlRevision: current.revision + 1,
      }, current.revision);
      return cancel(runId);
    });
    await f.coordinator.suspend();
    expect((await f.current()).status).toBe('paused');
    const reopened = f.makeCoordinator();
    await reopened.restore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    reopened.dispose();
  });

  it('pauses a conversation for close/delete even when its round has advanced', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    await f.coordinator.pauseConversation('chat');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.current()).status).toBe('paused');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('continues an active goal after runtime shutdown cancelled its saved pending run', async () => {
    const f = fixture();
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const goal = await f.current();
    f.coordinator.dispose();
    await f.runtime.cancelRun(goal.pendingRound!.runId!);
    const reopened = f.makeCoordinator();
    await reopened.restore();
    await vi.advanceTimersByTimeAsync(250);
    expect((await f.current()).status).toBe('active');
    expect((await f.current()).round).toBe(2);
    reopened.dispose();
  });
});

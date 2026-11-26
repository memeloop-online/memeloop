import { type AgentRunError, agentRunErrorFromUnknown } from '../runState.js';
import type { MemeLoopRunStatus } from '../runtime.js';
import type { AgentGoal, GoalClient, GoalClock, GoalMutation, GoalRuntime, GoalStore, GoalToolHost, StartGoalInput } from './goal.js';

export interface GoalCoordinatorOptions {
  store: GoalStore;
  executionNodeId: string;
  getRuntime(): Promise<GoalRuntime>;
  /** Resolve the currently selected workflow before starting or resuming a goal. */
  supportsGoal?: (input: { conversationId: string; definitionId: string }) => Promise<boolean>;
  clock?: GoalClock;
  idFactory?: () => string;
  continuationDelayMs?: number;
  onError?: (error: unknown) => void;
}

const systemClock: GoalClock = {
  now: () => new Date(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function requiredText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new Error(`goal_${field}_required`);
  return text;
}

/** Optional fields are absent on both direct RPC results and JSON-backed stores. */
function goalRecord(value: AgentGoal): AgentGoal {
  const goal = { ...value };
  for (const key of ['controlRevision', 'pendingRound', 'nextWakeAt', 'consecutiveFailures', 'lastRunError', 'evidence', 'blockedReason'] as const) {
    if (goal[key] === undefined) delete goal[key];
  }
  return goal;
}

/** Owns continuation timing; the existing durable runtime owns execution and crash replay. */
export class GoalCoordinator implements GoalClient, GoalToolHost {
  private readonly clock: GoalClock;
  private readonly operations = new Map<string, AbortController>();
  private readonly timers = new Map<string, unknown>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly acceptedRuns = new Map<string, string>();
  private stopped = false;

  constructor(private readonly options: GoalCoordinatorOptions) {
    this.clock = options.clock ?? systemClock;
  }

  get(conversationId: string): Promise<AgentGoal | null> {
    return this.options.store.get(conversationId);
  }

  async start(input: StartGoalInput): Promise<AgentGoal> {
    const previous = await this.get(input.conversationId);
    if (previous && previous.status !== 'completed') throw new Error('goal_already_exists');
    await this.assertGoalSupported(input);
    const goal: AgentGoal = {
      id: this.options.idFactory?.() ?? globalThis.crypto.randomUUID(),
      conversationId: input.conversationId,
      definitionId: input.definitionId,
      executionNodeId: this.options.executionNodeId,
      objective: requiredText(input.objective, 'objective'),
      status: 'active',
      revision: (previous?.revision ?? 0) + 1,
      controlRevision: (previous?.revision ?? 0) + 1,
      round: 0,
      updatedAt: this.clock.now().toISOString(),
    };
    if (!await this.options.store.save(goal, previous?.revision ?? null)) throw new Error('goal_revision_conflict');
    this.arm(goal);
    return goal;
  }

  async pause(input: GoalMutation): Promise<AgentGoal> {
    const goal = await this.mutate(input, current => {
      if (current.status === 'completed') throw new Error('goal_already_completed');
      return { ...current, status: 'paused', nextWakeAt: undefined };
    }, true);
    this.clearTimer(input.conversationId);
    this.operations.get(input.conversationId)?.abort();
    if (goal.pendingRound?.runId) await (await this.options.getRuntime()).cancelRun(goal.pendingRound.runId);
    this.acceptedRuns.delete(input.conversationId);
    return goal;
  }

  async resume(input: GoalMutation): Promise<AgentGoal> {
    const goal = await this.mutate(input, async current => {
      if (current.status !== 'paused' && current.status !== 'blocked') throw new Error('goal_resume_requires_paused_or_blocked');
      await this.assertGoalSupported(current);
      return { ...current, status: 'active', pendingRound: undefined, nextWakeAt: undefined, blockedReason: undefined, consecutiveFailures: 0, lastRunError: undefined };
    }, true);
    this.arm(goal);
    return goal;
  }

  complete(input: GoalMutation & { evidence: string }): Promise<AgentGoal> {
    return this.finishGoal(input, true);
  }

  private finishGoal(input: GoalMutation & { evidence: string }, allowRoundProgress: boolean): Promise<AgentGoal> {
    return this.mutate(input, current => ({
      ...current,
      status: 'completed',
      evidence: requiredText(input.evidence, 'evidence'),
      blockedReason: undefined,
      lastRunError: undefined,
      nextWakeAt: undefined,
    }), allowRoundProgress);
  }

  block(input: GoalMutation & { reason: string }): Promise<AgentGoal> {
    return this.mutate(input, current => ({
      ...current,
      status: 'blocked',
      blockedReason: requiredText(input.reason, 'reason'),
      lastRunError: undefined,
      nextWakeAt: undefined,
    }));
  }

  async completeFromRun(conversationId: string, runId: string, evidence: string): Promise<AgentGoal> {
    const goal = await this.goalForRun(conversationId, runId);
    return this.finishGoal({ conversationId, expectedRevision: goal.revision, evidence }, false);
  }

  async blockFromRun(conversationId: string, runId: string, reason: string): Promise<AgentGoal> {
    const goal = await this.goalForRun(conversationId, runId);
    return this.block({ conversationId, expectedRevision: goal.revision, reason });
  }

  async restore(): Promise<void> {
    this.stopped = false;
    let cursor: string | undefined;
    do {
      const page = await this.options.store.listActive(this.options.executionNodeId, cursor);
      for (const goal of page.items) this.arm(goal);
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** Release local observers; persisted active rounds remain available for runtime recovery. */
  dispose(): void {
    this.stopped = true;
    for (const conversationId of this.timers.keys()) this.clearTimer(conversationId);
    for (const operation of this.operations.values()) operation.abort();
  }

  /** Orderly host shutdown. Call before disposing the runtime or closing its database. */
  async suspend(): Promise<void> {
    this.dispose();
    await Promise.all(this.tasks);
    let cursor: string | undefined;
    do {
      const page = await this.options.store.listActive(this.options.executionNodeId, cursor);
      for (const snapshot of page.items) {
        const requestId = snapshot.pendingRound?.requestId;
        if (!requestId) continue;
        const runId = snapshot.pendingRound?.runId ?? this.acceptedRuns.get(snapshot.conversationId);
        if (!runId) continue;
        await (await this.options.getRuntime()).cancelRun(runId);
        // A pause/completion/new goal performed during shutdown owns the latest state.
        const current = await this.get(snapshot.conversationId);
        if (current?.id !== snapshot.id || current.status !== 'active' || current.pendingRound?.requestId !== requestId) continue;
        await this.options.store.save(
          goalRecord({
            ...current,
            revision: current.revision + 1,
            pendingRound: undefined,
            nextWakeAt: undefined,
            updatedAt: this.clock.now().toISOString(),
          }),
          current.revision,
        );
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.acceptedRuns.clear();
  }

  /** Close/delete controls stop the current conversation goal, even during round bookkeeping. */
  async pauseConversation(conversationId: string): Promise<AgentGoal | null> {
    for (;;) {
      const current = await this.get(conversationId);
      if (!current || current.status === 'paused' || current.status === 'completed') return current;
      try {
        return await this.pause({ conversationId, expectedRevision: current.revision });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'goal_revision_conflict') throw error;
      }
    }
  }

  private async goalForRun(conversationId: string, runId: string): Promise<AgentGoal> {
    const runtime = await this.options.getRuntime();
    const run = await runtime.getRunStatus(runId);
    const goal = await this.get(conversationId);
    if (!goal || goal.status !== 'active' || run?.conversationId !== conversationId || run.requestId !== goal.pendingRound?.requestId) {
      throw new Error('goal_run_is_stale');
    }
    return goal;
  }

  /** Runtime recovery can check without recursively opening or cancelling the runtime. */
  async prepareRound(conversationId: string, requestId: string): Promise<boolean> {
    const goal = await this.get(conversationId);
    if (!goal || goal.status !== 'active' || goal.pendingRound?.requestId !== requestId) return false;
    return this.prepareSupportedRound(goal);
  }

  private async prepareSupportedRound(goal: AgentGoal): Promise<boolean> {
    if (this.options.supportsGoal && !await this.options.supportsGoal({ conversationId: goal.conversationId, definitionId: goal.definitionId })) {
      await this.mutate({ conversationId: goal.conversationId, expectedRevision: goal.revision }, current => ({
        ...current,
        status: 'paused',
        nextWakeAt: undefined,
      }));
      return false;
    }
    return true;
  }

  private async assertGoalSupported(input: { conversationId: string; definitionId: string }): Promise<void> {
    if (this.options.supportsGoal && !await this.options.supportsGoal({ conversationId: input.conversationId, definitionId: input.definitionId })) {
      throw new Error('goal_workflow_unsupported');
    }
  }

  private async mutate(input: GoalMutation, transform: (goal: AgentGoal) => AgentGoal | Promise<AgentGoal>, allowRoundProgress = false): Promise<AgentGoal> {
    for (;;) {
      const current = await this.get(input.conversationId);
      if (!current || current.executionNodeId !== this.options.executionNodeId) throw new Error('goal_not_found');
      const minimumRevision = allowRoundProgress ? current.controlRevision ?? current.revision : current.revision;
      if (input.expectedRevision < minimumRevision || input.expectedRevision > current.revision) throw new Error('goal_revision_conflict');
      const transformed = await transform(current);
      const updated = goalRecord({
        ...transformed,
        revision: current.revision + 1,
        ...(transformed.status === current.status ? {} : { controlRevision: current.revision + 1 }),
        updatedAt: this.clock.now().toISOString(),
      });
      if (await this.options.store.save(updated, current.revision)) {
        if (updated.status !== 'active') this.clearTimer(updated.conversationId);
        return updated;
      }
      if (!allowRoundProgress) throw new Error('goal_revision_conflict');
    }
  }

  private clearTimer(conversationId: string): void {
    const timer = this.timers.get(conversationId);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(conversationId);
  }

  private arm(goal: AgentGoal, minimumDelay = 0): void {
    if (
      this.stopped || goal.status !== 'active' || goal.executionNodeId !== this.options.executionNodeId ||
      this.operations.has(goal.conversationId) || this.timers.has(goal.conversationId)
    ) return;
    const delay = Math.max(minimumDelay, goal.nextWakeAt ? Date.parse(goal.nextWakeAt) - this.clock.now().getTime() : 0);
    this.timers.set(
      goal.conversationId,
      this.clock.setTimeout(() => {
        this.timers.delete(goal.conversationId);
        const operation = new AbortController();
        this.operations.set(goal.conversationId, operation);
        let retryDelay = 0;
        const task = this.runRound(goal.conversationId, operation.signal)
          .catch((error: unknown) => {
            if (!operation.signal.aborted) {
              retryDelay = 60_000;
              this.options.onError?.(error);
            }
          })
          .finally(async () => {
            this.operations.delete(goal.conversationId);
            if (this.stopped) return;
            try {
              const latest = await this.get(goal.conversationId);
              if (latest) this.arm(latest, retryDelay);
            } catch (error) {
              this.options.onError?.(error);
            }
          });
        this.tasks.add(task);
        void task.finally(() => {
          this.tasks.delete(task);
        });
      }, delay),
    );
  }

  private recordFailure(goal: AgentGoal, error: AgentRunError, retainPending: boolean): Promise<AgentGoal> {
    const failures = (goal.consecutiveFailures ?? 0) + 1;
    return this.mutate({ conversationId: goal.conversationId, expectedRevision: goal.revision }, current => ({
      ...current,
      status: error.retryable ? 'active' : 'blocked',
      pendingRound: error.retryable && !retainPending ? undefined : current.pendingRound,
      consecutiveFailures: failures,
      lastRunError: error,
      nextWakeAt: error.retryable
        ? new Date(this.clock.now().getTime() + Math.min(60_000 * 2 ** (failures - 1), 3_600_000)).toISOString()
        : undefined,
    }));
  }

  private async runRound(conversationId: string, signal: AbortSignal): Promise<void> {
    let goal = await this.get(conversationId);
    if (!goal || goal.status !== 'active') return;
    signal.throwIfAborted();
    if (!await this.prepareSupportedRound(goal)) return;
    signal.throwIfAborted();
    if (!goal.pendingRound) {
      const round = goal.round + 1;
      goal = await this.mutate({ conversationId, expectedRevision: goal.revision }, current => ({
        ...current,
        round,
        pendingRound: {
          requestId: `goal:${current.id}:${round}:request`,
          turnId: `goal:${current.id}:${round}:turn`,
          message: current.objective,
        },
        nextWakeAt: undefined,
      }));
    }
    const pending = goal.pendingRound!;
    const runtime = await this.options.getRuntime();
    signal.throwIfAborted();
    if (!await this.prepareRound(conversationId, pending.requestId)) return;
    signal.throwIfAborted();
    try {
      const handle = await runtime.sendMessage({
        conversationId,
        definitionId: goal.definitionId,
        requestPeerId: goal.executionNodeId,
        requestId: pending.requestId,
        turnId: pending.turnId,
        message: pending.message,
      });
      this.acceptedRuns.set(conversationId, handle.runId);
      if (signal.aborted) {
        if (!this.stopped) {
          await runtime.cancelRun(handle.runId);
          this.acceptedRuns.delete(conversationId);
        }
        return;
      }
      const cancel = () => {
        if (!this.stopped) {
          void runtime.cancelRun(handle.runId).catch((error: unknown) => {
            this.options.onError?.(error);
          });
        }
      };
      signal.addEventListener('abort', cancel, { once: true });
      let terminal: MemeLoopRunStatus;
      try {
        const latest = await this.get(conversationId);
        if (latest?.status === 'active' && latest.pendingRound?.requestId === pending.requestId && latest.pendingRound.runId !== handle.runId) {
          await this.mutate({ conversationId, expectedRevision: latest.revision }, current => ({
            ...current,
            pendingRound: { ...pending, runId: handle.runId },
          }));
        }
        terminal = await waitForGoalRun(runtime, conversationId, handle.runId, signal);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      this.acceptedRuns.delete(conversationId);
      const current = await this.get(conversationId);
      if (!current || current.status !== 'active' || current.pendingRound?.requestId !== pending.requestId) return;
      if (terminal.state !== 'completed' && terminal.state !== 'cancelled') {
        await this.recordFailure(current, terminal.error ?? agentRunErrorFromUnknown(new Error(terminal.state)), false);
        return;
      }
      await this.mutate({ conversationId, expectedRevision: current.revision }, value => ({
        ...value,
        pendingRound: undefined,
        consecutiveFailures: 0,
        lastRunError: undefined,
        nextWakeAt: new Date(this.clock.now().getTime() + (this.options.continuationDelayMs ?? 250)).toISOString(),
      }));
    } catch (error) {
      if (signal.aborted) return;
      const current = await this.get(conversationId);
      if (current?.status === 'active' && current.pendingRound?.requestId === pending.requestId) {
        this.options.onError?.(error);
        // Acceptance can succeed before the caller observes the result; replay the same request.
        await this.recordFailure(current, agentRunErrorFromUnknown(error), true);
      } else {
        this.options.onError?.(error);
      }
    }
  }
}

/** Subscribe before reading, so a terminal transition between acceptance and observation is retained. */
export function waitForGoalRun(runtime: GoalRuntime, conversationId: string, runId: string, signal: AbortSignal): Promise<MemeLoopRunStatus> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let checking = false;
    let dirty = false;
    let settled = false;
    const cleanup = () => {
      settled = true;
      unsubscribe();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('goal_observation_cancelled'));
    };
    const check = async () => {
      dirty = true;
      if (checking || settled) return;
      checking = true;
      try {
        while (dirty && !settled) {
          dirty = false;
          const status = await runtime.getRunStatus(runId);
          if (!status) throw new Error('goal_run_not_found');
          if (status.state === 'completed' || status.state === 'failed' || status.state === 'cancelled') {
            cleanup();
            resolve(status);
          }
        }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    };
    unsubscribe = runtime.subscribeToUpdates(conversationId, update => {
      if ('runId' in update && update.runId === runId) void check();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else void check();
  });
}

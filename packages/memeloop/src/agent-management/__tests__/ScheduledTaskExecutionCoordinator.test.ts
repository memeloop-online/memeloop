import { describe, expect, it, vi } from 'vitest';

import { ScheduledTaskExecutionCoordinator } from '../ScheduledTaskExecutionCoordinator.js';
import type { ScheduledTaskExecutionClock, ScheduledTaskExecutionPatch, ScheduledTaskExecutionStore } from '../ScheduledTaskExecutionCoordinator.js';
import type { ScheduledTask } from '../types.js';

class FakeClock implements ScheduledTaskExecutionClock {
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  constructor(private current: number) {}

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, { due: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const target = this.current + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      this.current = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.current = target;
  }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    agentInstanceId: 'conversation-1',
    agentDefinitionId: 'definition-1',
    name: 'Scheduled task',
    schedule: { kind: 'at', wakeAtISO: '2026-01-01T00:00:00.000Z' },
    payload: { message: 'hello' },
    enabled: true,
    state: 'active',
    executionNodeId: 'peer-local',
    originNodeId: 'peer-remote',
    ...overrides,
  };
}

function store(initial: ScheduledTask[]) {
  const tasks = new Map(initial.map(item => [item.id, item]));
  const updates: Array<{ taskId: string; patch: ScheduledTaskExecutionPatch }> = [];
  const executionStore: ScheduledTaskExecutionStore = {
    async listRunnablePage(options) {
      const items = [...tasks.values()].filter(item =>
        item.executionNodeId === options.executionNodeId &&
        item.state === 'active' && item.enabled
      );
      return { items: items.slice(0, options.limit), hasMoreAfter: false };
    },
    async updateExecution(identity, patch, options) {
      const existing = tasks.get(identity.taskId);
      if (
        !existing ||
        existing.agentInstanceId !== identity.agentInstanceId ||
        existing.agentDefinitionId !== identity.agentDefinitionId ||
        existing.executionNodeId !== identity.executionNodeId ||
        (existing.executionRevision ?? 0) !== options.expectedExecutionRevision
      ) return null;
      updates.push({ taskId: identity.taskId, patch });
      const updated = { ...existing } as ScheduledTask & Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete updated[key];
        else updated[key] = value;
      }
      updated.executionRevision = (existing.executionRevision ?? 0) + 1;
      tasks.set(identity.taskId, updated);
      return updated;
    },
  };
  return { executionStore, tasks, updates };
}

describe('ScheduledTaskExecutionCoordinator', () => {
  it('restores an overdue one-shot, runs once, and completes it durably', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:01:00.000Z'));
    const persisted = store([task()]);
    const runAgent = vi.fn(async () => {});
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent,
      clock,
    });

    await coordinator.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.state).toBe('completed');
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      conversationId: 'conversation-1',
      agentDefinitionId: 'definition-1',
      message: 'hello',
      signal: expect.any(AbortSignal),
    }));
    expect(persisted.tasks.get('task-1')).toMatchObject({
      runCount: 1,
      consecutiveFailures: 0,
      lastRunStatus: 'succeeded',
    });
    coordinator.stopAll();
  });

  it('calculates cron occurrences and prevents overlapping executions', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const persisted = store([task({
      schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    })]);
    let resolveRun!: () => void;
    const running = new Promise<void>(resolve => {
      resolveRun = resolve;
    });
    const runAgent = vi.fn(async () => running);
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent,
      clock,
    });

    await coordinator.restore();
    expect(persisted.tasks.get('task-1')?.nextRunAt).toBe('2026-01-01T00:01:00.000Z');
    clock.advance(60_000);
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(1);
    });
    clock.advance(5 * 60_000);
    expect(runAgent).toHaveBeenCalledTimes(1);
    resolveRun();
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.runCount).toBe(1);
    });
    coordinator.stopAll();
  });

  it('runs an overdue durable cron occurrence immediately without changing its identity', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:05:00.000Z'));
    const persisted = store([task({
      schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      nextRunAt: '2026-01-01T00:03:00.000Z',
    })]);
    const runs: Array<{ occurrenceId: string; scheduledFor: string }> = [];
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent: async input => {
        runs.push({
          occurrenceId: input.occurrenceId,
          scheduledFor: input.scheduledFor,
        });
      },
      clock,
    });

    await coordinator.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.runCount).toBe(1);
    });

    expect(runs[0]?.scheduledFor).toBe('2026-01-01T00:03:00.000Z');
    expect(runs[0]?.occurrenceId).toMatch(/^scheduled:[a-f0-9]{64}$/u);
    expect(persisted.tasks.get('task-1')?.nextRunAt).toBe('2026-01-01T00:06:00.000Z');
    coordinator.stopAll();
  });

  it('persists exponential retry state and retries a failed one-shot', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:01:00.000Z'));
    const persisted = store([task()]);
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error('secret provider body'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent,
      clock,
      retryBaseMs: 60_000,
      retryMaxMs: 60 * 60_000,
    });

    await coordinator.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')).toMatchObject({
        state: 'active',
        lastRunStatus: 'failed',
        consecutiveFailures: 1,
        nextRetryAt: '2026-01-01T00:02:00.000Z',
      });
    });
    expect(persisted.tasks.get('task-1')?.lastError).toContain('agent.run.error.internal');
    clock.advance(60_000);
    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.state).toBe('completed');
    });
    coordinator.stopAll();
  });

  it('pauses invalid persisted cron rows with bounded failure provenance', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const persisted = store([task({
      schedule: { kind: 'cron', expression: 'not a cron' },
    })]);
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent: vi.fn(),
      clock,
    });

    await coordinator.restore();

    expect(persisted.tasks.get('task-1')).toMatchObject({
      state: 'paused',
      lastRunStatus: 'failed',
      lastError: 'Invalid persisted scheduled task',
      consecutiveFailures: 1,
    });
    coordinator.stopAll();
  });

  it('does not write terminal state after stop or removal during an in-flight run', async () => {
    for (const cancel of ['stop', 'remove'] as const) {
      const clock = new FakeClock(Date.parse('2026-01-01T00:01:00.000Z'));
      const persisted = store([task({ id: `task-${cancel}` })]);
      let resolveRun!: () => void;
      const runAgent = vi.fn(async () =>
        new Promise<void>(resolve => {
          resolveRun = resolve;
        })
      );
      const coordinator = new ScheduledTaskExecutionCoordinator({
        localPeerId: 'peer-local',
        store: persisted.executionStore,
        runAgent,
        clock,
      });
      await coordinator.restore();
      clock.advance(0);
      await vi.waitFor(() => {
        expect(runAgent).toHaveBeenCalledTimes(1);
      });

      if (cancel === 'stop') coordinator.stopAll();
      else coordinator.remove(`task-${cancel}`);
      resolveRun();
      await Promise.resolve();
      await Promise.resolve();

      expect(persisted.tasks.get(`task-${cancel}`)?.state).toBe('active');
      expect(persisted.tasks.get(`task-${cancel}`)?.lastRunStatus).toBeUndefined();
    }
  });

  it('CAS-fences a config update that wins while the old occurrence is running', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:01:00.000Z'));
    const persisted = store([task()]);
    let resolveRun!: () => void;
    const coordinator = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent: async () =>
        new Promise<void>(resolve => {
          resolveRun = resolve;
        }),
      clock,
    });
    await coordinator.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(resolveRun).toBeTypeOf('function');
    });
    const running = persisted.tasks.get('task-1')!;
    persisted.tasks.set('task-1', {
      ...running,
      name: 'new config',
      executionRevision: (running.executionRevision ?? 0) + 1,
    });

    resolveRun();
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.name).toBe('new config');
    });
    expect(persisted.tasks.get('task-1')?.state).toBe('active');
    expect(persisted.tasks.get('task-1')?.lastRunStatus).toBeUndefined();
    coordinator.stopAll();
  });

  it('contains storage failures and replays one occurrence with the same idempotency key', async () => {
    const clock = new FakeClock(Date.parse('2026-01-01T00:01:00.000Z'));
    const persisted = store([task()]);
    const baseUpdate = persisted.executionStore.updateExecution;
    let failTerminalWrite = true;
    persisted.executionStore.updateExecution = async (identity, patch, options) => {
      if (failTerminalWrite && patch.lastRunStatus === 'succeeded') {
        failTerminalWrite = false;
        throw new Error('storage unavailable');
      }
      return baseUpdate(identity, patch, options);
    };
    const occurrences: string[] = [];
    const onError = vi.fn();
    const first = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent: async input => {
        occurrences.push(input.occurrenceId);
      },
      onError,
      clock,
    });
    await first.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(persisted.tasks.get('task-1')?.state).toBe('active');
    first.stopAll();

    const second = new ScheduledTaskExecutionCoordinator({
      localPeerId: 'peer-local',
      store: persisted.executionStore,
      runAgent: async input => {
        occurrences.push(input.occurrenceId);
      },
      clock,
    });
    await second.restore();
    clock.advance(0);
    await vi.waitFor(() => {
      expect(persisted.tasks.get('task-1')?.state).toBe('completed');
    });

    expect(occurrences).toHaveLength(2);
    expect(occurrences[1]).toBe(occurrences[0]);
    expect(occurrences[0]).toMatch(/^scheduled:[a-f0-9]{64}$/u);
    second.stopAll();
  });
});

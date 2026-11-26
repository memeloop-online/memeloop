import { Cron } from 'croner';

import { sha256HexSync } from '../encoding/sha256.js';
import { agentRunErrorFromUnknown } from '../runState.js';
import type { ScheduledTask } from './types.js';

const DEFAULT_RESTORE_PAGE_SIZE = 100;
const MAX_RESTORE_PAGES = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60_000;

export interface ScheduledTaskExecutionIdentity {
  taskId: string;
  agentInstanceId: string;
  agentDefinitionId: string;
  executionNodeId: string;
}

export interface ScheduledTaskExecutionPatch {
  state?: ScheduledTask['state'];
  enabled?: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string;
  lastRunStatus?: ScheduledTask['lastRunStatus'];
  lastError?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number;
  nextRetryAt?: string | null;
  runCount?: number;
  occurrenceId?: string | null;
  occurrenceScheduledFor?: string | null;
  occurrenceAttempt?: number;
  updatedAt: string;
}

export interface ScheduledTaskExecutionStore {
  listRunnablePage(options: {
    executionNodeId: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ items: ScheduledTask[]; nextCursor?: string; hasMoreAfter: boolean }>;
  updateExecution(
    identity: ScheduledTaskExecutionIdentity,
    patch: ScheduledTaskExecutionPatch,
    options: { expectedExecutionRevision: number; signal?: AbortSignal },
  ): Promise<ScheduledTask | null>;
}

export interface ScheduledTaskExecutionRunInput {
  taskId: string;
  conversationId: string;
  agentDefinitionId: string;
  message: string;
  /** Stable across crash replay and every retry of one scheduled occurrence. */
  occurrenceId: string;
  scheduledFor: string;
  attempt: number;
  signal: AbortSignal;
}

export interface ScheduledTaskExecutionClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ScheduledTaskExecutionCoordinatorOptions {
  localPeerId: string;
  store: ScheduledTaskExecutionStore;
  /** Resolves only at terminal successful completion, never at mere acceptance. */
  runAgent(input: ScheduledTaskExecutionRunInput): Promise<void>;
  clock?: ScheduledTaskExecutionClock;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Receives bounded public failures from timer/store plumbing; never unhandled. */
  onError?: (error: Error) => void;
}

interface ScheduledOperation {
  timer?: unknown;
  abortController: AbortController;
  generation: number;
}

interface ScheduledExecutionPlan {
  dueAt: Date;
  nextRunAt: string;
  occurrenceScheduledFor: string;
}

const systemClock: ScheduledTaskExecutionClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Portable execution lifecycle for persisted scheduled Agent tasks.
 *
 * Hosts own storage and the actual Agent run. The coordinator owns restore,
 * due-time calculation, timer chunking, single-flight protection, and durable
 * success/failure/retry state so every host has identical restart semantics.
 */
export class ScheduledTaskExecutionCoordinator {
  private readonly options:
    & Required<
      Pick<
        ScheduledTaskExecutionCoordinatorOptions,
        'localPeerId' | 'store' | 'runAgent'
      >
    >
    & {
      clock: ScheduledTaskExecutionClock;
      retryBaseMs: number;
      retryMaxMs: number;
      onError: (error: Error) => void;
    };
  private readonly operations = new Map<string, ScheduledOperation>();
  private generation = 0;
  private stopped = false;

  constructor(options: ScheduledTaskExecutionCoordinatorOptions) {
    if (!options.localPeerId.trim()) throw new Error('invalid_scheduled_task_local_peer_id');
    const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    if (
      !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 ||
      !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs
    ) throw new Error('invalid_scheduled_task_retry_policy');
    this.options = {
      localPeerId: options.localPeerId,
      store: options.store,
      runAgent: input => options.runAgent(input),
      clock: options.clock ?? systemClock,
      retryBaseMs,
      retryMaxMs,
      onError: options.onError ?? (() => {}),
    };
  }

  async restore(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.stopped = false;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_RESTORE_PAGES; pageIndex += 1) {
      options.signal?.throwIfAborted();
      const page = await this.options.store.listRunnablePage({
        executionNodeId: this.options.localPeerId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: DEFAULT_RESTORE_PAGE_SIZE,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      options.signal?.throwIfAborted();
      for (const task of page.items) await this.upsert(task, options);
      if (!page.hasMoreAfter) return;
      if (!page.nextCursor || page.nextCursor === cursor) {
        throw new Error('invalid_scheduled_task_restore_cursor');
      }
      cursor = page.nextCursor;
    }
    throw new Error('scheduled_task_restore_page_limit_exceeded');
  }

  async upsert(task: ScheduledTask, options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    this.cancelOperation(task.id);
    if (
      this.stopped ||
      task.executionNodeId !== this.options.localPeerId ||
      task.state !== 'active' ||
      !task.enabled
    ) return;
    let plan: ScheduledExecutionPlan;
    try {
      plan = this.executionPlan(task, this.options.clock.now());
    } catch {
      await this.pauseInvalidTask(task, options.signal);
      return;
    }
    const now = this.options.clock.now();
    const persistedOccurrenceId = task.occurrenceId ?? occurrenceId(
      task.id,
      plan.occurrenceScheduledFor,
    );
    const occurrenceAttempt = task.occurrenceAttempt ?? 0;
    if (
      task.nextRunAt !== plan.nextRunAt ||
      task.occurrenceId !== persistedOccurrenceId ||
      task.occurrenceScheduledFor !== plan.occurrenceScheduledFor ||
      task.occurrenceAttempt !== occurrenceAttempt
    ) {
      const updated = await this.options.store.updateExecution(
        identityOf(task),
        {
          nextRunAt: plan.nextRunAt,
          occurrenceId: persistedOccurrenceId,
          occurrenceScheduledFor: plan.occurrenceScheduledFor,
          occurrenceAttempt,
          updatedAt: now.toISOString(),
        },
        {
          expectedExecutionRevision: task.executionRevision ?? 0,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (!updated || updated.state !== 'active' || !updated.enabled) return;
      task = updated;
    }
    this.schedule(task, plan.dueAt);
  }

  async reconcile(task: ScheduledTask, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.upsert(task, options);
  }

  remove(taskId: string): void {
    this.cancelOperation(taskId);
  }

  stopAll(): void {
    this.stopped = true;
    for (const taskId of [...this.operations.keys()]) this.cancelOperation(taskId);
  }

  private schedule(task: ScheduledTask, dueAt: Date): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const operation: ScheduledOperation = {
      abortController: new AbortController(),
      generation,
    };
    const arm = (): void => {
      if (!this.isCurrent(task.id, operation)) return;
      const remaining = dueAt.getTime() - this.options.clock.now().getTime();
      if (remaining <= 0) {
        operation.timer = undefined;
        void this.execute(task, operation).catch((error: unknown) => {
          if (!operation.abortController.signal.aborted) {
            this.options.onError(boundedCoordinatorError(error));
          }
        });
        return;
      }
      operation.timer = this.options.clock.setTimeout(
        arm,
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
    };
    this.operations.set(task.id, operation);
    arm();
  }

  private async execute(task: ScheduledTask, operation: ScheduledOperation): Promise<void> {
    if (!this.isCurrent(task.id, operation)) return;
    const startedAt = this.options.clock.now();
    let runFailure: unknown;
    try {
      await this.options.runAgent({
        taskId: task.id,
        conversationId: task.agentInstanceId,
        agentDefinitionId: task.agentDefinitionId,
        message: task.payload?.message ?? '',
        occurrenceId: task.occurrenceId ?? occurrenceId(
          task.id,
          task.occurrenceScheduledFor ?? task.nextRunAt ?? startedAt.toISOString(),
        ),
        scheduledFor: task.occurrenceScheduledFor ?? task.nextRunAt ?? startedAt.toISOString(),
        attempt: task.occurrenceAttempt ?? 0,
        signal: operation.abortController.signal,
      });
    } catch (error_) {
      runFailure = error_;
    }
    if (!this.isCurrent(task.id, operation) || operation.abortController.signal.aborted) return;
    const finishedAt = this.options.clock.now();
    if (runFailure !== undefined) {
      const failures = Math.min(1_000_000, (task.consecutiveFailures ?? 0) + 1);
      const exponent = Math.min(30, failures - 1);
      const delay = Math.min(
        this.options.retryMaxMs,
        this.options.retryBaseMs * (2 ** exponent),
      );
      const retryAt = new Date(finishedAt.getTime() + delay);
      const updated = await this.options.store.updateExecution(identityOf(task), {
        state: 'active',
        nextRunAt: retryAt.toISOString(),
        lastRunAt: finishedAt.toISOString(),
        lastRunStatus: 'failed',
        lastError: boundedRunFailure(runFailure),
        lastFailureAt: finishedAt.toISOString(),
        consecutiveFailures: failures,
        nextRetryAt: retryAt.toISOString(),
        runCount: task.runCount ?? 0,
        occurrenceId: task.occurrenceId ?? occurrenceId(
          task.id,
          task.occurrenceScheduledFor ?? task.nextRunAt ?? startedAt.toISOString(),
        ),
        occurrenceScheduledFor: task.occurrenceScheduledFor ?? task.nextRunAt ?? startedAt.toISOString(),
        occurrenceAttempt: failures,
        updatedAt: finishedAt.toISOString(),
      }, { expectedExecutionRevision: task.executionRevision ?? 0 });
      if (!this.isCurrent(task.id, operation)) return;
      this.operations.delete(task.id);
      if (updated) await this.upsert(updated);
      return;
    }
    const runCount = (task.runCount ?? 0) + 1;
    const completed = task.schedule.kind === 'at' ||
      task.deleteAfterRun === true ||
      (task.maxRuns !== undefined && runCount >= task.maxRuns);
    const nextRun = completed ? null : this.nextCronOccurrence(task, finishedAt);
    const updated = await this.options.store.updateExecution(identityOf(task), {
      state: completed ? 'completed' : 'active',
      nextRunAt: nextRun?.toISOString() ?? null,
      lastRunAt: finishedAt.toISOString(),
      lastRunStatus: 'succeeded',
      lastError: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      runCount,
      occurrenceId: null,
      occurrenceScheduledFor: null,
      occurrenceAttempt: 0,
      updatedAt: finishedAt.toISOString(),
    }, {
      expectedExecutionRevision: task.executionRevision ?? 0,
      signal: operation.abortController.signal,
    });
    if (!this.isCurrent(task.id, operation)) return;
    this.operations.delete(task.id);
    if (updated && !completed) await this.upsert(updated);
  }

  private executionPlan(task: ScheduledTask, now: Date): ScheduledExecutionPlan {
    const retryAt = parseOptionalDate(task.nextRetryAt);
    if (retryAt) {
      const scheduledFor = parseOptionalDate(task.occurrenceScheduledFor) ??
        (task.schedule.kind === 'at'
          ? parseRequiredDate(task.schedule.wakeAtISO)
          : parseOptionalDate(task.nextRunAt) ?? retryAt);
      return {
        dueAt: retryAt.getTime() <= now.getTime() ? now : retryAt,
        nextRunAt: retryAt.toISOString(),
        occurrenceScheduledFor: scheduledFor.toISOString(),
      };
    }
    if (task.schedule.kind === 'at') {
      const wakeAt = parseRequiredDate(task.schedule.wakeAtISO);
      return {
        dueAt: wakeAt.getTime() <= now.getTime() ? now : wakeAt,
        nextRunAt: wakeAt.toISOString(),
        occurrenceScheduledFor: (parseOptionalDate(task.occurrenceScheduledFor) ?? wakeAt).toISOString(),
      };
    }
    const persistedNext = parseOptionalDate(task.nextRunAt);
    const next = persistedNext ?? this.nextCronOccurrence(task, now);
    if (!next) throw new Error('scheduled_task_has_no_next_occurrence');
    return {
      dueAt: next.getTime() <= now.getTime() ? now : next,
      nextRunAt: next.toISOString(),
      occurrenceScheduledFor: (parseOptionalDate(task.occurrenceScheduledFor) ?? next).toISOString(),
    };
  }

  private nextCronOccurrence(task: ScheduledTask, after: Date): Date | null {
    if (task.schedule.kind !== 'cron') return null;
    const cron = new Cron(task.schedule.expression, {
      paused: true,
      protect: true,
      ...(task.schedule.timezone === undefined ? {} : { timezone: task.schedule.timezone }),
    });
    let cursor = new Date(after.getTime() + 1);
    for (let index = 0; index < 10_000; index += 1) {
      const next = cron.nextRun(cursor);
      if (!next) return null;
      if (withinActiveHours(task, next)) return next;
      cursor = new Date(next.getTime() + 1);
    }
    throw new Error('scheduled_task_active_hours_exhausted');
  }

  private async pauseInvalidTask(task: ScheduledTask, signal?: AbortSignal): Promise<void> {
    const now = this.options.clock.now().toISOString();
    await this.options.store.updateExecution(identityOf(task), {
      state: 'paused',
      nextRunAt: null,
      lastRunStatus: 'failed',
      lastError: 'Invalid persisted scheduled task',
      lastFailureAt: now,
      consecutiveFailures: Math.min(1_000_000, (task.consecutiveFailures ?? 0) + 1),
      nextRetryAt: null,
      runCount: task.runCount ?? 0,
      updatedAt: now,
    }, {
      expectedExecutionRevision: task.executionRevision ?? 0,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private isCurrent(taskId: string, operation: ScheduledOperation): boolean {
    return !this.stopped &&
      this.operations.get(taskId) === operation &&
      !operation.abortController.signal.aborted;
  }

  private cancelOperation(taskId: string): void {
    const operation = this.operations.get(taskId);
    if (!operation) return;
    this.operations.delete(taskId);
    operation.abortController.abort();
    if (operation.timer !== undefined) this.options.clock.clearTimeout(operation.timer);
  }
}

/** Bounded portable Cron preview used by every host RPC adapter. */
export function previewScheduledTaskCron(
  expression: string,
  options: { timezone?: string; count?: number; after?: Date } = {},
): string[] {
  const count = options.count ?? 3;
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
    throw new Error('invalid_scheduled_task_cron_preview_count');
  }
  const cron = new Cron(expression, {
    paused: true,
    protect: true,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  });
  return cron.nextRuns(count, options.after ?? new Date()).map(date => date.toISOString());
}

function identityOf(task: ScheduledTask): ScheduledTaskExecutionIdentity {
  return {
    taskId: task.id,
    agentInstanceId: task.agentInstanceId,
    agentDefinitionId: task.agentDefinitionId,
    executionNodeId: task.executionNodeId,
  };
}

function occurrenceId(taskId: string, scheduledFor: string): string {
  return `scheduled:${sha256HexSync(new TextEncoder().encode(`${taskId}\0${scheduledFor}`))}`;
}

function boundedRunFailure(error: unknown): string {
  const failure = agentRunErrorFromUnknown(error);
  return JSON.stringify({
    code: failure.code,
    messageKey: failure.messageKey,
    retryable: failure.retryable,
    diagnosticId: failure.diagnosticId,
  }).slice(0, 1_024);
}

function boundedCoordinatorError(error: unknown): Error {
  const failure = agentRunErrorFromUnknown(error);
  return Object.assign(new Error(failure.messageKey), {
    code: failure.code,
    diagnosticId: failure.diagnosticId,
    retryable: failure.retryable,
  });
}

function parseRequiredDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid_scheduled_task_date');
  }
  return parsed;
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : parseRequiredDate(value);
}

function withinActiveHours(task: ScheduledTask, date: Date): boolean {
  if (task.activeHoursStart === undefined || task.activeHoursEnd === undefined) return true;
  const start = parseActiveHour(task.activeHoursStart);
  const end = parseActiveHour(task.activeHoursEnd);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(task.schedule.kind === 'cron' && task.schedule.timezone !== undefined
      ? { timeZone: task.schedule.timezone }
      : {}),
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const current = hour * 60 + minute;
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

function parseActiveHour(value: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error('invalid_scheduled_task_active_hour');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('invalid_scheduled_task_active_hour');
  return hour * 60 + minute;
}

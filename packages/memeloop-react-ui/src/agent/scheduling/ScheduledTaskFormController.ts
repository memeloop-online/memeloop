import type { AgentDefinition, CreateScheduledTaskInput, ScheduledTask, ScheduledTaskClient } from 'memeloop';

import { notifyMemeLoopObserver } from '../../chat/observerErrors.js';
import type { MemeLoopObserverErrorHandler } from '../../chat/observerErrors.js';
import { isSupportedTimeZone } from './coreTypes.js';
import type { ScheduledTaskEditorLabels, ScheduledTaskExecutionTarget, ScheduledTaskFormValue, ScheduledTaskPageStatus, ScheduledTaskPreviewState } from './coreTypes.js';

export interface ScheduledTaskFormControllerConfiguration {
  agentDefinition: AgentDefinition;
  agentInstanceId: string | null;
  client: ScheduledTaskClient;
  executionTargets: readonly ScheduledTaskExecutionTarget[];
  localNodeId: string;
  labels: ScheduledTaskEditorLabels;
  previewDebounceMs?: number;
  onListenerError?: (error: unknown) => void;
  onObserverError?: MemeLoopObserverErrorHandler;
}

export interface ScheduledTaskFormSnapshot {
  value: Readonly<ScheduledTaskFormValue>;
  tasks: readonly Readonly<ScheduledTask>[];
  selectedTaskId?: string;
  existingTask?: Readonly<ScheduledTask>;
  loading: boolean;
  saving: boolean;
  error?: string;
  preview: ScheduledTaskPreviewState;
  executionTargetUnavailable: boolean;
  pageStatus: ScheduledTaskPageStatus;
}

export type ScheduledTaskFormListener = () => void;

export const MAX_RESIDENT_SCHEDULED_TASKS = 64;
export const MAX_RESIDENT_SCHEDULED_TASK_SOURCES = 64;
export const MAX_SCHEDULED_TASK_RELOAD_PAGES = 8;
export const MAX_SCHEDULED_TASK_RELOAD_BYTES = 256 * 1024;

function strictUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7F) bytes += 1;
    else if (code <= 0x7FF) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new TypeError('scheduled task page contains invalid Unicode');
      bytes += 4;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new TypeError('scheduled task page contains invalid Unicode');
    } else bytes += 3;
  }
  return bytes;
}

function scheduledTaskPageBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new TypeError('scheduled task page is not serializable');
  return strictUtf8Bytes(json);
}

function validOpaqueCursor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function initialValue(localNodeId: string): ScheduledTaskFormValue {
  return {
    enabled: false,
    expression: '0 9 * * 1-5',
    timezone: localTimezone(),
    message: '',
    activeHoursStart: '',
    activeHoursEnd: '',
    executionNodeId: localNodeId,
  };
}

function valueFromTask(task: Readonly<ScheduledTask>, localNodeId: string): ScheduledTaskFormValue {
  return {
    enabled: task.enabled,
    expression: task.schedule.kind === 'cron' ? task.schedule.expression : '0 9 * * 1-5',
    timezone: task.schedule.kind === 'cron' ? task.schedule.timezone ?? localTimezone() : localTimezone(),
    message: task.payload?.message ?? '',
    activeHoursStart: task.activeHoursStart ?? '',
    activeHoursEnd: task.activeHoursEnd ?? '',
    executionNodeId: task.executionNodeId || localNodeId,
  };
}

function cloneTask(task: ScheduledTask): Readonly<ScheduledTask> {
  return Object.freeze({
    ...task,
    schedule: Object.freeze({ ...task.schedule }),
    ...(task.payload === undefined ? {} : { payload: Object.freeze({ ...task.payload }) }),
  }) as Readonly<ScheduledTask>;
}

function normalizeConfiguration(configuration: ScheduledTaskFormControllerConfiguration): ScheduledTaskFormControllerConfiguration {
  return {
    ...configuration,
    agentDefinition: Object.freeze({ ...configuration.agentDefinition }),
    executionTargets: Object.freeze(configuration.executionTargets.map(target => Object.freeze({ ...target }))),
    labels: Object.freeze({ ...configuration.labels }),
  };
}

/** The only scheduling state machine; Web and Native are pure projections. */
export class ScheduledTaskFormController {
  private configuration: ScheduledTaskFormControllerConfiguration;
  private configurationGeneration = 0;
  private previewGeneration = 0;
  private manuallySelectedExecutionTarget = false;
  private cronValidationError = false;
  private previewTimeout: ReturnType<typeof setTimeout> | undefined;
  private loadAbortController?: AbortController;
  private saveAbortController?: AbortController;
  private previewAbortController?: AbortController;
  private readonly listeners = new Set<ScheduledTaskFormListener>();
  private snapshot: ScheduledTaskFormSnapshot;

  public constructor(configuration: ScheduledTaskFormControllerConfiguration) {
    this.configuration = normalizeConfiguration(configuration);
    this.snapshot = this.createSnapshot(initialValue(this.configuration.localNodeId), { loading: true });
    void this.reload();
  }

  public getSnapshot = (): ScheduledTaskFormSnapshot => this.snapshot;

  public subscribe = (listener: ScheduledTaskFormListener): () => void => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public setConfiguration(configuration: ScheduledTaskFormControllerConfiguration): void {
    const normalized = normalizeConfiguration(configuration);
    const identityChanged = normalized.agentInstanceId !== this.configuration.agentInstanceId ||
      normalized.client !== this.configuration.client;
    this.configuration = normalized;
    if (identityChanged) {
      this.abortOperations();
      this.previewGeneration += 1;
      if (this.previewTimeout !== undefined) clearTimeout(this.previewTimeout);
      this.manuallySelectedExecutionTarget = false;
      this.cronValidationError = false;
      this.snapshot = this.createSnapshot(initialValue(normalized.localNodeId), { loading: true });
      this.emit();
      void this.reload();
    } else if (!this.snapshot.existingTask && !this.manuallySelectedExecutionTarget) {
      this.replaceValue({ executionNodeId: normalized.localNodeId });
    } else {
      this.updateAvailability();
    }
  }

  public selectTask(taskId: string | undefined): void {
    const task = taskId === undefined ? undefined : this.snapshot.tasks.find(candidate => candidate.id === taskId);
    if (taskId !== undefined && !task) return;
    this.manuallySelectedExecutionTarget = false;
    this.cronValidationError = false;
    this.snapshot = this.createSnapshot(
      task ? valueFromTask(task, this.configuration.localNodeId) : initialValue(this.configuration.localNodeId),
      { ...this.snapshot, selectedTaskId: task?.id, existingTask: task, error: undefined },
    );
    this.emit();
    this.schedulePreview();
  }

  public setValue(patch: Partial<ScheduledTaskFormValue>, options?: { manualExecutionTarget?: boolean }): void {
    if (options?.manualExecutionTarget) this.manuallySelectedExecutionTarget = true;
    this.replaceValue(patch);
    this.schedulePreview();
  }

  public setCronValidationError(invalid: boolean): void {
    if (this.cronValidationError === invalid) return;
    this.cronValidationError = invalid;
    this.schedulePreview();
  }

  public async save(): Promise<void> {
    const generation = this.configurationGeneration;
    const { agentDefinition, agentInstanceId, client, labels, localNodeId } = this.configuration;
    if (!agentInstanceId || this.snapshot.saving) return;
    const { value } = this.snapshot;
    if (!value.enabled && !this.snapshot.existingTask) return;
    if (this.snapshot.pageStatus.partial) {
      this.setSnapshot({ error: labels.sourceIncomplete });
      return;
    }
    if (value.enabled && this.snapshot.executionTargetUnavailable) {
      this.setSnapshot({ error: labels.executionTargetUnavailable });
      return;
    }
    if (value.enabled && (this.snapshot.preview.status !== 'ready' || this.snapshot.preview.dates.length === 0)) {
      this.setSnapshot({ error: this.snapshot.preview.status === 'error' ? this.snapshot.preview.error : labels.invalidCron });
      return;
    }
    this.saveAbortController?.abort();
    const saveController = new AbortController();
    this.saveAbortController = saveController;
    this.setSnapshot({ saving: true, error: undefined });
    try {
      if (!value.enabled) {
        await client.deleteScheduledTask(this.snapshot.existingTask!.id, { signal: saveController.signal });
        if (generation !== this.configurationGeneration) return;
        const tasks = this.snapshot.tasks.filter(task => task.id !== this.snapshot.existingTask!.id);
        this.replaceTasksAfterMutation(tasks, tasks[0]);
        return;
      }
      const target = this.configuration.executionTargets.find(candidate => candidate.id === value.executionNodeId)!;
      const input: CreateScheduledTaskInput = {
        agentInstanceId,
        agentDefinitionId: agentDefinition.id,
        name: labels.defaultTaskName(agentDefinition.name ?? ''),
        scheduleKind: 'cron',
        schedule: { kind: 'cron', expression: value.expression, timezone: value.timezone || undefined },
        payload: { message: value.message || labels.defaultMessage },
        activeHoursStart: value.activeHoursStart || undefined,
        activeHoursEnd: value.activeHoursEnd || undefined,
        createdBy: 'agent-definition',
        enabled: true,
        executionNodeId: value.executionNodeId,
        executionNodeLabel: target.label,
        originNodeId: localNodeId,
      };
      const persisted = this.snapshot.existingTask
        ? await client.updateScheduledTask(this.snapshot.existingTask.id, input, { signal: saveController.signal })
        : await client.createScheduledTask(input, { signal: saveController.signal });
      if (generation !== this.configurationGeneration) return;
      const task = cloneTask(persisted);
      const tasks = this.snapshot.existingTask
        ? this.snapshot.tasks.map(candidate => candidate.id === task.id ? task : candidate)
        : [...this.snapshot.tasks, task];
      this.replaceTasksAfterMutation(tasks, task);
    } catch {
      if (generation === this.configurationGeneration && !saveController.signal.aborted) this.setSnapshot({ saving: false, error: labels.operationFailed });
    } finally {
      if (this.saveAbortController === saveController) this.saveAbortController = undefined;
    }
  }

  public dispose(): void {
    this.configurationGeneration += 1;
    this.previewGeneration += 1;
    this.abortOperations();
    if (this.previewTimeout !== undefined) clearTimeout(this.previewTimeout);
    this.listeners.clear();
  }

  private async reload(): Promise<void> {
    const generation = ++this.configurationGeneration;
    if (this.previewTimeout !== undefined) clearTimeout(this.previewTimeout);
    const { agentInstanceId, client, localNodeId } = this.configuration;
    this.loadAbortController?.abort();
    const loadController = new AbortController();
    this.loadAbortController = loadController;
    if (!agentInstanceId) {
      this.snapshot = this.createSnapshot(initialValue(localNodeId), { loading: false });
      this.emit();
      return;
    }
    try {
      const tasks: Readonly<ScheduledTask>[] = [];
      const taskIdentities = new Set<string>();
      const sourceByNodeId = new Map<string, ScheduledTaskFormSnapshot['pageStatus']['sources'][number]>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let partial = false;
      let aggregateBytes = 0;
      let pageCount = 0;
      let hasMoreAfter = false;
      do {
        loadController.signal.throwIfAborted();
        const remainingBytes = MAX_SCHEDULED_TASK_RELOAD_BYTES - aggregateBytes;
        if (remainingBytes < 64) {
          partial = true;
          break;
        }
        const remainingTasks = MAX_RESIDENT_SCHEDULED_TASKS - tasks.length;
        const page = await client.listScheduledTasksForAgent(agentInstanceId, {
          states: ['active', 'paused'],
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.max(1, remainingTasks),
          maxBytes: remainingBytes,
          signal: loadController.signal,
        });
        loadController.signal.throwIfAborted();
        pageCount += 1;
        if (
          !Array.isArray(page.items) || !Array.isArray(page.sources) ||
          page.items.length > MAX_RESIDENT_SCHEDULED_TASKS ||
          page.sources.length > MAX_RESIDENT_SCHEDULED_TASK_SOURCES ||
          typeof page.partial !== 'boolean' || typeof page.hasMoreAfter !== 'boolean'
        ) throw new RangeError('scheduled task page exceeds limit');
        const clonedTasks = page.items.map(cloneTask);
        const clonedSources = page.sources.map(source => Object.freeze({ ...source }));
        const pageBytes = scheduledTaskPageBytes({
          items: clonedTasks,
          sources: clonedSources,
          partial: page.partial,
          hasMoreAfter: page.hasMoreAfter,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
        if (pageBytes > MAX_SCHEDULED_TASK_RELOAD_BYTES - aggregateBytes) {
          partial = true;
          break;
        }
        aggregateBytes += pageBytes;
        for (const task of clonedTasks) {
          if (taskIdentities.has(task.id)) throw new TypeError('scheduled task identity is duplicated');
          taskIdentities.add(task.id);
          if (tasks.length < MAX_RESIDENT_SCHEDULED_TASKS) tasks.push(task);
          else partial = true;
        }
        for (const source of clonedSources) {
          if (!sourceByNodeId.has(source.executionNodeId)) {
            if (sourceByNodeId.size < MAX_RESIDENT_SCHEDULED_TASK_SOURCES) sourceByNodeId.set(source.executionNodeId, source);
            else partial = true;
          }
        }
        partial ||= page.partial;
        hasMoreAfter = page.hasMoreAfter;
        if (!page.hasMoreAfter) break;
        if (!validOpaqueCursor(page.nextCursor) || cursors.has(page.nextCursor)) {
          partial = true;
          break;
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (
          pageCount >= MAX_SCHEDULED_TASK_RELOAD_PAGES ||
          tasks.length >= MAX_RESIDENT_SCHEDULED_TASKS ||
          sourceByNodeId.size >= MAX_RESIDENT_SCHEDULED_TASK_SOURCES
        ) {
          partial = true;
          break;
        }
      } while (hasMoreAfter);
      if (generation !== this.configurationGeneration) return;
      const frozenTasks = Object.freeze(tasks);
      const task = frozenTasks.find(candidate => candidate.id === this.snapshot.selectedTaskId) ?? frozenTasks[0];
      const value = task ? valueFromTask(task, localNodeId) : initialValue(localNodeId);
      this.snapshot = this.createSnapshot(value, {
        tasks: frozenTasks,
        selectedTaskId: task?.id,
        existingTask: task,
        loading: false,
        error: undefined,
        pageStatus: {
          partial: partial || hasMoreAfter,
          sources: Object.freeze([...sourceByNodeId.values()]),
        },
      });
      this.emit();
      this.schedulePreview();
    } catch {
      if (generation === this.configurationGeneration && !loadController.signal.aborted) this.setSnapshot({ loading: false, error: this.configuration.labels.operationFailed });
    } finally {
      if (this.loadAbortController === loadController) this.loadAbortController = undefined;
    }
  }

  private schedulePreview(): void {
    const generation = ++this.previewGeneration;
    if (this.previewTimeout !== undefined) clearTimeout(this.previewTimeout);
    const { value } = this.snapshot;
    const { labels } = this.configuration;
    if (!value.enabled) {
      this.setSnapshot({ preview: { status: 'idle', dates: [] } });
      return;
    }
    if (!isSupportedTimeZone(value.timezone)) {
      this.setSnapshot({ preview: { status: 'error', dates: [], error: labels.invalidTimezone } });
      return;
    }
    if (!value.expression.trim() || this.cronValidationError) {
      this.setSnapshot({ preview: { status: 'error', dates: [], error: labels.invalidCron } });
      return;
    }
    this.setSnapshot({ preview: { status: 'loading', dates: [] } });
    this.previewTimeout = setTimeout(() => {
      this.previewAbortController?.abort();
      const previewController = new AbortController();
      this.previewAbortController = previewController;
      void this.configuration.client.getCronPreviewDates(value.expression, value.timezone, 3, { signal: previewController.signal }).then(dates => {
        if (generation !== this.previewGeneration) return;
        const boundedDates = Object.freeze(dates.slice(0, 3));
        this.setSnapshot(
          boundedDates.length > 0
            ? { preview: { status: 'ready', dates: boundedDates } }
            : { preview: { status: 'error', dates: [], error: labels.noPreview } },
        );
      }).catch(() => {
        if (generation === this.previewGeneration && !previewController.signal.aborted) this.setSnapshot({ preview: { status: 'error', dates: [], error: labels.invalidCron } });
      }).finally(() => {
        if (this.previewAbortController === previewController) this.previewAbortController = undefined;
      });
    }, this.configuration.previewDebounceMs ?? 300);
  }

  private replaceTasksAfterMutation(tasksInput: readonly Readonly<ScheduledTask>[], selected: Readonly<ScheduledTask> | undefined): void {
    const tasks = Object.freeze([...tasksInput]);
    this.snapshot = this.createSnapshot(
      selected ? valueFromTask(selected, this.configuration.localNodeId) : initialValue(this.configuration.localNodeId),
      { ...this.snapshot, tasks, selectedTaskId: selected?.id, existingTask: selected, saving: false, error: undefined },
    );
    this.emit();
    this.schedulePreview();
  }

  private replaceValue(patch: Partial<ScheduledTaskFormValue>): void {
    this.snapshot = this.createSnapshot({ ...this.snapshot.value, ...patch }, this.snapshot);
    this.emit();
  }

  private createSnapshot(value: ScheduledTaskFormValue, patch: Partial<ScheduledTaskFormSnapshot>): ScheduledTaskFormSnapshot {
    const target = this.configuration.executionTargets.find(candidate => candidate.id === value.executionNodeId);
    const preview = patch.preview ?? { status: 'idle' as const, dates: [] };
    const tasks = Object.freeze([...(patch.tasks ?? [])]);
    const pageStatus = patch.pageStatus ?? { partial: false, sources: [] };
    return Object.freeze({
      loading: false,
      saving: false,
      ...patch,
      tasks,
      pageStatus: Object.freeze({ partial: pageStatus.partial, sources: Object.freeze([...pageStatus.sources]) }),
      value: Object.freeze({ ...value }),
      preview: Object.freeze({ ...preview, dates: Object.freeze([...preview.dates]) }),
      executionTargetUnavailable: !target || target.disabled === true,
    });
  }

  private updateAvailability(): void {
    this.snapshot = this.createSnapshot({ ...this.snapshot.value }, this.snapshot);
    this.emit();
  }

  private setSnapshot(patch: Partial<ScheduledTaskFormSnapshot>): void {
    this.snapshot = this.createSnapshot({ ...this.snapshot.value }, { ...this.snapshot, ...patch });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        notifyMemeLoopObserver(
          () => this.configuration.onListenerError?.(error),
          'scheduled-task.onListenerError',
          undefined,
          this.configuration.onObserverError,
        );
      }
    }
  }

  private abortOperations(): void {
    this.loadAbortController?.abort();
    this.saveAbortController?.abort();
    this.previewAbortController?.abort();
    this.loadAbortController = undefined;
    this.saveAbortController = undefined;
    this.previewAbortController = undefined;
  }
}

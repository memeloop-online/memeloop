/** Platform-neutral contracts for scheduled-task forms. */

import type { ScheduledTaskClient } from 'memeloop';

export type ScheduledTaskPageSource = Awaited<ReturnType<ScheduledTaskClient['listScheduledTasksForAgent']>>['sources'][number];

export interface ScheduledTaskExecutionTarget {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface ScheduledTaskEditorLabels {
  title: string;
  description: string;
  disabled: string;
  enabled: string;
  executionTarget: string;
  timezone: string;
  message: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  save: string;
  update: string;
  saving: string;
  taskSelection: string;
  newTask: string;
  scheduleTitle: string;
  executionTargetUnavailable: string;
  preview: string;
  previewLoading: string;
  invalidCron: string;
  invalidTimezone: string;
  noPreview: string;
  operationFailed: string;
  sourceIncomplete: string;
  sourceOnline: (executionTarget: string) => string;
  sourceOffline: (executionTarget: string) => string;
  sourceDegraded: (executionTarget: string) => string;
  sourceCached: (executionTarget: string) => string;
  defaultTaskName: (agentName: string) => string;
  defaultMessage: string;
}

/** Shared value shape which native, web and wiki hosts can project into their own controls. */
export interface ScheduledTaskFormValue {
  enabled: boolean;
  expression: string;
  timezone: string;
  message: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  executionNodeId: string;
}

export type ScheduledTaskPreviewState =
  | { status: 'idle'; dates: readonly string[] }
  | { status: 'loading'; dates: readonly string[] }
  | { status: 'ready'; dates: readonly string[] }
  | { status: 'error'; dates: readonly string[]; error: string };

export interface ScheduledTaskPageStatus {
  partial: boolean;
  sources: readonly ScheduledTaskPageSource[];
}

export function isSupportedTimeZone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

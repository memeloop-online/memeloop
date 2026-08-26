import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { Alert, Autocomplete, Box, Button, CircularProgress, MenuItem, TextField, Typography } from '@mui/material';
import Scheduler from 'material-ui-cron';
import type { Locale as MaterialUiCronLocale } from 'material-ui-cron';
import type { AgentDefinition, ScheduledTask, ScheduledTaskClient } from 'memeloop';
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { isSupportedTimeZone } from './scheduling/coreTypes.js';
import type { ScheduledTaskEditorLabels, ScheduledTaskExecutionTarget, ScheduledTaskPageSource } from './scheduling/coreTypes.js';
import { ScheduledTaskFormController } from './scheduling/ScheduledTaskFormController.js';

export type { ScheduledTaskEditorLabels, ScheduledTaskExecutionTarget } from './scheduling/coreTypes.js';
export type ScheduledTaskCronLocale = MaterialUiCronLocale;

const defaultLabels: ScheduledTaskEditorLabels = {
  title: 'Scheduled wake-up',
  description: 'Wake this agent on a cron schedule.',
  disabled: 'Disabled',
  enabled: 'Enabled',
  executionTarget: 'Runs on device',
  timezone: 'Timezone',
  message: 'Wake-up message',
  activeHoursStart: 'Active from',
  activeHoursEnd: 'Active until',
  save: 'Save schedule',
  update: 'Update schedule',
  saving: 'Saving…',
  taskSelection: 'Scheduled task',
  newTask: 'New scheduled task',
  scheduleTitle: 'Schedule',
  executionTargetUnavailable: 'The selected device is unavailable. Choose an available device before changing this schedule.',
  preview: 'Next runs',
  previewLoading: 'Checking schedule…',
  invalidCron: 'Enter a valid cron schedule.',
  invalidTimezone: 'Choose a supported timezone.',
  noPreview: 'No upcoming run times were found.',
  operationFailed: 'The scheduled task operation failed.',
  sourceIncomplete: 'Some devices could not provide a complete live schedule. Changes are disabled until every source is available.',
  sourceOnline: target => `${target} is online.`,
  sourceOffline: target => `${target} is offline.`,
  sourceDegraded: target => `${target} is degraded.`,
  sourceCached: target => `${target} is showing cached schedule data.`,
  defaultTaskName: agentName => `${agentName} schedule`,
  defaultMessage: 'Review your tasks and take any pending actions.',
};

function formatPreviewDate(value: string, timezone: string, dateLocale?: string | readonly string[]): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(dateLocale as string | string[] | undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(date);
  } catch {
    return value;
  }
}

function sourceMessages(
  source: Readonly<ScheduledTaskPageSource>,
  targets: readonly ScheduledTaskExecutionTarget[],
  labels: ScheduledTaskEditorLabels,
): readonly string[] {
  const target = targets.find(candidate => candidate.id === source.executionNodeId)?.label ?? source.executionNodeId;
  return [
    source.state === 'offline' ? labels.sourceOffline(target) : source.state === 'degraded' ? labels.sourceDegraded(target) : labels.sourceOnline(target),
    source.fromCache ? labels.sourceCached(target) : undefined,
  ].filter((item): item is string => !!item);
}

function taskTarget(task: Readonly<ScheduledTask>): string {
  return task.executionNodeLabel?.trim() || task.executionNodeId;
}

export interface ScheduledTaskEditorProps {
  agentDefinition: AgentDefinition;
  agentInstanceId: string | null;
  client: ScheduledTaskClient;
  executionTargets: readonly ScheduledTaskExecutionTarget[];
  localNodeId: string;
  labels?: Partial<ScheduledTaskEditorLabels>;
  locale?: 'en' | 'zh_CN';
  customLocale?: ScheduledTaskCronLocale;
  dateLocale?: string | readonly string[];
}

/** Pure Web projection of ScheduledTaskFormController. */
export function ScheduledTaskEditor({
  agentDefinition,
  agentInstanceId,
  client,
  executionTargets,
  localNodeId,
  labels: labelOverrides,
  locale = 'en',
  customLocale,
  dateLocale,
}: ScheduledTaskEditorProps) {
  const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
  const controllerReference = useRef<ScheduledTaskFormController | undefined>(undefined);
  if (!controllerReference.current) {
    controllerReference.current = new ScheduledTaskFormController({ agentDefinition, agentInstanceId, client, executionTargets, localNodeId, labels });
  }
  const controller = controllerReference.current;
  useEffect(() => {
    controller.setConfiguration({ agentDefinition, agentInstanceId, client, executionTargets, localNodeId, labels });
  }, [agentDefinition, agentInstanceId, client, controller, executionTargets, labels, localNodeId]);
  useEffect(() => () => {
    controller.dispose();
  }, [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { value } = snapshot;
  const selectedExecutionTarget = executionTargets.find(candidate => candidate.id === value.executionNodeId);
  const timezoneOptions = useMemo(() => {
    const values = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return values.includes(value.timezone) ? values : [...values, value.timezone].filter(Boolean).sort();
  }, [value.timezone]);
  const timezoneValid = useMemo(() => timezoneOptions.includes(value.timezone) && isSupportedTimeZone(value.timezone), [timezoneOptions, value.timezone]);
  const previewValid = snapshot.preview.status === 'ready' && snapshot.preview.dates.length > 0;
  const saveDisabled = snapshot.pageStatus.partial || snapshot.loading || snapshot.saving || !agentInstanceId ||
    (value.enabled && (snapshot.executionTargetUnavailable || !timezoneValid || !previewValid));

  return (
    <Box
      data-testid='edit-agent-schedule-section'
      sx={{
        containerType: 'inline-size',
        p: 3,
        mb: 4,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
        '@container (max-width: 480px)': { p: 1.5 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <AccessTimeIcon color='primary' />
        <Typography variant='h6' color='primary' sx={{ fontWeight: 600 }}>{labels.title}</Typography>
      </Box>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>{labels.description}</Typography>
      {snapshot.pageStatus.partial && <Alert severity='warning' data-testid='scheduled-task-page-partial'>{labels.sourceIncomplete}</Alert>}
      {snapshot.pageStatus.sources.filter(source => source.state !== 'online' || source.fromCache).map(source => (
        <Alert key={source.executionNodeId} severity={source.state === 'offline' ? 'error' : 'warning'} data-testid={`scheduled-task-source-${source.executionNodeId}`}>
          {sourceMessages(source, executionTargets, labels).join(' ')}
        </Alert>
      ))}
      <TextField
        select
        fullWidth
        margin='dense'
        label={labels.taskSelection}
        value={snapshot.selectedTaskId ?? '__new__'}
        onChange={event => {
          controller.selectTask(event.target.value === '__new__' ? undefined : event.target.value);
        }}
        data-testid='edit-agent-scheduled-task-select'
      >
        <MenuItem value='__new__'>{labels.newTask}</MenuItem>
        {snapshot.tasks.map(task => {
          const source = snapshot.pageStatus.sources.find(candidate => candidate.executionNodeId === task.executionNodeId);
          return (
            <MenuItem key={task.id} value={task.id}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant='body2' noWrap>{task.name}</Typography>
                <Typography variant='caption' color='text.secondary' noWrap>
                  {taskTarget(task)}
                  {source ? ` · ${sourceMessages(source, executionTargets, labels).join(' ')}` : ''}
                </Typography>
              </Box>
            </MenuItem>
          );
        })}
      </TextField>
      <TextField
        select
        fullWidth
        margin='dense'
        value={value.enabled ? 'enabled' : 'disabled'}
        onChange={event => {
          controller.setValue({ enabled: event.target.value === 'enabled' });
        }}
        data-testid='edit-agent-schedule-mode-select'
      >
        <MenuItem value='disabled'>{labels.disabled}</MenuItem>
        <MenuItem value='enabled'>{labels.enabled}</MenuItem>
      </TextField>
      {value.enabled && (
        <>
          <Box sx={{ mt: 1.5, overflowX: 'auto' }}>
            <Scheduler
              cron={value.expression}
              setCron={expression => {
                controller.setValue({ expression: typeof expression === 'string' ? expression : value.expression });
              }}
              setCronError={error => {
                controller.setCronValidationError(!!error);
              }}
              isAdmin
              locale={locale}
              customLocale={customLocale}
              timezone={value.timezone}
              layout='auto'
              title={labels.scheduleTitle}
            />
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, '@container (max-width: 480px)': { gridTemplateColumns: '1fr' } }}>
            <TextField
              select
              margin='dense'
              label={labels.executionTarget}
              value={value.executionNodeId}
              onChange={event => {
                controller.setValue({ executionNodeId: event.target.value }, { manualExecutionTarget: true });
              }}
            >
              {!selectedExecutionTarget && <MenuItem value={value.executionNodeId} disabled>{value.executionNodeId}</MenuItem>}
              {executionTargets.map(target => <MenuItem key={target.id} value={target.id} disabled={target.disabled}>{target.label}</MenuItem>)}
            </TextField>
            <Autocomplete
              disableClearable
              options={timezoneOptions}
              value={value.timezone}
              onChange={(_event, timezone) => {
                controller.setValue({ timezone: typeof timezone === 'string' ? timezone : value.timezone });
              }}
              renderInput={parameters => <TextField {...parameters} margin='dense' label={labels.timezone} />}
            />
          </Box>
          <TextField
            fullWidth
            multiline
            minRows={2}
            margin='dense'
            label={labels.message}
            value={value.message}
            onChange={event => {
              controller.setValue({ message: event.target.value });
            }}
          />
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, '@container (max-width: 480px)': { gridTemplateColumns: '1fr' } }}>
            <TextField
              type='time'
              margin='dense'
              label={labels.activeHoursStart}
              value={value.activeHoursStart}
              onChange={event => {
                controller.setValue({ activeHoursStart: event.target.value });
              }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              type='time'
              margin='dense'
              label={labels.activeHoursEnd}
              value={value.activeHoursEnd}
              onChange={event => {
                controller.setValue({ activeHoursEnd: event.target.value });
              }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Box>
          <Box sx={{ mt: 1 }} aria-live='polite'>
            <Typography variant='caption' color='text.secondary'>{labels.preview}</Typography>
            {snapshot.preview.status === 'loading' && <Typography variant='body2'>{labels.previewLoading}</Typography>}
            {snapshot.preview.status === 'error' && <Alert severity='error'>{snapshot.preview.error}</Alert>}
            {snapshot.preview.dates.length > 0 && (
              <Box component='ol' sx={{ mt: 0.5, mb: 0, pl: 2.5 }} data-testid='schedule-preview-dates'>
                {snapshot.preview.dates.map(date => <Typography component='li' variant='body2' key={date}>{formatPreviewDate(date, value.timezone, dateLocale)}</Typography>)}
              </Box>
            )}
          </Box>
        </>
      )}
      {snapshot.executionTargetUnavailable && value.enabled && (
        <Alert severity='warning' data-testid='schedule-execution-target-unavailable'>{labels.executionTargetUnavailable}</Alert>
      )}
      {snapshot.error && <Alert severity='error'>{snapshot.error}</Alert>}
      <Button
        variant='outlined'
        size='small'
        onClick={() => void controller.save()}
        disabled={saveDisabled}
        sx={{ mt: 1 }}
        data-testid='edit-agent-schedule-save-button'
        startIcon={snapshot.saving ? <CircularProgress size={14} /> : null}
      >
        {snapshot.saving ? labels.saving : snapshot.existingTask ? labels.update : labels.save}
      </Button>
    </Box>
  );
}

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Locale as MaterialUiCronLocale } from 'material-ui-cron';
import type { AgentDefinition, ScheduledTask, ScheduledTaskClient } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduledTaskEditor } from '../agent/ScheduledTaskEditor.js';

vi.mock('material-ui-cron', () => ({
  default: ({ cron, customLocale, setCron, setCronError }: {
    cron: string;
    customLocale?: MaterialUiCronLocale;
    setCron: (value: string) => void;
    setCronError: (value: string) => void;
  }) => (
    <input
      aria-label='Cron expression'
      data-custom-locale={customLocale?.scheduleTitle}
      value={cron}
      onChange={event => {
        setCron(event.target.value);
        setCronError(event.target.value === 'invalid' ? 'invalid' : '');
      }}
    />
  ),
}));

const definition = { id: 'agent-definition', name: 'Agent' } as AgentDefinition;

function task(timezone: string): ScheduledTask {
  return {
    id: 'task-1',
    agentInstanceId: 'agent-1',
    agentDefinitionId: 'agent-definition',
    name: 'Agent cron',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone },
    enabled: true,
    state: 'active',
    executionNodeId: 'local',
    originNodeId: 'local',
  };
}

function client(existing: ScheduledTask | undefined, previews: ScheduledTaskClient['getCronPreviewDates']): ScheduledTaskClient {
  return {
    listScheduledTasksForAgent: vi.fn().mockResolvedValue({ items: existing ? [existing] : [], hasMoreAfter: false, partial: false, sources: [] }),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    getCronPreviewDates: previews,
  };
}

function customLocale(language: 'fr' | 'ja' | 'ru' | 'zh_TW'): MaterialUiCronLocale {
  const value = (key: string) => `${language}:${key}`;
  return {
    atEveryText: value('atEveryText'),
    betweenText: value('betweenText'),
    inText: value('inText'),
    onText: value('onText'),
    andText: value('andText'),
    onEveryText: value('onEveryText'),
    everyText: value('everyText'),
    atOptionLabel: value('atOptionLabel'),
    everyOptionLabel: value('everyOptionLabel'),
    periodLabel: value('periodLabel'),
    minuteLabel: value('minuteLabel'),
    monthLabel: value('monthLabel'),
    multiDayOfMonthLabel: value('multiDayOfMonthLabel'),
    dayOfMonthLabel: value('dayOfMonthLabel'),
    hourLabel: value('hourLabel'),
    dayOfWeekLabel: value('dayOfWeekLabel'),
    weekDaysOptions: Array.from({ length: 7 }, (_, index) => value(`weekday-${index}`)),
    periodOptions: Array.from({ length: 5 }, (_, index) => value(`period-${index}`)),
    shortMonthOptions: Array.from({ length: 12 }, (_, index) => value(`month-${index}`)),
    onOptionLabel: value('onOptionLabel'),
    lastDayOfMonthLabel: value('lastDayOfMonthLabel'),
    scheduleTitle: value('scheduleTitle'),
    nextRunsLabel: value('nextRunsLabel'),
    noUpcomingRunsText: value('noUpcomingRunsText'),
    noRunsOnDayText: value('noRunsOnDayText'),
    moreRunsText: value('moreRunsText'),
    invalidScheduleText: value('invalidScheduleText'),
    copyLabel: value('copyLabel'),
    copiedText: value('copiedText'),
    resetLabel: value('resetLabel'),
    cronDescriptionText: language,
  };
}

function renderEditor(taskClient: ScheduledTaskClient) {
  return render(
    <ScheduledTaskEditor
      agentDefinition={definition}
      agentInstanceId='agent-1'
      client={taskClient}
      executionTargets={[{ id: 'local', label: 'This device' }]}
      localNodeId='local'
    />,
  );
}

describe('ScheduledTaskEditor validation', () => {
  it('debounces a three-date preview before enabling save', async () => {
    const getCronPreviewDates = vi.fn().mockResolvedValue([
      '2026-08-25T01:00:00.000Z',
      '2026-08-26T01:00:00.000Z',
      '2026-08-27T01:00:00.000Z',
    ]);
    renderEditor(client(task('UTC'), getCronPreviewDates));

    await waitFor(() => {
      expect(getCronPreviewDates).toHaveBeenCalledWith('0 9 * * 1-5', 'UTC', 3, { signal: expect.any(AbortSignal) });
    }, { timeout: 2_000 });
    expect(await screen.findByTestId('schedule-preview-dates')).toHaveTextContent('2026');
    expect(screen.getByTestId('edit-agent-schedule-save-button')).toBeEnabled();
  });

  it('shows a stable invalid-cron error and disables save', async () => {
    renderEditor(client(task('UTC'), vi.fn().mockResolvedValue(['2026-08-25T01:00:00.000Z'])));
    const cron = await screen.findByRole('textbox', { name: 'Cron expression' });
    fireEvent.change(cron, { target: { value: 'invalid' } });

    expect(await screen.findByText('Enter a valid cron schedule.')).toBeInTheDocument();
    expect(screen.getByTestId('edit-agent-schedule-save-button')).toBeDisabled();
  });

  it('rejects an unsupported persisted timezone without calling preview', async () => {
    const getCronPreviewDates = vi.fn();
    renderEditor(client(task('Mars/Olympus'), getCronPreviewDates));

    expect(await screen.findByText('Choose a supported timezone.')).toBeInTheDocument();
    expect(getCronPreviewDates).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-agent-schedule-save-button')).toBeDisabled();
  });

  it.each(['fr', 'ja', 'ru', 'zh_TW'] as const)('passes a complete %s locale to the cron surface', async language => {
    render(
      <ScheduledTaskEditor
        agentDefinition={definition}
        agentInstanceId='agent-1'
        client={client(task('UTC'), vi.fn().mockResolvedValue(['2026-08-25T01:00:00.000Z']))}
        executionTargets={[{ id: 'local', label: 'This device' }]}
        localNodeId='local'
        customLocale={customLocale(language)}
      />,
    );
    expect(await screen.findByRole('textbox', { name: 'Cron expression' })).toHaveAttribute('data-custom-locale', `${language}:scheduleTitle`);
  });

  it('follows an asynchronously resolved local identity until the user explicitly chooses a target', async () => {
    const targets = ['pending', 'peer-local', 'peer-next', 'remote'].map(id => ({ id, label: id }));
    const taskClient = client(undefined, vi.fn().mockResolvedValue(['2026-08-25T01:00:00.000Z']));
    const view = render(
      <ScheduledTaskEditor
        agentDefinition={definition}
        agentInstanceId='agent-1'
        client={taskClient}
        executionTargets={targets}
        localNodeId='pending'
      />,
    );
    await waitFor(() => {
      expect(taskClient.listScheduledTasksForAgent).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByTestId('edit-agent-schedule-mode-select').querySelector('input')!, { target: { value: 'enabled' } });
    view.rerender(
      <ScheduledTaskEditor agentDefinition={definition} agentInstanceId='agent-1' client={taskClient} executionTargets={targets} localNodeId='peer-local' />,
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Runs on device' })).toHaveTextContent('peer-local');
    });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Runs on device' }));
    fireEvent.click(await screen.findByRole('option', { name: 'remote' }));
    view.rerender(
      <ScheduledTaskEditor agentDefinition={definition} agentInstanceId='agent-1' client={taskClient} executionTargets={targets} localNodeId='peer-next' />,
    );
    expect(screen.getByRole('combobox', { name: 'Runs on device' })).toHaveTextContent('remote');
  });

  it('shows partial source provenance and disables schedule mutations', async () => {
    const taskClient = client(task('UTC'), vi.fn().mockResolvedValue(['2026-08-25T01:00:00.000Z']));
    vi.mocked(taskClient.listScheduledTasksForAgent).mockResolvedValue({
      items: [task('UTC')],
      hasMoreAfter: false,
      partial: true,
      sources: [
        { executionNodeId: 'remote', state: 'offline', fromCache: true },
        { executionNodeId: 'local', state: 'degraded', fromCache: false },
      ],
    });
    render(
      <ScheduledTaskEditor
        agentDefinition={definition}
        agentInstanceId='agent-1'
        client={taskClient}
        executionTargets={[{ id: 'local', label: 'This device' }, { id: 'remote', label: 'Remote device' }]}
        localNodeId='local'
      />,
    );

    expect(await screen.findByTestId('scheduled-task-page-partial')).toHaveTextContent('Changes are disabled');
    expect(screen.getByTestId('scheduled-task-source-remote')).toHaveTextContent('Remote device is offline. Remote device is showing cached schedule data.');
    expect(screen.getByTestId('scheduled-task-source-local')).toHaveTextContent('This device is degraded.');
    expect(screen.getByTestId('edit-agent-schedule-save-button')).toBeDisabled();
  });
});

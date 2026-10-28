import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentDefinition, ScheduledTaskClient } from 'memeloop';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduledTaskEditorLabels } from '../agent/scheduling/coreTypes.js';
import { ScheduledTaskFormController } from '../agent/scheduling/ScheduledTaskFormController.js';
import { NativeScheduledTaskEditor } from '../native/ScheduledTaskEditor.js';

const nativeCapture = vi.hoisted(() => ({
  isRTL: false,
  styles: [] as unknown[],
}));

const themeColors = vi.hoisted(() => ({
  error: 'paper-error',
  onPrimary: 'paper-on-primary',
  onSurface: 'paper-on-surface',
  onSurfaceVariant: 'paper-on-surface-variant',
  outline: 'paper-outline',
  primary: 'paper-primary',
  surface: 'paper-surface',
  surfaceVariant: 'paper-surface-variant',
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const recordStyle = (style: unknown): string | undefined => {
    nativeCapture.styles.push(style);
    return style === undefined ? undefined : JSON.stringify(style);
  };
  const View = ({ children, style }: { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement('div', { 'data-native-style': recordStyle(style) }, children);
  const Text = ({ children, style }: { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement('span', { 'data-native-style': recordStyle(style) }, children);
  const Pressable = ({ accessibilityLabel, accessibilityState, children, disabled, onPress, style }: {
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean };
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    style?: unknown;
  }) =>
    ReactModule.createElement('button', {
      'aria-label': accessibilityLabel,
      'aria-pressed': accessibilityState?.selected,
      'data-accessibility-disabled': String(accessibilityState?.disabled ?? false),
      'data-native-style': recordStyle(style),
      disabled,
      onClick: onPress,
      type: 'button',
    }, children);
  const TextInput = ({ accessibilityLabel, onChangeText, style, value }: {
    accessibilityLabel?: string;
    onChangeText?: (value: string) => void;
    style?: unknown;
    value?: string;
  }) =>
    ReactModule.createElement('input', {
      'aria-label': accessibilityLabel,
      'data-native-style': recordStyle(style),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value),
      value,
    });
  return {
    I18nManager: {
      get isRTL() {
        return nativeCapture.isRTL;
      },
    },
    Pressable,
    Text,
    TextInput,
    View,
  };
});

vi.mock('react-native-paper', () => ({
  useTheme: () => ({ colors: themeColors }),
}));

const labels: ScheduledTaskEditorLabels = {
  title: 'Schedule',
  description: 'Wake the agent',
  disabled: 'Disabled',
  enabled: 'Enabled',
  executionTarget: 'Execution target',
  timezone: 'Timezone',
  message: 'Message',
  activeHoursStart: 'Start',
  activeHoursEnd: 'End',
  save: 'Save',
  update: 'Update',
  saving: 'Saving',
  taskSelection: 'Task selection',
  newTask: 'New task',
  scheduleTitle: 'Cron',
  executionTargetUnavailable: 'Target unavailable',
  preview: 'Preview',
  previewLoading: 'Preview loading',
  invalidCron: 'Invalid cron',
  invalidTimezone: 'Invalid timezone',
  noPreview: 'No preview',
  operationFailed: 'Operation failed',
  sourceIncomplete: 'Sources incomplete',
  sourceOnline: target => `${target} online`,
  sourceOffline: target => `${target} offline`,
  sourceDegraded: target => `${target} degraded`,
  sourceCached: target => `${target} cached`,
  defaultTaskName: name => `${name} schedule`,
  defaultMessage: 'Check work',
};

const executionTargets = [
  { id: 'available', label: 'Available device' },
  { id: 'offline', label: 'Offline device', disabled: true },
] as const;

function controller(): ScheduledTaskFormController {
  const client: ScheduledTaskClient = {
    listScheduledTasksForAgent: vi.fn().mockResolvedValue({ items: [], hasMoreAfter: false, partial: false, sources: [] }),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    getCronPreviewDates: vi.fn().mockResolvedValue(['2026-08-26T09:00:00.000Z']),
  };
  return new ScheduledTaskFormController({
    agentDefinition: { id: 'definition', name: 'Agent' } as AgentDefinition,
    agentInstanceId: 'conversation',
    client,
    executionTargets,
    localNodeId: 'local-peer',
    labels,
    previewDebounceMs: 0,
  });
}

describe('NativeScheduledTaskEditor accessibility', () => {
  beforeEach(() => {
    nativeCapture.isRTL = false;
    nativeCapture.styles.length = 0;
  });

  it('uses logical RTL rows, semantic Paper colors and explicit selected/disabled states', () => {
    nativeCapture.isRTL = true;
    const form = controller();
    render(<NativeScheduledTaskEditor controller={form} dateLocale='en' executionTargets={executionTargets} labels={labels} />);

    expect(screen.getByRole('button', { name: labels.newTask })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: labels.disabled })).toHaveAttribute('aria-pressed', 'true');
    expect(nativeCapture.styles).toContainEqual(expect.objectContaining({ flexDirection: 'row-reverse' }));

    fireEvent.click(screen.getByRole('button', { name: labels.enabled }));
    const offline = screen.getByRole('button', { name: 'Offline device' });
    expect(offline).toBeDisabled();
    expect(offline).toHaveAttribute('data-accessibility-disabled', 'true');
    expect(screen.getByRole('button', { name: labels.save })).toHaveAttribute('data-accessibility-disabled', 'true');

    const cronStyle = JSON.parse(screen.getByRole('textbox', { name: labels.scheduleTitle }).getAttribute('data-native-style') ?? '{}') as Record<string, unknown>;
    expect(cronStyle).toMatchObject({ minHeight: 44, borderColor: themeColors.outline, color: themeColors.onSurface });
    expect(nativeCapture.styles).toContainEqual(expect.objectContaining({ backgroundColor: themeColors.surface }));
    form.dispose();
  });

  it('keeps every press target at least 44 logical pixels high', () => {
    const form = controller();
    render(<NativeScheduledTaskEditor controller={form} executionTargets={executionTargets} labels={labels} />);

    for (const button of screen.getAllByRole('button')) {
      const style = JSON.parse(button.getAttribute('data-native-style') ?? '{}') as Record<string, unknown>;
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
    form.dispose();
  });
});

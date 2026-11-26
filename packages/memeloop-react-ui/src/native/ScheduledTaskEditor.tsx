import React, { useSyncExternalStore } from 'react';
// Optional peer resolved by React Native hosts and shimmed for package builds.
import { I18nManager, Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from 'react-native-paper';

import type { ScheduledTaskEditorLabels, ScheduledTaskExecutionTarget } from '../agent/scheduling/coreTypes.js';
import type { ScheduledTaskFormController } from '../agent/scheduling/ScheduledTaskFormController.js';

export interface NativeScheduledTaskEditorProps {
  controller: ScheduledTaskFormController;
  executionTargets: readonly ScheduledTaskExecutionTarget[];
  labels: ScheduledTaskEditorLabels;
  dateLocale?: string | readonly string[];
}

function formatPreviewDate(value: string, timezone: string, locale?: string | readonly string[]): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale as string | string[] | undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: timezone,
    }).format(date);
  } catch {
    return value;
  }
}

/** Narrow-first Native form. Cron validation/preview always comes from ScheduledTaskClient. */
export function NativeScheduledTaskEditor({ controller, dateLocale, executionTargets, labels }: NativeScheduledTaskEditorProps): React.ReactElement {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { colors } = useTheme();
  const { value } = snapshot;
  const logicalRowDirection = I18nManager.isRTL ? 'row-reverse' : 'row';
  const previewValid = snapshot.preview.status === 'ready' && snapshot.preview.dates.length > 0;
  const saveDisabled = snapshot.pageStatus.partial || snapshot.loading || snapshot.saving || (value.enabled && (snapshot.executionTargetUnavailable || !previewValid));

  const field = (
    label: string,
    current: string,
    update: (next: string) => void,
    multiline = false,
  ) => (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.onSurface }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        multiline={multiline}
        value={current}
        onChangeText={update}
        style={{ minHeight: multiline ? 72 : 44, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: colors.onSurface }}
      />
    </View>
  );

  return (
    <View style={{ gap: 12, padding: 12, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: '600' }}>{labels.title}</Text>
      <Text style={{ color: colors.onSurface }}>{labels.description}</Text>
      {snapshot.pageStatus.partial && <Text accessibilityRole='alert' style={{ color: colors.primary }}>{labels.sourceIncomplete}</Text>}
      {snapshot.pageStatus.sources.filter(source => source.state !== 'online' || source.fromCache).map(source => {
        const target = executionTargets.find(candidate => candidate.id === source.executionNodeId)?.label ?? source.executionNodeId;
        const messages = [
          source.state === 'offline' ? labels.sourceOffline(target) : source.state === 'degraded' ? labels.sourceDegraded(target) : undefined,
          source.fromCache ? labels.sourceCached(target) : undefined,
        ].filter((item): item is string => !!item);
        return (
          <Text key={source.executionNodeId} accessibilityRole='alert' style={{ color: source.state === 'offline' ? colors.error : colors.primary }}>{messages.join(' ')}</Text>
        );
      })}
      <View style={{ gap: 4 }}>
        <Text style={{ color: colors.onSurface }}>{labels.taskSelection}</Text>
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={labels.newTask}
            accessibilityState={{ selected: snapshot.selectedTaskId === undefined }}
            onPress={() => {
              controller.selectTask(undefined);
            }}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderRadius: 8,
              backgroundColor: snapshot.selectedTaskId === undefined ? colors.primary : colors.surfaceVariant,
            }}
          >
            <Text style={{ color: snapshot.selectedTaskId === undefined ? colors.onPrimary : colors.onSurfaceVariant }}>{labels.newTask}</Text>
          </Pressable>
          {snapshot.tasks.map(task => {
            const source = snapshot.pageStatus.sources.find(candidate => candidate.executionNodeId === task.executionNodeId);
            const target = task.executionNodeLabel?.trim() || task.executionNodeId;
            const sourceText = source
              ? [
                source.state === 'offline'
                  ? labels.sourceOffline(target)
                  : source.state === 'degraded'
                  ? labels.sourceDegraded(target)
                  : labels.sourceOnline(target),
                source.fromCache ? labels.sourceCached(target) : undefined,
              ].filter((item): item is string => !!item).join(' ')
              : target;
            const selected = snapshot.selectedTaskId === task.id;
            return (
              <Pressable
                key={task.id}
                accessibilityRole='button'
                accessibilityLabel={task.name}
                onPress={() => {
                  controller.selectTask(task.id);
                }}
                accessibilityState={{ selected }}
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 8, backgroundColor: selected ? colors.primary : colors.surfaceVariant }}
              >
                <Text style={{ color: selected ? colors.onPrimary : colors.onSurfaceVariant, fontWeight: '600' }}>{task.name}</Text>
                <Text style={{ color: selected ? colors.onPrimary : colors.onSurfaceVariant, fontSize: 12 }}>{sourceText}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flexDirection: logicalRowDirection, gap: 8 }}>
        {([false, true] as const).map(enabled => (
          <Pressable
            key={String(enabled)}
            accessibilityRole='button'
            accessibilityLabel={enabled ? labels.enabled : labels.disabled}
            onPress={() => {
              controller.setValue({ enabled });
            }}
            accessibilityState={{ selected: value.enabled === enabled }}
            style={{
              minHeight: 44,
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: 8,
              backgroundColor: value.enabled === enabled ? colors.primary : colors.surfaceVariant,
            }}
          >
            <Text style={{ color: value.enabled === enabled ? colors.onPrimary : colors.onSurfaceVariant }}>{enabled ? labels.enabled : labels.disabled}</Text>
          </Pressable>
        ))}
      </View>
      {value.enabled && (
        <>
          {field(labels.scheduleTitle, value.expression, expression => {
            controller.setValue({ expression });
          })}
          {field(labels.timezone, value.timezone, timezone => {
            controller.setValue({ timezone });
          })}
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.onSurface }}>{labels.executionTarget}</Text>
            <View style={{ flexDirection: logicalRowDirection, flexWrap: 'wrap', gap: 8 }}>
              {executionTargets.map(target => (
                <Pressable
                  key={target.id}
                  accessibilityRole='button'
                  accessibilityLabel={target.label}
                  disabled={target.disabled}
                  onPress={() => {
                    controller.setValue({ executionNodeId: target.id }, { manualExecutionTarget: true });
                  }}
                  style={{
                    minHeight: 44,
                    justifyContent: 'center',
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    opacity: target.disabled ? 0.5 : 1,
                    backgroundColor: value.executionNodeId === target.id ? colors.primary : colors.surfaceVariant,
                  }}
                  accessibilityState={{ disabled: target.disabled, selected: value.executionNodeId === target.id }}
                >
                  <Text style={{ color: value.executionNodeId === target.id ? colors.onPrimary : colors.onSurfaceVariant }}>{target.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          {field(labels.message, value.message, message => {
            controller.setValue({ message });
          }, true)}
          {field(labels.activeHoursStart, value.activeHoursStart, activeHoursStart => {
            controller.setValue({ activeHoursStart });
          })}
          {field(labels.activeHoursEnd, value.activeHoursEnd, activeHoursEnd => {
            controller.setValue({ activeHoursEnd });
          })}
          <View accessibilityRole='summary' style={{ gap: 4 }}>
            <Text style={{ color: colors.onSurface, fontWeight: '600' }}>{labels.preview}</Text>
            {snapshot.preview.status === 'loading' && <Text style={{ color: colors.onSurfaceVariant }}>{labels.previewLoading}</Text>}
            {snapshot.preview.status === 'error' && <Text accessibilityRole='alert' style={{ color: colors.error }}>{snapshot.preview.error}</Text>}
            {snapshot.preview.dates.map(date => <Text key={date} style={{ color: colors.onSurface }}>{formatPreviewDate(date, value.timezone, dateLocale)}</Text>)}
          </View>
        </>
      )}
      {snapshot.executionTargetUnavailable && value.enabled && <Text accessibilityRole='alert' style={{ color: colors.primary }}>{labels.executionTargetUnavailable}</Text>}
      {snapshot.error && <Text accessibilityRole='alert' style={{ color: colors.error }}>{snapshot.error}</Text>}
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={snapshot.saving ? labels.saving : snapshot.existingTask ? labels.update : labels.save}
        accessibilityState={{ disabled: saveDisabled }}
        disabled={saveDisabled}
        onPress={() => {
          void controller.save();
        }}
        style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 8, opacity: saveDisabled ? 0.5 : 1, backgroundColor: colors.primary }}
      >
        <Text style={{ color: colors.onPrimary }}>{snapshot.saving ? labels.saving : snapshot.existingTask ? labels.update : labels.save}</Text>
      </Pressable>
    </View>
  );
}

import React from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { ActivityIndicator, Button, IconButton, TextInput, useTheme } from 'react-native-paper';
import { defaultGoalPanelLabels, type GoalPanelProps } from '../agent/goals.js';
import { useGoalPanel } from '../agent/useGoalPanel.js';

export function NativeGoalPanel({ labels = defaultGoalPanelLabels, ...props }: GoalPanelProps): React.ReactElement {
  const state = useGoalPanel(props);
  const { goal, busy } = state;
  const { colors } = useTheme();
  return (
    <View accessibilityLabel={labels.title} style={{ gap: 16 }}>
      <Text style={{ color: colors.onSurfaceVariant }}>{labels.description}</Text>
      {state.loading && (
        <View accessibilityLabel={labels.loading}>
          <ActivityIndicator />
        </View>
      )}
      {state.failed && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole='alert' style={{ color: colors.error }}>{labels.failed}</Text>
          <Button disabled={busy} onPress={state.retry}>{labels.retry}</Button>
        </View>
      )}
      {goal && (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <View style={{ borderRadius: 16, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: colors.surfaceVariant }}>
              <Text style={{ color: goal.status === 'active' ? colors.primary : colors.onSurfaceVariant }}>{labels.status[goal.status]}</Text>
            </View>
            <Text style={{ color: colors.onSurfaceVariant }}>{labels.round(goal.round)}</Text>
          </View>
          <Text selectable style={{ color: colors.onSurface, fontSize: 16, lineHeight: 24 }}>{goal.objective}</Text>
          {goal.blockedReason && <Text style={{ color: colors.onSurfaceVariant }}>{goal.blockedReason}</Text>}
          {goal.lastRunError && <Text accessibilityRole='alert' style={{ color: colors.error }}>{labels.runIssue}</Text>}
          {goal.evidence && <Text selectable style={{ color: colors.onSurface }}>{goal.evidence}</Text>}
        </>
      )}
      {!state.loading && !state.failed && (!goal || goal.status === 'completed') && (
        <>
          <TextInput
            label={labels.objective}
            accessibilityLabel={labels.objective}
            mode='outlined'
            multiline
            style={{ minHeight: 104 }}
            value={state.objective}
            disabled={busy}
            onChangeText={state.setObjective}
          />
          <Button mode='contained' disabled={busy || !state.objective.trim()} onPress={() => void state.start()}>{labels.start}</Button>
        </>
      )}
      {goal && goal.status !== 'completed' && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button mode='contained' disabled={busy} onPress={() => void (goal.status === 'active' ? state.pause() : state.resume())}>
            {goal.status === 'active' ? labels.pause : labels.resume}
          </Button>
          {!state.completing && (
            <Button
              disabled={busy}
              onPress={() => {
                state.setCompleting(true);
              }}
            >
              {labels.complete}
            </Button>
          )}
        </View>
      )}
      {state.completing && goal && goal.status !== 'completed' && (
        <>
          <TextInput
            label={labels.evidence}
            accessibilityLabel={labels.evidence}
            mode='outlined'
            multiline
            style={{ minHeight: 80 }}
            value={state.evidence}
            disabled={busy}
            onChangeText={state.setEvidence}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button mode='contained' disabled={busy || !state.evidence.trim()} onPress={() => void state.complete()}>{labels.confirmComplete}</Button>
            <Button
              disabled={busy}
              onPress={() => {
                state.setCompleting(false);
              }}
            >
              {labels.cancel}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

/** Insets are supplied by the host's existing SafeAreaProvider. */
export function NativeGoalDialog({ onClose, topInset = 0, bottomInset = 0, labels = defaultGoalPanelLabels, ...props }: GoalPanelProps & {
  onClose: () => void;
  topInset?: number;
  bottomInset?: number;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Modal visible animationType='slide' onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: topInset }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
          <IconButton icon='arrow-left' accessibilityLabel={labels.back} onPress={onClose} />
          <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: '600' }}>{labels.title}</Text>
        </View>
        <ScrollView
          keyboardShouldPersistTaps='handled'
          automaticallyAdjustKeyboardInsets
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 16 + bottomInset }}
        >
          <NativeGoalPanel {...props} labels={labels} />
        </ScrollView>
      </View>
    </Modal>
  );
}

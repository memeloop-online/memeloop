import type { ConversationEditingAdapter } from 'memeloop';
import React, { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import { defaultMessageEditorLabels, type MessageEditorLabels, useMessageEditor } from '../chat/useMessageEditor.js';

export function NativeMessageEditor({ messageId, adapter, disabled, labels: overrides, onError, children, renderBubble, onCopy, copyLabel }: {
  messageId: string;
  adapter: ConversationEditingAdapter;
  disabled?: boolean;
  labels?: Partial<MessageEditorLabels>;
  onError: (error: unknown, operation: 'edit-message' | 'save-draft' | 'switch-branch') => void;
  children?: React.ReactNode;
  renderBubble?: (reveal: () => void) => React.ReactNode;
  onCopy?: () => void;
  copyLabel?: string;
}) {
  const labels = { ...defaultMessageEditorLabels, ...overrides };
  const editor = useMessageEditor(messageId, adapter, onError);
  const { colors } = useTheme();
  const [actionsVisible, setActionsVisible] = useState(false);
  const button = (label: string, onPress: () => void, unavailable = false) => (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      disabled={editor.busy || unavailable}
      accessibilityState={{ disabled: editor.busy || unavailable }}
      onPress={onPress}
      style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 }}
    >
      <Text style={{ color: colors.primary }}>{label}</Text>
    </Pressable>
  );
  const branch = editor.branch;
  return (
    <Pressable
      testID={`message-actions-${messageId}`}
      onHoverIn={() => {
        setActionsVisible(true);
      }}
      onHoverOut={() => {
        setActionsVisible(false);
      }}
      onFocus={() => {
        setActionsVisible(true);
      }}
      style={{ alignItems: 'flex-end' }}
    >
      {renderBubble
        ? renderBubble(() => {
          setActionsVisible(value => !value);
        })
        : children}
      {actionsVisible && (
        <View testID='message-actions-toolbar' style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 8 }}>
          {onCopy && button(copyLabel ?? 'Copy', onCopy)}
          {button(labels.edit, editor.open, disabled)}
        </View>
      )}
      {branch && branch.alternatives.length > 1 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          {button(labels.previousBranch, () => {
            editor.switchBranch(branch.selected - 1);
          }, disabled || branch.selected <= 0)}
          <Text style={{ color: colors.onSurface }}>{branch.selected + 1} / {branch.alternatives.length}</Text>
          {button(labels.nextBranch, () => {
            editor.switchBranch(branch.selected + 1);
          }, disabled || branch.selected >= branch.alternatives.length - 1)}
        </View>
      )}
      <Modal
        visible={editor.editing}
        transparent
        animationType='fade'
        onRequestClose={() => {
          if (!editor.busy) editor.close();
        }}
      >
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.backdrop, padding: 16 }}>
          <View style={{ backgroundColor: colors.surface, padding: 12, borderRadius: 12 }}>
            <TextInput
              autoFocus
              multiline
              accessibilityLabel={labels.input}
              value={editor.text}
              editable={!editor.busy}
              onChangeText={editor.change}
              onKeyPress={event => {
                if (event.nativeEvent.key === 'Escape' && !editor.busy) editor.close();
              }}
              style={{ color: colors.onSurface, minHeight: 96, maxHeight: 320, borderColor: colors.outline, borderWidth: 1, padding: 8 }}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {button(labels.send, editor.submit, disabled || !editor.text.trim())}
              {button(labels.discard, editor.discard)}
              {button(labels.saveDraft, editor.close)}
            </View>
            {editor.conflict && (
              <View accessibilityRole='alert'>
                <Text style={{ color: colors.error }}>{labels.conflict}</Text>
                {button(labels.reloadDraft, editor.reload)}
              </View>
            )}
          </View>
        </View>
      </Modal>
    </Pressable>
  );
}

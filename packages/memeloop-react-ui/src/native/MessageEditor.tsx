import type { ConversationEditingAdapter } from 'memeloop';
import React, { useEffect, useState } from 'react';
import { BackHandler, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { Button, IconButton, useTheme } from 'react-native-paper';
import { defaultMessageEditorLabels, type MessageEditorLabels, useMessageEditor } from '../chat/useMessageEditor.js';

export function NativeMessageActions({ messageId, renderBubble, children, actions, side = 'right', footer, closeLabel = 'Close' }: {
  messageId: string;
  renderBubble?: (reveal: () => void) => React.ReactNode;
  children?: React.ReactNode;
  actions: React.ReactNode;
  side?: 'left' | 'right';
  footer?: React.ReactNode;
  closeLabel?: string;
}) {
  const [actionsVisible, setActionsVisible] = useState(false);
  const { colors } = useTheme();
  const reveal = () => {
    setActionsVisible(true);
  };
  useEffect(() => {
    if (!actionsVisible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setActionsVisible(false);
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [actionsVisible]);
  return (
    <Pressable
      testID={`message-actions-${messageId}`}
      onHoverIn={reveal}
      onHoverOut={() => {
        setActionsVisible(false);
      }}
      onFocus={reveal}
      style={{ flex: 1, minWidth: 0, maxWidth: '100%', alignItems: 'stretch' }}
    >
      {renderBubble ? renderBubble(reveal) : children}
      {actionsVisible && (
        <View
          testID='message-actions-toolbar'
          pointerEvents={actionsVisible ? 'auto' : 'none'}
          accessibilityElementsHidden={!actionsVisible}
          importantForAccessibility={actionsVisible ? 'auto' : 'no-hide-descendants'}
          style={{
            minHeight: 44,
            alignSelf: side === 'right' ? 'flex-end' : 'flex-start',
            flexDirection: 'row',
            opacity: actionsVisible ? 1 : 0,
            backgroundColor: colors.surface,
            borderRadius: 8,
          }}
        >
          {actions}
          <IconButton
            icon='close'
            accessibilityLabel={closeLabel}
            onPress={() => {
              setActionsVisible(false);
            }}
          />
        </View>
      )}
      {footer}
    </Pressable>
  );
}

export function NativeMessageEditor({ messageId, adapter, disabled, labels: overrides, onError, children, renderBubble, onCopy, copyLabel, closeLabel }: {
  messageId: string;
  adapter: ConversationEditingAdapter;
  disabled?: boolean;
  labels?: Partial<MessageEditorLabels>;
  onError: (error: unknown, operation: 'edit-message' | 'save-draft' | 'switch-branch') => void;
  children?: React.ReactNode;
  renderBubble?: (reveal: () => void) => React.ReactNode;
  onCopy?: () => void;
  copyLabel?: string;
  closeLabel?: string;
}) {
  const labels = { ...defaultMessageEditorLabels, ...overrides };
  const editor = useMessageEditor(messageId, adapter, onError);
  const { colors } = useTheme();
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
    <NativeMessageActions
      messageId={messageId}
      closeLabel={closeLabel}
      renderBubble={renderBubble}
      actions={
        <>
          {onCopy && <IconButton icon='content-copy' accessibilityLabel={copyLabel ?? 'Copy'} onPress={onCopy} />}
          <IconButton icon='pencil-outline' accessibilityLabel={labels.edit} disabled={editor.busy || disabled} onPress={editor.open} />
        </>
      }
      footer={
        <>
          {branch && branch.alternatives.length > 1 && (
            <View style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center' }}>
              <IconButton
                icon='chevron-left'
                accessibilityLabel={labels.previousBranch}
                disabled={editor.busy || disabled || branch.selected <= 0}
                onPress={() => {
                  editor.switchBranch(branch.selected - 1);
                }}
              />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>{branch.selected + 1} / {branch.alternatives.length}</Text>
              <IconButton
                icon='chevron-right'
                accessibilityLabel={labels.nextBranch}
                disabled={editor.busy || disabled || branch.selected >= branch.alternatives.length - 1}
                onPress={() => {
                  editor.switchBranch(branch.selected + 1);
                }}
              />
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
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                  <Button disabled={editor.busy} onPress={editor.discard}>{labels.discard}</Button>
                  <Button disabled={editor.busy} onPress={editor.close}>{labels.saveDraft}</Button>
                  <Button mode='contained' disabled={editor.busy || disabled || !editor.text.trim()} onPress={editor.submit}>{labels.send}</Button>
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
        </>
      }
    >
      {children}
    </NativeMessageActions>
  );
}

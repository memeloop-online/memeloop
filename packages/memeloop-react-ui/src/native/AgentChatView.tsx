/**
 * NativeAgentChatView — React Native chat surface for MemeLoop adapters.
 *
 * This mirrors the web AgentChatView at the host boundary: hosts provide a
 * MemeLoopChatAdapter, while the component owns only message display and input.
 *
 * eslint-disable-next-line import/no-unresolved — react-native and react-native-paper
 * are optional peer dependencies resolved by the host at runtime; the type shim
 * at src/native/react-native-shim.d.ts provides stubs for package dts builds.
 */

/* eslint-disable import/no-unresolved */
import type { ChatMessage } from 'memeloop';
import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Card, IconButton, Text, TextInput } from 'react-native-paper';
/* eslint-enable import/no-unresolved */

import type { MemeLoopChatAdapter } from '../chat/types.js';

export interface NativeAgentChatViewProps {
  adapter: MemeLoopChatAdapter;
  title?: string;
  placeholder?: string;
  emptyMessage?: string;
  loadingMessage?: string;
  disabled?: boolean;
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => React.ReactNode;
}

function MessageBubble({
  message,
  renderMessageContent,
}: {
  message: ChatMessage;
  renderMessageContent?: NativeAgentChatViewProps['renderMessageContent'];
}) {
  const isUser = message.role === 'user';
  return (
    <View style={[styles.messageRow, isUser ? styles.userRow : styles.agentRow]}>
      <Card mode='outlined' style={[styles.messageCard, isUser ? styles.userCard : styles.agentCard]}>
        <Card.Content>
          <Text variant='labelSmall' style={styles.roleLabel}>
            {isUser ? 'You' : message.role === 'assistant' ? 'Agent' : message.role}
          </Text>
          {renderMessageContent
            ? renderMessageContent(message, isUser)
            : <Text variant='bodyMedium'>{message.content}</Text>}
        </Card.Content>
      </Card>
    </View>
  );
}

export function NativeAgentChatView({
  adapter,
  title = 'Agent',
  placeholder = 'Type a message...',
  emptyMessage = 'Start a conversation',
  loadingMessage = 'Loading chat...',
  disabled,
  renderMessageContent,
}: NativeAgentChatViewProps): React.ReactElement {
  const [inputText, setInputText] = useState('');

  const canSend = inputText.trim().length > 0 && !adapter.isRunning && !disabled;
  const messages = useMemo(() => [...adapter.messages], [adapter.messages]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    await adapter.sendMessage({ text });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text variant='titleMedium'>{title}</Text>
        </View>
        {adapter.isRunning && (
          <IconButton
            icon='stop-circle-outline'
            accessibilityLabel='Cancel response'
            onPress={() => {
              void adapter.cancel();
            }}
          />
        )}
      </View>

      {adapter.isLoading && messages.length === 0
        ? (
          <View style={styles.centerState}>
            <ActivityIndicator />
            <Text style={styles.centerText}>{loadingMessage}</Text>
          </View>
        )
        : adapter.error && messages.length === 0
        ? (
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{adapter.error.message}</Text>
          </View>
        )
        : messages.length === 0
        ? (
          <View style={styles.centerState}>
            <Text style={styles.centerText}>{emptyMessage}</Text>
          </View>
        )
        : (
          <FlatList
            style={styles.messages}
            data={messages}
            keyExtractor={(message: ChatMessage) => message.messageId}
            renderItem={({ item }: { item: ChatMessage }) => <MessageBubble message={item} renderMessageContent={renderMessageContent} />}
          />
        )}

      <View style={styles.composer}>
        <TextInput
          mode='outlined'
          value={inputText}
          placeholder={adapter.isRunning ? 'Waiting for response...' : placeholder}
          disabled={adapter.isRunning || disabled}
          multiline
          style={styles.input}
          onChangeText={setInputText}
        />
        <Button
          mode='contained'
          disabled={!canSend}
          onPress={() => {
            void handleSend();
          }}
        >
          Send
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerText: {
    flex: 1,
  },
  centerState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  centerText: {
    marginTop: 12,
    opacity: 0.7,
    textAlign: 'center',
  },
  errorText: {
    color: '#b00020',
    textAlign: 'center',
  },
  messages: {
    flex: 1,
    paddingHorizontal: 12,
  },
  messageRow: {
    flexDirection: 'row',
    marginVertical: 6,
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  agentRow: {
    justifyContent: 'flex-start',
  },
  messageCard: {
    maxWidth: '86%',
  },
  userCard: {
    backgroundColor: '#e8f1ff',
  },
  agentCard: {
    backgroundColor: '#ffffff',
  },
  roleLabel: {
    marginBottom: 4,
    opacity: 0.65,
    textTransform: 'uppercase',
  },
  composer: {
    gap: 8,
    padding: 12,
  },
  input: {
    maxHeight: 120,
  },
});

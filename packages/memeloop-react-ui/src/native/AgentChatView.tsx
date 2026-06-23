/**
 * NativeAgentChatView — React Native chat surface for MemeLoop adapters.
 *
 * Built on react-native-gifted-chat so we don't re-implement message bubbles,
 * composer, avatars, typing indicators or scroll behaviour.
 */

import type { ChatMessage } from 'memeloop';
import React, { useCallback, useMemo, useState } from 'react';
// Optional peer resolved by React Native hosts and shimmed for package builds.
// eslint-disable-next-line import/no-unresolved
import { Pressable, Text, View } from 'react-native';
import { GiftedChat, type IMessage, type User } from 'react-native-gifted-chat';

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

function toGiftedMessage(message: ChatMessage): IMessage {
  const isUser = message.role === 'user';
  return {
    _id: message.messageId,
    text: message.content,
    createdAt: message.timestamp,
    user: {
      _id: isUser ? 'user' : 'agent',
      name: isUser ? 'You' : 'Agent',
    } satisfies User,
  };
}

function findUserMessageId(messages: readonly ChatMessage[], giftedId: string): string | undefined {
  const index = messages.findIndex(message => message.messageId === giftedId);
  if (index < 0) return undefined;

  // GiftedChat calls onLongPress/onDelete for the message the user interacted with.
  // For assistant messages we operate on the preceding user turn.
  let target = messages[index];
  if (target.role !== 'user') {
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      if (messages[previousIndex].role === 'user') {
        target = messages[previousIndex];
        break;
      }
    }
  }
  return target.role === 'user' ? target.messageId : undefined;
}

export function NativeAgentChatView({
  adapter,
  placeholder = 'Type a message...',
  disabled: _disabled,
}: NativeAgentChatViewProps): React.ReactElement {
  const [details, setDetails] = useState<Record<string, string>>({});
  const messages = useMemo(() => adapter.messages.map(toGiftedMessage), [adapter.messages]);
  const messageById = useMemo(() => new Map(adapter.messages.map(message => [message.messageId, message])), [adapter.messages]);

  const handleSend = useCallback(
    (giftedMessages: IMessage[]) => {
      const text = giftedMessages[0]?.text ?? '';
      if (!text.trim()) return;
      void adapter.sendMessage({ text });
    },
    [adapter],
  );

  const handleLongPress = useCallback(
    (_context: unknown, giftedMessage: IMessage) => {
      const userMessageId = findUserMessageId(adapter.messages, giftedMessage._id);
      if (!userMessageId) return;
      void adapter.retryTurn(userMessageId);
    },
    [adapter],
  );

  const handleDelete = useCallback(
    (giftedMessage: IMessage) => {
      const userMessageId = findUserMessageId(adapter.messages, giftedMessage._id);
      if (!userMessageId) return;
      void adapter.deleteTurn(userMessageId);
    },
    [adapter],
  );

  const handleTargetChange = useCallback(
    (targetId: string) => {
      void adapter.setExecutionTarget?.(targetId, { restartCurrentTurn: adapter.isRunning });
    },
    [adapter],
  );

  const renderFooter = useCallback(
    (giftedMessage: IMessage) => {
      const message = messageById.get(giftedMessage._id);
      if (!message?.detailRef || !adapter.loadMessageDetail) return null;
      const loaded = details[message.messageId];
      return (
        <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
          <Pressable
            onPress={() => {
              void adapter.loadMessageDetail?.(message).then(payload => {
                const text = typeof payload === 'string'
                  ? payload
                  : Array.isArray(payload)
                  ? (payload as readonly ChatMessage[]).map(item => `${item.role}: ${item.content}`).join('\n\n')
                  : 'No details available.';
                setDetails(current => ({ ...current, [message.messageId]: text }));
              });
            }}
          >
            <Text style={{ color: '#2563eb', fontSize: 12 }}>{loaded ? 'Reload details' : 'Load details'}</Text>
          </Pressable>
          {loaded && <Text style={{ fontSize: 12, color: '#374151' }}>{loaded}</Text>}
        </View>
      );
    },
    [adapter, details, messageById],
  );

  return (
    <View style={{ flex: 1 }}>
      {adapter.executionTargets && adapter.setExecutionTarget && adapter.executionTargets.length > 1 && (
        <View style={{ flexDirection: 'row', gap: 8, padding: 8 }}>
          {adapter.executionTargets.map(target => (
            <Pressable
              key={target.id}
              disabled={target.disabled}
              onPress={() => {
                handleTargetChange(target.id);
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: target.id === adapter.activeExecutionTargetId ? '#2563eb' : '#e5e7eb' }}
            >
              <Text style={{ color: target.id === adapter.activeExecutionTargetId ? '#fff' : '#111827' }}>{target.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <GiftedChat
        messages={messages}
        onSend={handleSend}
        user={{ _id: 'user' }}
        placeholder={adapter.isRunning ? 'Waiting for response...' : placeholder}
        isTyping={adapter.isRunning}
        onLongPress={handleLongPress}
        renderCustomView={renderFooter}
        onDelete={handleDelete}
        inverted
      />
    </View>
  );
}

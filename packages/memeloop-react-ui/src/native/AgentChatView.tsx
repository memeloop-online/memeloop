/**
 * NativeAgentChatView — React Native chat surface for MemeLoop adapters.
 *
 * Built on react-native-gifted-chat so we don't re-implement message bubbles,
 * composer, avatars, typing indicators or scroll behaviour.
 */

import type { ChatMessage } from 'memeloop';
import React, { useCallback, useMemo } from 'react';
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
  const messages = useMemo(() => adapter.messages.map(toGiftedMessage), [adapter.messages]);

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

  return (
    <GiftedChat
      messages={messages}
      onSend={handleSend}
      user={{ _id: 'user' }}
      placeholder={adapter.isRunning ? 'Waiting for response...' : placeholder}
      isTyping={adapter.isRunning}
      onLongPress={handleLongPress}
      // @ts-expect-error react-native-gifted-chat supports onDelete in practice but ships no types.
      onDelete={handleDelete}
      inverted
    />
  );
}

import { type ChatMessage, getChatMessageParts, projectChatMessageParts } from 'memeloop';
import type { TUIMessage } from './types.js';

export function chatMessageToTUIMessage(message: ChatMessage): TUIMessage {
  const parts = getChatMessageParts(message);
  const projection = projectChatMessageParts(parts);
  return {
    id: message.messageId,
    role: message.role as TUIMessage['role'],
    content: projection.content || (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)),
    timestamp: new Date(message.timestamp || Date.now()),
    thinking: projection.reasoning_content ?? (typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined),
  };
}

export function chatMessagesToTUIMessages(messages: readonly ChatMessage[]): TUIMessage[] {
  return messages.map(chatMessageToTUIMessage);
}

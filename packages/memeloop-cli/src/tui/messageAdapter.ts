import type { ChatMessage } from 'memeloop';
import type { TUIMessage } from './types.js';

export function chatMessageToTUIMessage(message: ChatMessage): TUIMessage {
  return {
    id: message.messageId,
    role: message.role as TUIMessage['role'],
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    timestamp: new Date(message.timestamp || Date.now()),
    thinking: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
  };
}

export function chatMessagesToTUIMessages(messages: readonly ChatMessage[]): TUIMessage[] {
  return messages.map(chatMessageToTUIMessage);
}

import type { ConversationMessageListProjection } from 'memeloop';

/** GiftedChat receives the resident messages in reverse display order. */
export function invertedMessageIndex(
  messages: readonly ConversationMessageListProjection[],
  messageId: string | undefined,
): number {
  if (!messageId) return -1;
  const displayIndex = messages.findIndex(message => message.messageId === messageId);
  return displayIndex < 0 ? -1 : messages.length - displayIndex - 1;
}

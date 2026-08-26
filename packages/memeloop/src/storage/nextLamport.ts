import type { ConversationEventStore } from './ports.js';

/**
 * 下一条消息的 Lamport 时钟：取会话内持久化索引的最大 lamportClock + 1。
 * Depends only on the narrow ConversationEventStore port (plan 24.41).
 */
export async function nextLamportClockForConversation(
  storage: ConversationEventStore,
  conversationId: string,
): Promise<number> {
  if (typeof storage.getMaxLamportClockForConversation !== 'function') {
    throw new Error('indexed Lamport clock reader unavailable');
  }
  const max = await storage.getMaxLamportClockForConversation(conversationId);
  if (!Number.isSafeInteger(max) || max < 0 || max >= Number.MAX_SAFE_INTEGER) {
    throw new Error('invalid persisted Lamport clock');
  }
  return max + 1;
}

import type { IAgentStorage } from '../types.js';

/**
 * 下一条消息的 Lamport 时钟：取会话内已有消息的最大 lamportClock + 1。
 */
export async function nextLamportClockForConversation(
  storage: IAgentStorage,
  conversationId: string,
): Promise<number> {
  if (typeof storage.getMaxLamportClockForConversation === 'function') {
    const max = await storage.getMaxLamportClockForConversation(conversationId);
    return max + 1;
  }
  const msgs = await storage.getMessages(conversationId, { mode: 'full-content' });
  let max = 0;
  for (const m of msgs) {
    if (typeof m.lamportClock === 'number' && m.lamportClock > max) {
      max = m.lamportClock;
    }
  }
  return max + 1;
}

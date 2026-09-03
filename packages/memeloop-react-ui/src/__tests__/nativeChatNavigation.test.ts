import type { ConversationMessageListProjection } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { invertedMessageIndex } from '../native/chatNavigation.js';

const messages = Array.from({ length: 5 }, (_, index): ConversationMessageListProjection => ({
  messageId: `message-${index}`,
  turnId: `message-${index - index % 2}`,
  conversationId: 'conversation',
  originNodeId: 'node',
  originSequence: index + 1,
  timestamp: index,
  lamportClock: index,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}`,
}));

describe('native chat navigation', () => {
  it('maps a display-order timeline anchor to GiftedChat inverted list index', () => {
    expect(invertedMessageIndex(messages, 'message-0')).toBe(4);
    expect(invertedMessageIndex(messages, 'message-2')).toBe(2);
    expect(invertedMessageIndex(messages, 'message-4')).toBe(0);
    expect(invertedMessageIndex(messages, 'missing')).toBe(-1);
  });
});

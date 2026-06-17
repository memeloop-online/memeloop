import type { ChatMessage } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { chatMessagesToTUIMessages, chatMessageToTUIMessage } from '../messageAdapter.js';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    originNodeId: 'cli-test',
    timestamp: 1_700_000_000_000,
    lamportClock: 1,
    role: 'assistant',
    content: 'hello',
    ...overrides,
  };
}

describe('chatMessageToTUIMessage', () => {
  it('maps the shared ChatMessage model into Ink TUI messages', () => {
    const message = chatMessageToTUIMessage(makeMessage({ reasoning_content: 'thinking' }));

    expect(message).toEqual({
      id: 'msg-1',
      role: 'assistant',
      content: 'hello',
      timestamp: new Date(1_700_000_000_000),
      thinking: 'thinking',
    });
  });

  it('maps arrays without changing order', () => {
    const messages = chatMessagesToTUIMessages([
      makeMessage({ messageId: 'u1', role: 'user', content: 'question' }),
      makeMessage({ messageId: 'a1', role: 'assistant', content: 'answer' }),
    ]);

    expect(messages.map(message => message.id)).toEqual(['u1', 'a1']);
  });
});

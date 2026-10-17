import type { ChatMessage } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { chatMessagesToTUIMessages, chatMessageToTUIMessage, TUI_MESSAGE_TOOL_RESULT_MAX_BYTES } from '../messageAdapter.js';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const role = overrides.role ?? 'assistant';
  const content = overrides.content ?? 'hello';
  const parts = overrides.parts ?? (role === 'tool'
    ? [{ type: 'tool-result' as const, toolName: 'test', result: content }]
    : [{ type: 'text' as const, text: content }]);
  return {
    messageId: 'msg-1',
    turnId: 'msg-1',
    conversationId: 'conv-1',
    originNodeId: 'cli-test',
    originSequence: 1,
    timestamp: 1_700_000_000_000,
    lamportClock: 1,
    role,
    parts,
    content,
    ...overrides,
  };
}

describe('chatMessageToTUIMessage', () => {
  it('maps the shared ChatMessage model into Ink TUI messages', () => {
    const message = chatMessageToTUIMessage(makeMessage({
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'thinking' },
      ],
    }));

    expect(message).toEqual({
      kind: 'message',
      messageId: 'msg-1',
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

    expect(messages.map(message => message.messageId)).toEqual(['u1', 'a1']);
  });

  it('maps Core agent and error roles into supported TUI roles', () => {
    expect(chatMessageToTUIMessage(makeMessage({ role: 'agent' })).role).toBe('assistant');
    expect(chatMessageToTUIMessage(makeMessage({ role: 'error' })).role).toBe('system');
  });

  it('projects a huge tool result into bounded safe display text with detail metadata', () => {
    const projected = chatMessageToTUIMessage(makeMessage({
      messageId: 'tool-1',
      role: 'tool',
      content: `\u001B[31m${'😀'.repeat(300_000)}\u001B[0m`,
      detailRef: { type: 'agent-run', runId: 'run-1', resourceVersion: '7' },
    }));

    expect(new TextEncoder().encode(projected.toolResult).byteLength)
      .toBeLessThanOrEqual(TUI_MESSAGE_TOOL_RESULT_MAX_BYTES);
    expect(projected.toolResult).not.toContain('\u001B');
    expect(projected.toolResult).toContain('[detail omitted]');
    expect(projected.detail).toMatchObject({ truncated: true });
    expect(projected.detail?.originalBytes).toBeGreaterThan(1_000_000);
    expect(projected.content).toBe('');
  });

  it('rejects malformed Unicode instead of sending it to terminal layout', () => {
    expect(() => chatMessageToTUIMessage(makeMessage({ content: 'bad\ud800text' })))
      .toThrow('invalid_tui_unicode');
  });

  it('keeps a worst-case 50-message display projection below 256 KiB', () => {
    const messages = chatMessagesToTUIMessages(Array.from({ length: 50 }, (_, index) =>
      makeMessage({
        messageId: `large-${index}`,
        turnId: `large-${index}`,
        originSequence: index + 1,
        role: 'tool',
        content: 'x'.repeat(200_000),
      })));
    expect(messages).toHaveLength(50);
    expect(new TextEncoder().encode(JSON.stringify(messages)).byteLength).toBeLessThan(256 * 1024);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../conversation/types.js';
import { boundConversationMessageProjectionForList, projectConversationMessageForList } from '../conversationPaging.js';
import { projectConversationToolActivity, readConversationToolActivity } from '../toolActivity.js';

describe('bounded tool activity', () => {
  it('projects commands and results with stable invocation identity', () => {
    expect(projectConversationToolActivity([
      { type: 'tool-call', toolCallId: 'one', toolName: 'exec', arguments: { command: 'pwd' } },
      { type: 'tool-result', toolCallId: 'one', toolName: 'exec', parameters: { command: 'pwd' }, result: 'output', isError: true },
    ])).toEqual([
      { kind: 'call', name: 'exec', callId: 'one', input: '{"command":"pwd"}' },
      { kind: 'result', name: 'exec', callId: 'one', input: '{"command":"pwd"}', isError: true },
    ]);
  });
  it('bounds large arguments, excessive calls, and malformed metadata', () => {
    const parts = Array.from({ length: 100 }, (_, index) => ({
      type: 'tool-call' as const,
      toolCallId: String(index),
      toolName: 'exec',
      arguments: { value: 'x'.repeat(10000) },
    }));
    const result = projectConversationToolActivity(parts);
    expect(result).toHaveLength(16);
    expect(result[0]).toMatchObject({ inputTruncated: true });
    expect(result[0]).not.toHaveProperty('input');
    expect(readConversationToolActivity([{ kind: 'unknown', name: 'exec' }])).toEqual([]);
  });
  it('survives re-projection and drops optional activity when a smaller budget requires it', () => {
    const source: ChatMessage = {
      messageId: 'm',
      turnId: 't',
      conversationId: 'c',
      originNodeId: 'n',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      role: 'tool',
      content: 'result',
      parts: [{ type: 'tool-result', toolName: 'exec', parameters: { command: 'x'.repeat(1000) }, result: 'result' }],
    };
    const projected = projectConversationMessageForList(source, 48000);
    expect(readConversationToolActivity(projected.metadata?.toolActivity)).toHaveLength(1);
    expect(boundConversationMessageProjectionForList(projected, 48000)).toEqual(projected);
    const bounded = boundConversationMessageProjectionForList(projected, 700);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(700);
    expect(bounded.metadata?.toolActivity).toBeUndefined();
    const error = { ...source, parts: [{ type: 'tool-result' as const, toolName: 'exec', parameters: { value: 'x'.repeat(1000) }, result: 'failed', isError: true }] };
    expect(boundConversationMessageProjectionForList(projectConversationMessageForList(error, 48000), 700).metadata?.isError).toBe(true);
    const spoofed = projectConversationMessageForList({
      ...source,
      parts: [],
      metadata: { toolActivity: [{ kind: 'call', name: 'fake' }], unknownPrivatePayload: 'must not enter the list' },
    }, 48000);
    expect(spoofed.metadata).toBeUndefined();
  });
});

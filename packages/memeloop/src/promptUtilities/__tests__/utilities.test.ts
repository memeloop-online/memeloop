import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../conversation/index.js';

import { filterOldMessagesByDuration, normalizeRoleForLlm } from '../utilities.js';

describe('prompt utilities', () => {
  it('normalizeRoleForLlm maps unknown to user', () => {
    expect(normalizeRoleForLlm('foo')).toBe('user');
    expect(normalizeRoleForLlm('assistant')).toBe('assistant');
  });

  it('filterOldMessagesByDuration drops stale messages', () => {
    const now = 1_000_000;
    const msgs: ChatMessage[] = [
      {
        messageId: 'a',
        turnId: 'a',
        conversationId: 'c',
        originNodeId: 'test-node-prompt',
        originSequence: 1,
        timestamp: now - 10_000,
        lamportClock: 1,
        role: 'user',
        content: 'old',
      },
      {
        messageId: 'b',
        turnId: 'b',
        conversationId: 'c',
        originNodeId: 'test-node-prompt',
        originSequence: 2,
        timestamp: now - 100,
        lamportClock: 2,
        role: 'user',
        content: 'new',
      },
    ];
    const kept = filterOldMessagesByDuration(msgs, 1000, now);
    expect(kept).toHaveLength(1);
    expect(kept[0].messageId).toBe('b');
  });
});

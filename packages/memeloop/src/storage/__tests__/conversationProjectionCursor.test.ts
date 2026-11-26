import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_PROJECTION_CURSOR_LIMITS,
  type ConversationProjectionCursor,
  decodeConversationProjectionCursor,
  encodeConversationProjectionCursor,
} from '../conversationProjectionCursor.js';

const conversationExpectation = {
  kind: 'conversation-list' as const,
  revision: 'revision-1',
  queryDigest: 'digest-1',
};

const cursors: ConversationProjectionCursor[] = [
  {
    version: 1,
    kind: 'conversation-list',
    revision: conversationExpectation.revision,
    queryDigest: conversationExpectation.queryDigest,
    timestamp: 1_700_000_000_000,
    conversationId: 'conversation-1',
  },
  {
    version: 1,
    kind: 'turn-list',
    conversationId: 'conversation-1',
    revision: 'revision-2',
    timelineCursor: 'timeline-1',
  },
  {
    version: 1,
    kind: 'turn-detail',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    timestamp: 1_700_000_000_001,
    lamportClock: 7,
    originNodeId: 'node-1',
    messageId: 'message-1',
  },
];

describe('conversation projection cursor', () => {
  it.each(cursors)('round-trips the strict $kind envelope', cursor => {
    const encoded = encodeConversationProjectionCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    const expected = cursor.kind === 'conversation-list'
      ? conversationExpectation
      : cursor.kind === 'turn-list'
      ? { kind: cursor.kind, conversationId: cursor.conversationId, revision: cursor.revision }
      : { kind: cursor.kind, conversationId: cursor.conversationId, turnId: cursor.turnId };
    expect(decodeConversationProjectionCursor(encoded, expected)).toEqual(cursor);
  });

  it('fails closed for malformed, legacy, non-canonical, and wrong-kind cursors', () => {
    const cursor = cursors[0];
    const encoded = encodeConversationProjectionCursor(cursor);
    expect(() => decodeConversationProjectionCursor(`${encoded}=`, conversationExpectation)).toThrow(
      'conversation_projection_cursor_invalid',
    );
    expect(() => decodeConversationProjectionCursor('not-base64!', conversationExpectation)).toThrow(
      'conversation_projection_cursor_invalid',
    );
    const legacy = Buffer.from(JSON.stringify({
      version: 3,
      conversationId: cursor.conversationId,
      timestamp: cursor.timestamp,
    })).toString('base64url');
    expect(() => decodeConversationProjectionCursor(legacy, conversationExpectation)).toThrow(
      'conversation_projection_cursor_invalid',
    );
    const nonCanonical = Buffer.from(` ${JSON.stringify(cursor)}`).toString('base64url');
    expect(() => decodeConversationProjectionCursor(nonCanonical, conversationExpectation)).toThrow(
      'conversation_projection_cursor_invalid',
    );
    expect(() =>
      decodeConversationProjectionCursor(encoded, {
        kind: 'turn-list',
        conversationId: cursor.conversationId,
      })
    ).toThrow('conversation_projection_cursor_stale');
  });

  it('rejects unknown fields and max+1 bounded values', () => {
    const withUnknown = { ...cursors[0], extra: true } as unknown as ConversationProjectionCursor;
    expect(() => encodeConversationProjectionCursor(withUnknown)).toThrow('conversation_projection_cursor_invalid');
    const tooLong = {
      ...cursors[1],
      timelineCursor: 'x'.repeat(CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters + 1),
    } as ConversationProjectionCursor;
    expect(() => encodeConversationProjectionCursor(tooLong)).toThrow('conversation_projection_cursor_invalid');
  });

  it('enforces revision and scope fences across hosts', () => {
    const conversation = encodeConversationProjectionCursor(cursors[0]);
    expect(() =>
      decodeConversationProjectionCursor(conversation, {
        ...conversationExpectation,
        revision: 'other-revision',
      })
    ).toThrow('conversation_projection_cursor_stale');
    const detail = cursors[2];
    const encodedDetail = encodeConversationProjectionCursor(detail);
    expect(() =>
      decodeConversationProjectionCursor(encodedDetail, {
        kind: 'turn-detail',
        conversationId: 'other-conversation',
        turnId: detail.turnId,
      })
    ).toThrow('conversation_projection_cursor_stale');
  });
});

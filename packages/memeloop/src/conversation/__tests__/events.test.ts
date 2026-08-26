import { describe, expect, it, vi } from 'vitest';

import {
  assertCanonicalConversationEvent,
  assertCanonicalConversationEventDraft,
  assertCanonicalConversationEventDrafts,
  assertCanonicalConversationEvents,
  canonicalConversationEventBytes,
  CONVERSATION_EVENT_LIMITS,
  isConversationEvent,
  MAX_CONVERSATION_EVENT_BYTES,
  normalizeCanonicalConversationEvent,
} from '../events.js';

const messageEvent = {
  eventId: 'message-1',
  conversationId: 'conversation-1',
  originNodeId: 'node-a',
  originSequence: 1,
  lamportClock: 1,
  timestamp: 1,
  kind: 'message',
  message: {
    messageId: 'message-1',
    turnId: 'message-1',
    role: 'user',
    content: 'hello',
  },
} as const;

describe('isConversationEvent', () => {
  it('accepts a canonical message event', () => {
    expect(isConversationEvent(messageEvent)).toBe(true);
  });

  it('rejects unknown fields and message/event identity drift', () => {
    expect(isConversationEvent({ ...messageEvent, unexpected: true })).toBe(false);
    expect(isConversationEvent({
      ...messageEvent,
      message: { ...messageEvent.message, messageId: 'different' },
    })).toBe(false);
  });

  it('rejects attachment parts in compaction control events', () => {
    expect(isConversationEvent({
      eventId: 'compaction-1',
      conversationId: 'conversation-1',
      originNodeId: 'node-a',
      originSequence: 2,
      lamportClock: 2,
      timestamp: 2,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion: { 'node-a': 1 },
        coveredMessageCountByOrigin: { 'node-a': 1 },
        coveredUserTurnCountByOrigin: { 'node-a': 1 },
        droppedMessageCount: 1,
        droppedTurnCount: 1,
      },
      summary: {
        turnId: 'summary-turn',
        content: 'summary',
        parts: [{
          type: 'attachment',
          attachment: { contentHash: 'hash', filename: 'a', mimeType: 'text/plain', size: 1 },
        }],
      },
    })).toBe(false);
  });

  it('accepts durable agent-run references and rejects empty or type-incomplete references', () => {
    expect(isConversationEvent({
      ...messageEvent,
      message: {
        ...messageEvent.message,
        detailRef: {
          type: 'agent-run',
          runId: 'run-1',
          nodeId: 'node-a',
          resourceVersion: 'version-1',
        },
      },
    })).toBe(true);
    expect(isConversationEvent({
      ...messageEvent,
      message: {
        ...messageEvent.message,
        detailRef: { type: 'agent-run', runId: '', resourceVersion: 'version-1' },
      },
    })).toBe(false);
    expect(isConversationEvent({
      ...messageEvent,
      message: {
        ...messageEvent.message,
        detailRef: { type: 'terminal-session', nodeId: 'node-a' },
      },
    })).toBe(false);
  });

  it('accepts a coverage-only checkpoint without projecting summary text', () => {
    expect(isConversationEvent({
      eventId: 'coverage-1',
      conversationId: 'conversation-1',
      originNodeId: 'node-a',
      originSequence: 2,
      lamportClock: 2,
      timestamp: 2,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary: {
        version: 2,
        coveredVersion: { 'node-a': 1 },
        coveredMessageCountByOrigin: {},
        coveredUserTurnCountByOrigin: {},
        droppedMessageCount: 0,
        droppedTurnCount: 0,
      },
      summary: null,
    })).toBe(true);
  });

  it('normalizes only known optional undefined fields before canonical encoding', () => {
    const withKnownUndefined = {
      ...messageEvent,
      message: { ...messageEvent.message, metadata: undefined },
    };
    expect(() => {
      assertCanonicalConversationEvent(withKnownUndefined);
    }).not.toThrow();
    expect(canonicalConversationEventBytes(withKnownUndefined)).toEqual(
      canonicalConversationEventBytes(messageEvent),
    );
    const normalized = normalizeCanonicalConversationEvent(withKnownUndefined);
    expect(normalized.kind).toBe('message');
    if (normalized.kind !== 'message') throw new Error('expected normalized message event');
    expect(Object.hasOwn(normalized.message, 'metadata')).toBe(false);
    expect(Object.hasOwn(withKnownUndefined.message, 'metadata')).toBe(true);
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: { ...messageEvent.message, metadata: { arbitrary: undefined } },
      });
    }).toThrow('invalid canonical conversation event');
  });

  it('rejects accessors, cycles, non-JSON values, and oversized events before persistence', () => {
    const read = vi.fn(() => 'attacker');
    const accessorMetadata = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: read,
    });
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: { ...messageEvent.message, metadata: accessorMetadata },
      });
    }).toThrow('invalid canonical conversation event');
    expect(read).not.toHaveBeenCalled();

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const invalid of [cycle, { value: Number.NaN }, { value: 1n }]) {
      expect(() => {
        assertCanonicalConversationEvent({
          ...messageEvent,
          message: { ...messageEvent.message, metadata: invalid },
        });
      }).toThrow('invalid canonical conversation event');
    }
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: {
          ...messageEvent.message,
          content: 'x'.repeat(MAX_CONVERSATION_EVENT_BYTES + 1),
        },
      });
    }).toThrow('invalid canonical conversation event');
  });

  it('enforces UTF-8 field bounds and nonnegative safe durations', () => {
    const atByteBoundary = '😀'.repeat(CONVERSATION_EVENT_LIMITS.identifierBytes / 4);
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        eventId: atByteBoundary,
        message: { ...messageEvent.message, messageId: atByteBoundary, turnId: atByteBoundary },
      });
    }).not.toThrow();
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        eventId: `${atByteBoundary}😀`,
        message: {
          ...messageEvent.message,
          messageId: `${atByteBoundary}😀`,
          turnId: `${atByteBoundary}😀`,
        },
      });
    }).toThrow('invalid canonical conversation event schema');
    for (const duration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => {
        assertCanonicalConversationEvent({
          ...messageEvent,
          message: { ...messageEvent.message, duration },
        });
      }).toThrow('invalid canonical conversation event');
    }
  });

  it('bounds arrays and nested metadata independently of the total frame size', () => {
    const call = { id: 'call-1', toolName: 'lookup', arguments: {} };
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: {
          ...messageEvent.message,
          toolCalls: Array.from(
            { length: CONVERSATION_EVENT_LIMITS.toolCalls + 1 },
            () => call,
          ),
        },
      });
    }).toThrow('invalid canonical conversation event schema');

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth <= CONVERSATION_EVENT_LIMITS.metadataDepth; depth += 1) {
      nested = { nested };
    }
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: { ...messageEvent.message, metadata: nested },
      });
    }).toThrow('invalid canonical conversation event schema');
  });

  it('accepts finite JSON fractions in tool data and metadata', () => {
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: {
          ...messageEvent.message,
          metadata: { top_p: 0.95, temperature: -0.25 },
          toolCalls: [{ id: 'call-1', toolName: 'move', arguments: { x: 1.5, y: -2.75 } }],
          parts: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'move',
            parameters: { confidence: 0.875 },
            result: 'ok',
          }],
        },
      });
    }).not.toThrow();
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => {
        assertCanonicalConversationEvent({
          ...messageEvent,
          message: { ...messageEvent.message, metadata: { invalid } },
        });
      }).toThrow('invalid canonical conversation event');
    }
  });

  it('requires canonical attachment hashes and safe bounded attachment metadata', () => {
    const valid = {
      contentHash: `sha256:${'a'.repeat(64)}`,
      filename: 'context.txt',
      mimeType: 'text/plain',
      size: CONVERSATION_EVENT_LIMITS.attachmentBytes,
    };
    expect(() => {
      assertCanonicalConversationEvent({
        ...messageEvent,
        message: { ...messageEvent.message, attachments: [valid] },
      });
    }).not.toThrow();
    for (
      const attachment of [
        { ...valid, contentHash: `SHA256:${'a'.repeat(64)}` },
        { ...valid, filename: '../context.txt' },
        { ...valid, mimeType: 'not-a-mime' },
        { ...valid, size: CONVERSATION_EVENT_LIMITS.attachmentBytes + 1 },
      ]
    ) {
      expect(() => {
        assertCanonicalConversationEvent({
          ...messageEvent,
          message: { ...messageEvent.message, attachments: [attachment] },
        });
      }).toThrow('invalid canonical conversation event schema');
    }
  });

  it('prevalidates a whole batch before the caller can begin its transaction', () => {
    const persist = vi.fn();
    const invalid = {
      ...messageEvent,
      eventId: 'message-2',
      message: { ...messageEvent.message, messageId: 'message-2', metadata: { value: 1n } },
    };
    expect(() => {
      assertCanonicalConversationEvents([messageEvent, invalid]);
      persist();
    }).toThrow('invalid canonical conversation event');
    expect(persist).not.toHaveBeenCalled();
  });

  it('prevalidates local drafts before allocating causal coordinates', () => {
    const { lamportClock: _lamportClock, originSequence: _originSequence, ...draft } = messageEvent;
    expect(() => {
      assertCanonicalConversationEventDraft(draft);
    }).not.toThrow();
    expect(() => {
      assertCanonicalConversationEventDraft(messageEvent);
    }).toThrow(
      'invalid canonical conversation event draft schema',
    );
    expect(() => {
      assertCanonicalConversationEventDrafts([
        draft,
        {
          ...draft,
          eventId: 'message-2',
          message: {
            ...draft.message,
            messageId: 'message-2',
            content: 'x'.repeat(MAX_CONVERSATION_EVENT_BYTES + 1),
          },
        },
      ]);
    }).toThrow('invalid canonical conversation event');
  });
});

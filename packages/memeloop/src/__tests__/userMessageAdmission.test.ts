import { describe, expect, it, vi } from 'vitest';

import {
  canonicalConversationEventBytes,
  type ChatMessage,
  type ConversationEvent,
  type ConversationEventDraft,
  getChatMessageParts,
  messageToConversationEvent,
} from '../conversation/index.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { appendLocalMessageEvent } from '../loopAPI/agent-tool-loop/localMessageEvent.js';
import { buildConversationMessagePage } from '../storage/conversationPaging.js';
import {
  AGENT_USER_MESSAGE_LIMITS,
  AgentUserMessageLimitError,
  compactRedundantMessagePartsForPersistence,
  CONVERSATION_MESSAGE_ADMISSION_LIMITS,
  normalizeAgentUserMessageForAdmission,
  normalizeGeneratedConversationMessageForAdmission,
} from '../userMessageAdmission.js';

function userMessage(content: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 'turn:user-message-admission',
    turnId: 'turn:user-message-admission',
    conversationId: 'conversation:user-message-admission',
    originNodeId: 'node:user-message-admission',
    originSequence: 1,
    lamportClock: 1,
    timestamp: 1,
    role: 'user',
    content,
    parts: content.length > 0 ? [{ type: 'text', text: content }] : [],
    ...fields,
  };
}

describe('agent user message admission', () => {
  it('accepts an exact 240 KiB Unicode body and its complete page envelope fits 256 KiB', () => {
    const exactUnicode = '界'.repeat(AGENT_USER_MESSAGE_LIMITS.contentBytes / 3);
    // The RPC/user-root content projection is the bounded source of truth for
    // this ceiling-sized body; retaining a duplicate text part would exceed
    // the canonical whole-message budget.
    const admitted = normalizeAgentUserMessageForAdmission(userMessage(exactUnicode, { parts: [] }));
    const page = buildConversationMessagePage(
      [admitted],
      admitted.conversationId,
      { limit: 1, maxBytes: AGENT_USER_MESSAGE_LIMITS.pagingEnvelopeBytes, mode: 'full-content' },
      'revision:user-message-admission',
    );

    expect(new TextEncoder().encode(admitted.content)).toHaveLength(
      AGENT_USER_MESSAGE_LIMITS.contentBytes,
    );
    expect(page.reset).toBe(false);
    expect(
      canonicalJsonBytes(page, {
        maxBytes: AGENT_USER_MESSAGE_LIMITS.pagingEnvelopeBytes,
      }).byteLength,
    ).toBeLessThanOrEqual(AGENT_USER_MESSAGE_LIMITS.pagingEnvelopeBytes);
  });

  it('rejects Unicode max+1 with stable typed run metadata', () => {
    const maxPlusOne = `${'界'.repeat(AGENT_USER_MESSAGE_LIMITS.contentBytes / 3)}a`;

    expect(() => normalizeAgentUserMessageForAdmission(userMessage(maxPlusOne, { parts: [] }))).toThrow(
      expect.objectContaining({
        name: 'AgentUserMessageLimitError',
        kind: 'content',
        agentRunError: expect.objectContaining({
          code: 'USER_MESSAGE_TOO_LARGE',
          messageKey: 'agent.run.error.userMessageTooLarge',
          retryable: false,
          localizedParams: {
            requested: AGENT_USER_MESSAGE_LIMITS.contentBytes + 1,
            limit: AGENT_USER_MESSAGE_LIMITS.contentBytes,
          },
        }),
      }),
    );
  });

  it.each([
    ['metadata', { metadata: { padding: 'm'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes) } }],
    ['parts', {
      parts: [{ type: 'text' as const, text: 'p'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes) }],
    }],
  ])('rejects a whole-message %s bypass while inline content is small', (_name, fields) => {
    let error: unknown;
    try {
      normalizeAgentUserMessageForAdmission(userMessage('', fields));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentUserMessageLimitError);
    expect(error).toMatchObject({
      kind: 'canonical-message',
      agentRunError: { code: 'USER_MESSAGE_TOO_LARGE' },
    });
  });

  it.each(['assistant', 'tool'] as const)(
    'projects an oversized local %s event with canonical parts before the storage append',
    async role => {
      const appendLocalEvent = vi.fn(async (draft: ConversationEventDraft): Promise<ConversationEvent> => ({
        ...draft,
        originSequence: 1,
        lamportClock: 1,
      }));
      const persisted = await appendLocalMessageEvent({
        localNodeId: 'node:user-message-admission',
        storage: { appendLocalEvent },
      } as never, {
        conversationId: 'conversation:user-message-admission',
        timestamp: 1,
        message: {
          messageId: `message:${role}`,
          turnId: 'turn:existing-user-root',
          role,
          content: '',
          ...(role === 'tool'
            ? { parts: [{ type: 'tool-result' as const, toolName: 'test', result: '' }] }
            : {}),
          metadata: {
            padding: 'x'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes),
          },
        },
      });
      expect(new TextEncoder().encode(persisted.content).byteLength).toBeLessThanOrEqual(
        48 * 1024,
      );
      expect(persisted.metadata).toMatchObject({
        durableProjection: {
          version: 1,
          contentTruncated: false,
          omittedMetadata: true,
          capability: 'not-retained',
        },
      });
      expect(canonicalConversationEventBytes(messageToConversationEvent(persisted)).byteLength)
        .toBeLessThanOrEqual(CONVERSATION_MESSAGE_ADMISSION_LIMITS.canonicalEventBytes);
      expect(appendLocalEvent).toHaveBeenCalledOnce();
    },
  );

  it('preserves canonical parts instead of eliding top-level/part duplicates', () => {
    const compacted = compactRedundantMessagePartsForPersistence({
      messageId: 'assistant-equivalence',
      turnId: 'user-root',
      role: 'assistant',
      content: 'same text',
      reasoning_content: 'same reasoning',
      toolCalls: [{ id: 'call-1', toolName: 'read', arguments: { path: '/same' } }],
      parts: [
        { type: 'text', text: 'same text' },
        { type: 'reasoning', text: 'same reasoning' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', arguments: { path: '/same' } },
        { type: 'text', text: 'unique interleaved text' },
        { type: 'reasoning', text: 'unique reasoning' },
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'read', arguments: { path: '/other' } },
      ],
    });

    expect(compacted.parts).toEqual([
      { type: 'text', text: 'same text' },
      { type: 'reasoning', text: 'same reasoning' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', arguments: { path: '/same' } },
      { type: 'text', text: 'unique interleaved text' },
      { type: 'reasoning', text: 'unique reasoning' },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'read', arguments: { path: '/other' } },
    ]);
    expect(getChatMessageParts({
      ...userMessage('same text', {
        role: 'assistant',
        turnId: 'user-root',
        reasoning_content: compacted.reasoning_content,
        toolCalls: compacted.toolCalls,
        parts: compacted.parts,
      }),
    })).toEqual(compacted.parts);
  });

  it('preserves bounded tool calls and stable metadata in an oversized generated projection', () => {
    const payload = compactRedundantMessagePartsForPersistence({
      messageId: 'assistant-oversized-tool-call',
      turnId: 'user-root',
      role: 'assistant',
      content: '🙂'.repeat(100_000),
      toolCalls: [{ id: 'call-1', toolName: 'read', arguments: { path: '/same' } }],
      parts: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', arguments: { path: '/same' } }],
      metadata: {
        containsToolCall: true,
        modelUsage: { inputTokens: 10, outputTokens: 20 },
        provenance: { providerId: 'test' },
      },
    });
    expect(payload.parts).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', arguments: { path: '/same' } },
    ]);

    const appendLocalEvent = vi.fn(async (draft: ConversationEventDraft): Promise<ConversationEvent> => ({
      ...draft,
      originSequence: 1,
      lamportClock: 1,
    }));
    return expect(appendLocalMessageEvent({
      localNodeId: 'node:user-message-admission',
      storage: { appendLocalEvent },
    } as never, {
      conversationId: 'conversation:user-message-admission',
      timestamp: 1,
      message: payload,
    })).resolves.toMatchObject({
      toolCalls: [{ id: 'call-1', toolName: 'read', arguments: { path: '/same' } }],
      metadata: {
        containsToolCall: true,
        modelUsage: { inputTokens: 10, outputTokens: 20 },
        provenance: { providerId: 'test' },
        durableProjection: {
          omittedToolCalls: 0,
          capability: 'not-retained',
        },
      },
    });
  });

  it('keeps an exact canonical generated message and projects canonical max+1', () => {
    const identity = {
      messageId: 'assistant-exact-canonical-limit',
      turnId: 'user-root',
      conversationId: 'conversation:user-message-admission',
      originNodeId: 'node:user-message-admission',
      originSequence: Number.MAX_SAFE_INTEGER,
      lamportClock: Number.MAX_SAFE_INTEGER,
      timestamp: 1,
      role: 'assistant' as const,
    };
    const exactContent = 'x'.repeat(100_000);
    const exactPayload = normalizeGeneratedConversationMessageForAdmission({
      conversationId: identity.conversationId,
      originNodeId: identity.originNodeId,
      timestamp: identity.timestamp,
      message: {
        messageId: identity.messageId,
        turnId: identity.turnId,
        role: identity.role,
        content: exactContent,
        parts: [{ type: 'text', text: exactContent }],
      },
    });
    expect(exactPayload.content).toBe(exactContent);
    expect(exactPayload.parts).toEqual([{ type: 'text', text: exactContent }]);

    const maxPlusOneContent = 'x'.repeat(250_000);
    const maxPlusOne = normalizeGeneratedConversationMessageForAdmission({
      conversationId: identity.conversationId,
      originNodeId: identity.originNodeId,
      timestamp: identity.timestamp,
      message: {
        messageId: identity.messageId,
        turnId: identity.turnId,
        role: identity.role,
        content: maxPlusOneContent,
        parts: [{ type: 'text', text: maxPlusOneContent }],
      },
    });
    expect(maxPlusOne.content).not.toBe(maxPlusOneContent);
    expect(maxPlusOne.metadata).toMatchObject({
      durableProjection: { contentTruncated: true },
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../conversation/types.js';
import type { MemeLoopRunState } from '../../runtime.js';
import { AGENT_USER_MESSAGE_LIMITS } from '../../userMessageAdmission.js';
import {
  AGENT_DEVICE_RPC_LIMITS,
  AGENT_DEVICE_RPC_METHODS,
  AgentDeviceRpcProtocolError,
  type AgentDeviceRpcRunStatus,
  type AgentDeviceRpcTurnSummary,
  assertAgentDeviceRpcRequest,
  assertAgentDeviceRpcResponseCorrelation,
  parseAgentDeviceRpcResponse,
} from '../agentDeviceRpc.js';
import { createAgentDeviceRpcClient } from '../agentDeviceRpcClient.js';

function message(messageId: string, content = messageId): ChatMessage {
  return {
    messageId,
    turnId: messageId,
    conversationId: 'conversation-1',
    originNodeId: 'node-a',
    originSequence: 1,
    timestamp: 10,
    lamportClock: 2,
    role: 'user',
    content,
  };
}

function status(state: MemeLoopRunState = 'running'): AgentDeviceRpcRunStatus {
  return {
    runId: 'run-1',
    requestId: 'request-1',
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    definitionId: 'assistant',
    requestPeerId: 'peer-b',
    payloadDigest: 'digest-1',
    state,
    acceptedAt: 1,
    updatedAt: 2,
  };
}

function turn(turnId: string): AgentDeviceRpcTurnSummary {
  return {
    turnId,
    conversationId: 'conversation-1',
    cursor: `opaque-${turnId}`,
    startedAt: 1,
    updatedAt: 2,
    userPreview: `user ${turnId}`,
    participantPreviews: [{
      actorId: 'assistant',
      actorLabel: 'Assistant',
      role: 'assistant',
      preview: `assistant ${turnId}`,
    }],
    responseCount: 1,
    runState: 'completed',
    isCompaction: false,
    isTombstone: false,
    detailState: 'summary',
  };
}

describe('Agent device RPC contract', () => {
  it('rejects page limits and invalid opaque cursors before transport', () => {
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        conversationId: 'conversation-1',
        limit: AGENT_DEVICE_RPC_LIMITS.messagePage + 1,
      });
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        conversationId: 'conversation-1',
        limit: 1,
        cursor: '',
      });
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        conversationId: 'conversation-1',
        definitionId: 'must-not-be-smuggled',
      });
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        conversationId: 'conversation-1',
        cursor: 'opaque-cursor',
        direction: 'forward',
      });
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getRunStatus, {
        status: status(),
        definitionId: 'must-not-be-smuggled',
      });
    }).toThrow(AgentDeviceRpcProtocolError);
  });

  it('preserves structured durable run errors and rejects secret-shaped or executable fields', () => {
    const safeError = {
      code: 'PROVIDER_AUTH_MISSING',
      messageKey: 'agent.run.error.providerAuthMissing',
      retryable: false,
      diagnosticId: 'rpc:diag-1',
      providerId: 'siliconflow',
      localizedParams: { providerId: 'siliconflow', settingField: 'apiKey' },
      settingTarget: { kind: 'provider', providerId: 'siliconflow', field: 'apiKey' },
    } as const;
    expect(parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getRunStatus, {
      status: { ...status('failed'), error: safeError },
    })).toMatchObject({ status: { error: safeError } });
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getRunStatus, {
        status: {
          ...status('failed'),
          error: { ...safeError, rawApiKey: 'sk-1234567890abcdef' },
        },
      })
    ).toThrow(AgentDeviceRpcProtocolError);

    let getterCalls = 0;
    const response = {
      get status() {
        getterCalls += 1;
        return status();
      },
    };
    expect(() =>
      parseAgentDeviceRpcResponse(
        AGENT_DEVICE_RPC_METHODS.getRunStatus,
        response,
      )
    ).toThrow(AgentDeviceRpcProtocolError);
    expect(getterCalls).toBe(0);
  });

  it('accepts committed attachment references without caller-supplied causal identity', () => {
    const reference = {
      contentHash: `sha256:${'a'.repeat(64)}`,
      filename: 'context.txt',
      mimeType: 'text/plain',
      size: 5,
    };
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        message: 'hello',
        userMessage: { content: 'hello', attachments: [reference] },
      });
    }).not.toThrow();
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        message: 'hello',
        userMessage: {
          content: 'different-visible-message',
          attachments: [{ ...reference, contentHash: 'guessable-hash' }],
          originSequence: 100,
        },
      });
    }).toThrow(AgentDeviceRpcProtocolError);
  });

  it('enforces the shared Unicode and whole-message admission limits at the RPC boundary', () => {
    const exact = '界'.repeat(AGENT_USER_MESSAGE_LIMITS.contentBytes / 3);
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-exact-user-message',
        turnId: 'turn-exact-user-message',
        conversationId: 'conversation-exact-user-message',
        message: exact,
        userMessage: { content: exact },
      });
    }).not.toThrow();
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-over-user-message',
        turnId: 'turn-over-user-message',
        conversationId: 'conversation-over-user-message',
        message: `${exact}a`,
        userMessage: { content: `${exact}a` },
      });
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-metadata-bypass',
        turnId: 'turn-metadata-bypass',
        conversationId: 'conversation-metadata-bypass',
        message: '',
        userMessage: {
          content: '',
          metadata: {
            padding: 'x'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes),
          },
        },
      });
    }).toThrow(AgentDeviceRpcProtocolError);
  });

  it('bounds timeline previews and projected message bytes', () => {
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage, {
        reset: false,
        items: [{
          kind: 'turn',
          entryId: 'turn-1',
          messageId: 'turn-1',
          turnId: 'turn-1',
          conversationId: 'conversation-1',
          cursor: 'cursor-1',
          timestamp: 10,
          lamportClock: 10,
          originNodeId: 'node-a',
          entryIndex: 0,
          turnIndex: 0,
          userPreview: 'x'.repeat(AGENT_DEVICE_RPC_LIMITS.timelinePreviewCharacters + 2),
        }],
        revision: 'revision-1',
        totalEntries: 1,
        totalMessages: 1,
        totalTurns: 1,
        hasMoreBefore: false,
        hasMoreAfter: false,
        startEntryIndex: 0,
        endEntryIndex: 0,
        startCursor: 'cursor-1',
        endCursor: 'cursor-1',
      })
    ).toThrow(AgentDeviceRpcProtocolError);

    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        items: [message('large', 'x'.repeat(AGENT_DEVICE_RPC_LIMITS.messageProjectionBytes))],
        hasMoreBefore: false,
        hasMoreAfter: false,
      })
    ).toThrow(AgentDeviceRpcProtocolError);

    const incompleteMessage = { ...message('missing-sequence') } as Record<string, unknown>;
    delete incompleteMessage.originSequence;
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        items: [incompleteMessage],
        hasMoreBefore: false,
        hasMoreAfter: false,
      })
    ).toThrow(AgentDeviceRpcProtocolError);
  });

  it('uses absolute user-turn indexes for a bounded timeline page', async () => {
    const sendRpc = vi.fn(async () => ({
      reset: false,
      items: [{
        kind: 'turn',
        entryId: 'turn-40',
        messageId: 'turn-40',
        turnId: 'turn-40',
        conversationId: 'conversation-1',
        cursor: 'cursor-40',
        timestamp: 40,
        lamportClock: 40,
        originNodeId: 'node-a',
        entryIndex: 40,
        turnIndex: 40,
        userPreview: 'remember this point',
        participantPreviews: [{
          actorId: 'assistant',
          actorLabel: 'Assistant',
          role: 'assistant',
          preview: 'answer',
        }],
        responseCount: 1,
      }],
      revision: 'revision-1',
      totalEntries: 50,
      totalMessages: 100,
      totalTurns: 50,
      hasMoreBefore: true,
      hasMoreAfter: true,
      startEntryIndex: 40,
      endEntryIndex: 40,
      startCursor: 'cursor-40',
      endCursor: 'cursor-40',
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.getConversationTimelinePage({
      conversationId: 'conversation-1',
      aroundEntryIndex: 40,
      limit: 1,
    })).resolves.toMatchObject({ items: [{ turnIndex: 40 }] });
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-b',
      AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage,
      expect.objectContaining({
        maxBytes: AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
      }),
      { presentedGrant: undefined, signal: undefined },
    );
    expect(() => {
      assertAgentDeviceRpcRequest(
        AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage,
        {
          conversationId: 'conversation-1',
          beforeCursor: 'cursor-40',
          afterCursor: 'cursor-40',
        },
      );
    }).toThrow(AgentDeviceRpcProtocolError);
  });

  it('uses a strict revisioned message-page success/reset union', () => {
    const request = {
      conversationId: 'conversation-1',
      cursor: 'opaque-cursor',
      expectedRevision: 'revision-1',
      direction: 'forward' as const,
      limit: 1,
      maxBytes: 64 * 1024,
    };
    const success = parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
      reset: false,
      conversationId: 'conversation-1',
      revision: 'revision-1',
      items: [message('one')],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    expect(() => {
      assertAgentDeviceRpcResponseCorrelation(
        AGENT_DEVICE_RPC_METHODS.getMessagePage,
        request,
        success,
      );
    }).not.toThrow();
    expect(() => {
      assertAgentDeviceRpcResponseCorrelation(
        AGENT_DEVICE_RPC_METHODS.getMessagePage,
        request,
        { ...success, revision: 'revision-2' },
      );
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
      reset: true,
      conversationId: 'conversation-1',
      revision: 'revision-2',
    })).toEqual({
      reset: true,
      conversationId: 'conversation-1',
      revision: 'revision-2',
    });
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
        reset: true,
        conversationId: 'conversation-1',
        revision: 'revision-2',
        items: [],
      })
    ).toThrow(AgentDeviceRpcProtocolError);
  });

  it('accepts the exact timeline byte ceiling and rejects max plus one before transport', async () => {
    const sendRpc = vi.fn(async () => ({
      reset: false,
      items: [],
      revision: 'revision-1',
      totalEntries: 0,
      totalMessages: 0,
      totalTurns: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });
    await expect(client.getConversationTimelinePage({
      conversationId: 'conversation-1',
      maxBytes: AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes,
    })).resolves.toMatchObject({ revision: 'revision-1' });
    expect(sendRpc).toHaveBeenCalledTimes(1);
    await expect(client.getConversationTimelinePage({
      conversationId: 'conversation-1',
      maxBytes: AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes + 1,
    })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
    expect(sendRpc).toHaveBeenCalledTimes(1);
  });

  it('uses the exact Core compaction timeline union and rejects obsolete summaries', () => {
    const page = {
      reset: false,
      items: [{
        kind: 'compaction',
        entryId: 'summary-event-1',
        conversationId: 'conversation-1',
        cursor: 'cursor-summary-1',
        timestamp: 10,
        lamportClock: 10,
        originNodeId: 'node-a',
        entryIndex: 0,
        turnIndex: 1,
        summaryPreview: 'Earlier context was compacted.',
        compactedMessageCount: 0,
        compactedTurnCount: 0,
      }],
      revision: 'revision-1',
      totalEntries: 1,
      totalMessages: 41,
      totalTurns: 20,
      hasMoreBefore: false,
      hasMoreAfter: false,
      startEntryIndex: 0,
      endEntryIndex: 0,
      startCursor: 'cursor-summary-1',
      endCursor: 'cursor-summary-1',
    } as const;
    expect(parseAgentDeviceRpcResponse(
      AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage,
      page,
    )).toEqual(page);
    expect(() => {
      parseAgentDeviceRpcResponse(
        AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage,
        {
          ...page,
          items: [{
            ...page.items[0],
            kind: 'summary',
            userPreview: 'synthetic fallback',
          }],
        },
      );
    }).toThrow(AgentDeviceRpcProtocolError);
  });
});

describe('createAgentDeviceRpcClient', () => {
  it('hides wire methods, forwards cancellation, and validates responses', async () => {
    const controller = new AbortController();
    const sendRpc = vi.fn(async () => ({
      ok: true,
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      state: 'accepted',
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.send({
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      message: 'hello',
    }, { signal: controller.signal })).resolves.toMatchObject({ runId: 'run-1' });
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-b',
      AGENT_DEVICE_RPC_METHODS.send,
      expect.objectContaining({ requestId: 'request-1' }),
      { presentedGrant: undefined, signal: controller.signal },
    );
  });

  it('prepares a reusable request id before a retry starts', async () => {
    const sendRpc = vi.fn(async () => ({
      ok: true,
      runId: 'run-1',
      requestId: 'stable-request-id',
      turnId: 'stable-turn-id',
      conversationId: 'conversation-1',
      state: 'accepted',
    }));
    const client = createAgentDeviceRpcClient({
      peerId: 'peer-b',
      sendRpc,
      createRequestId: vi.fn()
        .mockReturnValueOnce('stable-request-id')
        .mockReturnValueOnce('stable-turn-id'),
    });
    const prepared = client.prepareStartTurn({
      kind: 'runTurn',
      request: {
        conversationId: 'conversation-1',
        definitionId: 'assistant',
        message: 'hello',
      },
    });

    expect(prepared.request.requestId).toBe('stable-request-id');
    expect(prepared.request.turnId).toBe('stable-turn-id');
    await client.startTurn(prepared);
    await client.startTurn(prepared);
    expect(sendRpc).toHaveBeenCalledTimes(2);
    const calls = sendRpc.mock.calls as unknown as Array<[string, string, unknown]>;
    expect(calls[0]?.[2]).toEqual(calls[1]?.[2]);
  });

  it('loads one bounded revision-consistent message window around a turn', async () => {
    const older = { ...message('older'), turnId: 'older' };
    const focus = { ...message('focus'), turnId: 'focus', timestamp: 11, lamportClock: 3 };
    const newer = { ...message('newer'), turnId: 'newer', timestamp: 12, lamportClock: 4 };
    const sendRpc = vi.fn(async () => ({
      reset: false,
      conversationId: 'conversation-1',
      revision: 'revision-1',
      focus: { kind: 'turn', turnId: 'focus' },
      items: [older, focus, newer],
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousCursor: 'opaque-older',
      nextCursor: 'opaque-newer',
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    const page = await client.loadAround({
      conversationId: 'conversation-1',
      focus: { kind: 'turn', turnId: 'focus' },
      expectedRevision: 'revision-1',
      maxMessages: 40,
    });

    expect(page).toMatchObject({
      reset: false,
      focus: { kind: 'turn', turnId: 'focus' },
      items: [{ messageId: 'older' }, { messageId: 'focus' }, { messageId: 'newer' }],
    });
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-b',
      AGENT_DEVICE_RPC_METHODS.loadAround,
      expect.objectContaining({
        focus: { kind: 'turn', turnId: 'focus' },
        expectedRevision: 'revision-1',
        maxMessages: 40,
        maxBytes: AGENT_DEVICE_RPC_LIMITS.loadAroundDefaultBytes,
      }),
      { presentedGrant: undefined, signal: undefined },
    );
  });

  it('rejects an atomic message-window bound above the portable ceiling before transport', async () => {
    const sendRpc = vi.fn();
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });
    await expect(client.loadAround({
      conversationId: 'conversation-1',
      focus: { kind: 'turn', turnId: 'focus' },
      expectedRevision: 'revision-1',
      maxMessages: AGENT_DEVICE_RPC_LIMITS.loadAroundMessages + 1,
    })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
    await expect(client.loadAround({
      conversationId: 'conversation-1',
      focus: { kind: 'turn', turnId: 'focus' },
      expectedRevision: 'revision-1',
      maxBytes: AGENT_DEVICE_RPC_LIMITS.loadAroundMaxBytes + 1,
    })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('strictly correlates atomic window revisions, direct focus shape, and reset envelopes', () => {
    const request = {
      conversationId: 'conversation-1',
      focus: { kind: 'turn' as const, turnId: 'focus' },
      expectedRevision: 'revision-1',
      maxMessages: 1,
      maxBytes: AGENT_DEVICE_RPC_LIMITS.loadAroundMaxBytes,
    };
    const response = parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.loadAround, {
      reset: false,
      conversationId: 'conversation-1',
      revision: 'revision-1',
      focus: { kind: 'turn', turnId: 'focus' },
      items: [{ ...message('focus'), turnId: 'focus' }],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    if (response.reset) throw new Error('unexpected reset response');
    expect(() => {
      assertAgentDeviceRpcResponseCorrelation(
        AGENT_DEVICE_RPC_METHODS.loadAround,
        request,
        response,
      );
    }).not.toThrow();
    expect(() => {
      assertAgentDeviceRpcResponseCorrelation(
        AGENT_DEVICE_RPC_METHODS.loadAround,
        request,
        { ...response, revision: 'revision-2' },
      );
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() => {
      assertAgentDeviceRpcResponseCorrelation(
        AGENT_DEVICE_RPC_METHODS.loadAround,
        request,
        { ...response, focus: { kind: 'turn', turnId: 'focus', entryId: 'forged-entry' } },
      );
    }).toThrow(AgentDeviceRpcProtocolError);
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.loadAround, {
        reset: true,
        conversationId: 'conversation-1',
        revision: 'revision-2',
        items: [],
      })
    ).toThrow(AgentDeviceRpcProtocolError);
    expect(() =>
      parseAgentDeviceRpcResponse(AGENT_DEVICE_RPC_METHODS.loadAround, {
        ...response,
        items: [],
        hasMoreBefore: true,
      })
    ).toThrow(AgentDeviceRpcProtocolError);
  });

  it('uses bounded turn-first summaries with opaque bidirectional cursors', async () => {
    const sendRpc = vi.fn(async () => ({
      items: [turn('turn-1')],
      previousCursor: 'previous-opaque',
      nextCursor: 'next-opaque',
      hasMoreBefore: true,
      hasMoreAfter: true,
      seenCursorFound: true,
      budget: { bytes: 256, renderLines: 2, truncated: false },
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    const page = await client.listTurns({
      conversationId: 'conversation-1',
      cursor: 'current-opaque',
      seenCursor: 'previously-rendered',
      direction: 'backward',
      limit: 20,
      byteBudget: 1_024,
      renderLineBudget: 100,
    });

    expect(page.items[0]).toMatchObject({
      turnId: 'turn-1',
      userPreview: 'user turn-1',
      participantPreviews: [{ preview: 'assistant turn-1' }],
      responseCount: 1,
      detailState: 'summary',
    });
    expect(page.seenCursorFound).toBe(true);
  });

  it('reassembles UTF-8 message JSON split across base64 chunks', async () => {
    const detail = message('detail', '你好 🌍');
    const bytes = new TextEncoder().encode(JSON.stringify(detail));
    const split = bytes.indexOf(0xE4) + 1;
    const sendRpc = vi.fn(async (_peerId: string, method: string, parameters: unknown) => {
      expect(method).toBe(AGENT_DEVICE_RPC_METHODS.getMessageDetail);
      const offset = (parameters as { offset: number }).offset;
      const end = offset === 0 ? split : bytes.length;
      return {
        found: true,
        encoding: 'base64-json',
        data: bytesToBase64(bytes.subarray(offset, end)),
        offset,
        totalBytes: bytes.length,
        ...(end < bytes.length ? { nextOffset: end } : {}),
      };
    });
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.readMessageDetail({
      conversationId: 'conversation-1',
      messageId: 'detail',
    })).resolves.toEqual(detail);
    expect(sendRpc).toHaveBeenCalledTimes(2);
  });

  it('enforces attachment host bounds before allocating the declared total', async () => {
    const sendRpc = vi.fn(async () => ({
      found: true,
      reference: { contentHash: 'hash', filename: 'file', mimeType: 'text/plain', size: 5_000 },
      encoding: 'base64',
      data: bytesToBase64(new Uint8Array([1])),
      offset: 0,
      totalBytes: 5_000,
      nextOffset: 1,
    }));
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.readAttachment({ conversationId: 'conversation-1', contentHash: 'hash' }, { maxBytes: 1_024 }))
      .rejects.toMatchObject({ code: 'invalid_agent_device_rpc' });
  });

  it('rejects gaps, overlaps, changing totals, and non-terminal chunk endings', async () => {
    for (
      const malformed of [
        { offset: 1, totalBytes: 2, data: bytesToBase64(new Uint8Array([1])), nextOffset: 2 },
        { offset: 0, totalBytes: 2, data: bytesToBase64(new Uint8Array([1])), nextOffset: 0 },
        { offset: 0, totalBytes: 2, data: bytesToBase64(new Uint8Array([1])) },
      ]
    ) {
      const client = createAgentDeviceRpcClient({
        peerId: 'peer-b',
        sendRpc: vi.fn(async () => ({
          found: true,
          encoding: 'base64-json',
          ...malformed,
        })),
      });
      await expect(client.readMessageDetail({
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
    }

    let call = 0;
    const changingTotalClient = createAgentDeviceRpcClient({
      peerId: 'peer-b',
      sendRpc: vi.fn(async (_peerId, _method, parameters) => {
        const offset = (parameters as { offset: number }).offset;
        call += 1;
        return {
          found: true,
          encoding: 'base64-json',
          data: bytesToBase64(new Uint8Array([1])),
          offset,
          totalBytes: call === 1 ? 2 : 3,
          ...(call === 1 ? { nextOffset: 1 } : {}),
        };
      }),
    });
    await expect(changingTotalClient.readMessageDetail({
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
  });

  it('caps one-byte chunk amplification and absolute attachment allocation', async () => {
    const tinyChunkTransport = vi.fn(async (_peerId, _method, parameters) => {
      const offset = (parameters as { offset: number }).offset;
      return {
        found: true,
        encoding: 'base64-json',
        data: bytesToBase64(new Uint8Array([0x20])),
        offset,
        totalBytes: 300,
        ...(offset + 1 < 300 ? { nextOffset: offset + 1 } : {}),
      };
    });
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc: tinyChunkTransport });
    await expect(client.readMessageDetail({
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).rejects.toMatchObject({ field: 'response.chunkCount' });
    expect(tinyChunkTransport).toHaveBeenCalledTimes(256);

    const neverCalled = vi.fn();
    const attachmentClient = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc: neverCalled });
    await expect(attachmentClient.readAttachment({
      conversationId: 'conversation-1',
      contentHash: 'hash',
    }, { maxBytes: 64 * 1024 * 1024 + 1 })).rejects.toMatchObject({ field: 'options.maxBytes' });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('aborts a pending chunk read on caller cancellation or its whole-operation deadline', async () => {
    for (const mode of ['caller', 'deadline'] as const) {
      const controller = new AbortController();
      const sendRpc = vi.fn((_peerId, _method, _parameters, transportOptions) =>
        new Promise<unknown>((_resolve, reject) => {
          transportOptions?.signal?.addEventListener(
            'abort',
            () => {
              const reason = transportOptions.signal?.reason;
              reject(reason instanceof Error ? reason : new Error('aborted'));
            },
            { once: true },
          );
        })
      );
      const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });
      const pending = client.readMessageDetail(
        {
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
        mode === 'caller'
          ? { signal: controller.signal, deadlineMs: 1_000 }
          : { deadlineMs: 5 },
      );
      await Promise.resolve();
      if (mode === 'caller') controller.abort(new Error('cancelled-detail-read'));
      await expect(pending).rejects.toThrow(
        mode === 'caller' ? 'cancelled-detail-read' : 'agent_device_rpc_detail_deadline',
      );
      expect(sendRpc).toHaveBeenCalledOnce();
    }
  });

  it('exposes status, cancel, and terminal-aware run log contracts', async () => {
    const sendRpc = vi.fn(async (_peerId: string, method: string) => {
      if (method === AGENT_DEVICE_RPC_METHODS.getRunStatus) return { status: status() };
      if (method === AGENT_DEVICE_RPC_METHODS.cancel) return { ok: true, status: status('cancelled') };
      return {
        messages: [{ messageId: 'log-1', role: 'assistant', content: 'done' }],
        hasMoreAfter: false,
        runStatus: status('completed'),
      };
    });
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.getRunStatus({ runId: 'run-1' })).resolves.toMatchObject({ status: { state: 'running' } });
    await expect(client.cancel({ runId: 'run-1' })).resolves.toMatchObject({ status: { state: 'cancelled' } });
    await expect(client.pullAgentRunLog({
      conversationId: 'conversation-1',
      runId: 'run-1',
    })).resolves.toMatchObject({ runStatus: { state: 'completed' }, hasMoreAfter: false });
  });

  it('deletes a turn only by returning its canonical tombstone event', async () => {
    const sendRpc = vi.fn(async (_peerId: string, method: string, parameters: unknown) => {
      expect(method).toBe(AGENT_DEVICE_RPC_METHODS.deleteTurn);
      const request = parameters as { conversationId: string; turnId: string; requestId: string; reason: 'user-delete' };
      return {
        ok: true,
        conversationId: request.conversationId,
        turnId: request.turnId,
        requestId: request.requestId,
        tombstone: tombstone(request.turnId, request.reason),
      };
    });
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });

    await expect(client.deleteTurn({
      conversationId: 'conversation-1',
      turnId: 'turn-old',
      requestId: 'delete-request-1',
      reason: 'user-delete',
    })).resolves.toMatchObject({
      tombstone: { kind: 'tombstone', targetTurnId: 'turn-old' },
    });
  });

  it('retries atomically with tombstone(old), user event(new), and one idempotent run handle', async () => {
    const sendRpc = vi.fn(async (_peerId: string, method: string, parameters: unknown) => {
      expect(method).toBe(AGENT_DEVICE_RPC_METHODS.retryTurn);
      const request = parameters as {
        conversationId: string;
        turnId: string;
        newTurnId: string;
        requestId: string;
      };
      expect(request).not.toHaveProperty('message');
      return {
        ok: true,
        runId: 'retry-run-1',
        conversationId: request.conversationId,
        turnId: request.newTurnId,
        requestId: request.requestId,
        state: 'accepted',
        tombstone: tombstone(request.turnId, 'user-delete'),
        userEvent: userEvent(request.newTurnId, 'durable original user content'),
      };
    });
    const client = createAgentDeviceRpcClient({ peerId: 'peer-b', sendRpc });
    const request = {
      conversationId: 'conversation-1',
      turnId: 'turn-old',
      newTurnId: 'turn-retry',
      requestId: 'retry-request-1',
    };

    await expect(client.retryTurn(request)).resolves.toMatchObject({
      runId: 'retry-run-1',
      turnId: 'turn-retry',
      tombstone: { targetTurnId: 'turn-old' },
      userEvent: { message: { turnId: 'turn-retry', content: 'durable original user content' } },
    });
    await client.retryTurn(request);
    const calls = sendRpc.mock.calls as unknown as Array<[string, string, unknown]>;
    expect(calls[0]?.[2]).toEqual(calls[1]?.[2]);
  });

  it('rejects caller-supplied retry content so the target must load the durable original turn', () => {
    expect(() => {
      assertAgentDeviceRpcRequest(AGENT_DEVICE_RPC_METHODS.retryTurn, {
        conversationId: 'conversation-1',
        turnId: 'turn-old',
        newTurnId: 'turn-retry',
        requestId: 'retry-request-1',
        message: 'untrusted resident-window copy',
      });
    }).toThrow(AgentDeviceRpcProtocolError);
  });

  it('rejects a turn-control response scoped to another turn', async () => {
    const client = createAgentDeviceRpcClient({
      peerId: 'peer-b',
      sendRpc: async () => ({
        ok: true,
        conversationId: 'conversation-1',
        turnId: 'turn-old',
        requestId: 'delete-request-1',
        tombstone: tombstone('another-turn', 'user-delete'),
      }),
    });

    await expect(client.deleteTurn({
      conversationId: 'conversation-1',
      turnId: 'turn-old',
      requestId: 'delete-request-1',
      reason: 'user-delete',
    })).rejects.toBeInstanceOf(AgentDeviceRpcProtocolError);
  });
});

function tombstone(turnId: string, reason: 'user-delete' | 'retention' | 'redaction') {
  return {
    eventId: `tombstone-${turnId}`,
    conversationId: 'conversation-1',
    originNodeId: 'node-b',
    originSequence: 20,
    lamportClock: 20,
    timestamp: 20,
    kind: 'tombstone',
    targetTurnId: turnId,
    reason,
  } as const;
}

function userEvent(turnId: string, content: string) {
  return {
    eventId: turnId,
    conversationId: 'conversation-1',
    originNodeId: 'node-b',
    originSequence: 21,
    lamportClock: 21,
    timestamp: 21,
    kind: 'message',
    message: {
      messageId: turnId,
      turnId,
      role: 'user',
      content,
    },
  } as const;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

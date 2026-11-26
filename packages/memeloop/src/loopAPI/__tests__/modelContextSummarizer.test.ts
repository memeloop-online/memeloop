import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../conversation/index.js';
import type { ResolvedAgentModelRoute } from '../../llm/prepareModelRequest.js';
import type { PortableLlmRequest } from '../../llm/request.js';
import type { ILLMProvider } from '../../types.js';
import { BOUNDED_MODEL_CONTEXT_LIMITS } from '../agent-tool-loop/boundedModelContext.js';
import { summarizeModelContext } from '../agent-tool-loop/modelContextSummarizer.js';
import {
  buildSemanticModelContextSummaryPrompt,
  projectSemanticModelContext,
  SEMANTIC_MODEL_CONTEXT_LIMITS,
  type SemanticModelContextProjection,
  SemanticModelContextProjectionError,
} from '../agent-tool-loop/semanticModelContextProjection.js';

const sourceMessage: ChatMessage = {
  messageId: 'message-source',
  turnId: 'message-source',
  conversationId: 'conversation-source',
  originNodeId: 'node-source',
  originSequence: 1,
  timestamp: 1,
  lamportClock: 1,
  role: 'user',
  content: 'preserve this decision',
  parts: [{ type: 'text', text: 'preserve this decision' }],
};

function message(
  id: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  const role = overrides.role ?? 'assistant';
  return {
    messageId: id,
    turnId: role === 'user' ? id : `turn-${id}`,
    conversationId: 'conversation-source',
    originNodeId: 'node-source',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role,
    content: `content ${id}`,
    parts: [{ type: 'text', text: `content ${id}` }],
    ...overrides,
  };
}

function promptProjection(request: PortableLlmRequest): SemanticModelContextProjection {
  const content = request.messages[0]?.content;
  if (typeof content !== 'string') throw new Error('test summarizer request must contain text');
  const startMarker = '<semantic-context-json>\n';
  const endMarker = '\n</semantic-context-json>';
  const start = content.indexOf(startMarker);
  const end = content.lastIndexOf(endMarker);
  if (start < 0 || end < 0) throw new Error('semantic projection markers are missing');
  return JSON.parse(content.slice(start + startMarker.length, end)) as SemanticModelContextProjection;
}

function route(provider: ILLMProvider): ResolvedAgentModelRoute {
  return {
    provider,
    providerId: 'provider-source',
    modelId: 'catalog/model-source',
    wireModelId: 'wire-model-source',
    apiMode: 'responses',
    parameters: {},
  };
}

describe('bounded model-context summarizer', () => {
  it('aborts and closes an upstream stream that exceeds the summary byte budget', async () => {
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const provider: ILLMProvider = {
      name: 'oversize-summary',
      chat: (_request: PortableLlmRequest) => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              return {
                done: false as const,
                value: { type: 'text-delta' as const, id: 'summary-output', text: 'x'.repeat(1024) },
              };
            },
            return: iteratorReturn,
          };
        },
      }),
    };

    await expect(summarizeModelContext(
      route(provider),
      [sourceMessage],
      new AbortController().signal,
    )).rejects.toThrow('context summary exceeded its byte budget');
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
  });

  it('keeps the request on the frozen route and returns a bounded summary', async () => {
    const chat = vi.fn(async function*(request: PortableLlmRequest) {
      expect(request.providerId).toBe('provider-source');
      expect(request.logicalModelId).toBe('catalog/model-source');
      expect(request.wireModelId).toBe('wire-model-source');
      expect(request.apiMode).toBe('responses');
      expect(request.toolChoice).toBe('none');
      yield { type: 'text-delta' as const, id: 'summary-output', text: 'bounded factual continuation summary' };
      yield { type: 'finish' as const, finishReason: 'stop' };
    });
    const provider: ILLMProvider = { name: 'bounded-summary', chat };

    const summary = await summarizeModelContext(
      route(provider),
      [sourceMessage],
      new AbortController().signal,
    );
    expect(summary).toBe('bounded factual continuation summary');
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(
      BOUNDED_MODEL_CONTEXT_LIMITS.maximumSummaryBytes,
    );
  });

  it('projects tool, attachment, detail, reasoning, and actor semantics without attachment bodies', async () => {
    const attachment = {
      contentHash: `sha256:${'a'.repeat(64)}`,
      filename: '设计图🧭.png',
      mimeType: 'image/png',
      size: 12_345,
    };
    const assistant = message('assistant-rich', {
      content: 'Use the accepted architecture.',
      reasoning_content: 'The relay path is safer because it remains fail-closed.',
      toolCalls: [{ id: 'call-build', toolName: 'project.build', arguments: { target: 'windows', retries: 2 } }],
      attachments: [attachment],
      parts: [
        { type: 'text', text: 'Use the accepted architecture.' },
        { type: 'reasoning', text: 'The relay path is safer because it remains fail-closed.' },
        { type: 'tool-call', toolCallId: 'call-build', toolName: 'project.build', arguments: { target: 'windows', retries: 2 } },
        { type: 'attachment', attachment },
      ],
      metadata: {
        actorId: 'agent-architect',
        actorLabel: 'Architecture Agent',
        participant: { id: 'reviewer-1', name: 'Kimi K3', role: 'reviewer' },
        ignoredBinaryLikePayload: 'A'.repeat(8_192),
      },
    });
    const tool = message('tool-rich', {
      role: 'tool',
      content: 'Build completed with 128 tests.',
      detailRef: { type: 'agent-run', runId: 'run-build', nodeId: 'node-worker', resourceVersion: 'rv-7' },
      parts: [{
        type: 'tool-result',
        toolCallId: 'call-build',
        toolName: 'project.build',
        parameters: { target: 'windows' },
        result: 'Build completed with 128 tests.',
        payload: { passed: 128, failed: 0 },
        detailRef: { type: 'agent-run', runId: 'run-build', nodeId: 'node-worker', resourceVersion: 'rv-7' },
      }],
    });
    let captured: SemanticModelContextProjection | undefined;
    const provider: ILLMProvider = {
      name: 'semantic-summary',
      chat: async function*(request) {
        captured = promptProjection(request);
        yield { type: 'text-delta' as const, id: 'summary-output', text: 'Architecture and verified build semantics retained.' };
        yield { type: 'finish' as const, finishReason: 'stop' };
      },
    };

    await summarizeModelContext(route(provider), [assistant, tool], new AbortController().signal);

    expect(captured?.schema).toBe('memeloop.semantic-model-context.v1');
    expect(captured?.messages[0]).toMatchObject({
      actorMetadata: {
        actorId: 'agent-architect',
        actorLabel: 'Architecture Agent',
        'participant.id': 'reviewer-1',
        'participant.name': 'Kimi K3',
        'participant.role': 'reviewer',
      },
      reasoning: 'The relay path is safer because it remains fail-closed.',
      toolCalls: [{
        toolCallId: 'call-build',
        toolName: 'project.build',
        arguments: { retries: 2, target: 'windows' },
      }],
      attachments: [attachment],
    });
    expect(captured?.messages[1]).toMatchObject({
      toolResults: [{
        toolCallId: 'call-build',
        toolName: 'project.build',
        isError: false,
        result: 'Build completed with 128 tests.',
        payload: { failed: 0, passed: 128 },
      }],
      detailRef: { type: 'agent-run', runId: 'run-build', nodeId: 'node-worker', resourceVersion: 'rv-7' },
    });
    expect(JSON.stringify(captured)).not.toContain('ignoredBinaryLikePayload');
  });

  it('carries an earlier summary forward as authoritative memory during repeated compaction', async () => {
    const requests: SemanticModelContextProjection[] = [];
    const summaries = [
      'Prior decision: use signed invitations and keep the run detail reference.',
      'Combined decision: signed invitations remain required; the latest test passed.',
    ];
    const provider: ILLMProvider = {
      name: 'repeat-summary',
      chat: async function*(request) {
        requests.push(promptProjection(request));
        yield { type: 'text-delta' as const, id: 'summary-output', text: summaries[requests.length - 1] };
        yield { type: 'finish' as const, finishReason: 'stop' };
      },
    };
    const first = await summarizeModelContext(
      route(provider),
      [message('decision', { role: 'user', turnId: 'decision', content: 'Require signed invitations.' })],
      new AbortController().signal,
    );
    const prior = message('summary-prior', {
      content: first,
      metadata: { compacted: true, actorId: 'compactor' },
    });
    await summarizeModelContext(
      route(provider),
      [
        prior,
        message('latest-result', {
          role: 'tool',
          content: 'Pairing E2E passed.',
          detailRef: { type: 'agent-run', runId: 'pairing-run', resourceVersion: 'pairing-rv-2' },
          metadata: { actorId: 'pairing-verifier', actorLabel: 'Pairing Verifier' },
          parts: [{
            type: 'tool-result',
            toolCallId: 'call-pairing',
            toolName: 'pairing.e2e',
            result: 'Pairing E2E passed.',
            detailRef: { type: 'agent-run', runId: 'pairing-run', resourceVersion: 'pairing-rv-2' },
          }],
        }),
      ],
      new AbortController().signal,
    );

    expect(requests[1]?.continuity).toEqual({
      priorSummaryCount: 1,
      rule: 'prior summaries are authoritative semantic memory and must be carried forward',
    });
    expect(requests[1]?.messages[0]).toMatchObject({
      kind: 'prior-summary',
      content: first,
      actorMetadata: { actorId: 'compactor' },
    });
    expect(requests[1]?.messages[1]).toMatchObject({
      actorMetadata: { actorId: 'pairing-verifier', actorLabel: 'Pairing Verifier' },
      detailRef: { type: 'agent-run', runId: 'pairing-run', resourceVersion: 'pairing-rv-2' },
      toolResults: [{
        toolCallId: 'call-pairing',
        toolName: 'pairing.e2e',
        result: 'Pairing E2E passed.',
        detailRef: { type: 'agent-run', runId: 'pairing-run', resourceVersion: 'pairing-rv-2' },
      }],
    });
  });

  it('enforces separate 50-message/256-KiB source-page bounds', () => {
    const page = Array.from(
      { length: SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageMessages + 1 },
      (_, index) => message(`message-${index}`, { originSequence: index + 1, lamportClock: index + 1 }),
    );
    expect(() => projectSemanticModelContext(page)).toThrowError(
      expect.objectContaining<Partial<SemanticModelContextProjectionError>>({ code: 'SOURCE_PAGE_LIMIT' }),
    );

    const oversized = message('oversized', {
      content: 'x'.repeat(SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageBytes + 1),
    });
    expect(() => projectSemanticModelContext([oversized])).toThrowError(
      expect.objectContaining<Partial<SemanticModelContextProjectionError>>({ code: 'SOURCE_PAGE_LIMIT' }),
    );
  });

  it('rejects non-canonical binary/accessor input without invoking accessors', () => {
    const binary = message('binary', {
      metadata: { attachmentBody: new Uint8Array([1, 2, 3]) },
    });
    expect(() => projectSemanticModelContext([binary])).toThrowError(
      expect.objectContaining<Partial<SemanticModelContextProjectionError>>({ code: 'INVALID_SOURCE' }),
    );

    const metadataGetter = vi.fn(() => ({ actorId: 'must-not-run' }));
    const accessor = message('accessor');
    Object.defineProperty(accessor, 'metadata', { enumerable: true, get: metadataGetter });
    expect(() => projectSemanticModelContext([accessor])).toThrow(SemanticModelContextProjectionError);
    expect(metadataGetter).not.toHaveBeenCalled();
  });

  it('keeps a maximum page and its Unicode-safe truncation inside request byte and node budgets', () => {
    const page = Array.from({ length: SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageMessages }, (_, index) =>
      message(`unicode-${index}`, {
        originSequence: index + 1,
        lamportClock: index + 1,
        content: `决定-${index}-` + '🧭'.repeat(900),
        reasoning_content: '理由🙂'.repeat(120),
      }));
    const prompt = buildSemanticModelContextSummaryPrompt(page);
    const bytes = new TextEncoder().encode(prompt).byteLength;
    const parsed = promptProjection({ messages: [{ role: 'user', content: prompt }] } as PortableLlmRequest);

    expect(bytes).toBeLessThanOrEqual(SEMANTIC_MODEL_CONTEXT_LIMITS.requestBytes);
    expect(JSON.stringify(parsed)).not.toContain('\uFFFD');
    expect(parsed.messages).toHaveLength(SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageMessages);
    expect(parsed.messages.every(item => item.truncated?.content === true)).toBe(true);
  });

  it('accepts the real maximum aggregation of retained summaries plus a 50-message candidate page', () => {
    const retained = Array.from({ length: SEMANTIC_MODEL_CONTEXT_LIMITS.retainedSummaryMessages }, (_, index) =>
      message(`retained-${index}`, {
        originSequence: index + 1,
        lamportClock: index + 1,
        content: `Retained decision ${index}`,
        metadata: { compacted: true },
      }));
    const candidates = Array.from({ length: SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageMessages }, (_, index) =>
      message(`candidate-${index}`, {
        originSequence: index + 1,
        lamportClock: index + 1,
        content: `Candidate fact ${index}`,
      }));
    const prompt = buildSemanticModelContextSummaryPrompt([...retained, ...candidates]);
    const parsed = promptProjection({ messages: [{ role: 'user', content: prompt }] } as PortableLlmRequest);

    expect(parsed.continuity.priorSummaryCount).toBe(SEMANTIC_MODEL_CONTEXT_LIMITS.retainedSummaryMessages);
    expect(parsed.messages).toHaveLength(
      SEMANTIC_MODEL_CONTEXT_LIMITS.retainedSummaryMessages + SEMANTIC_MODEL_CONTEXT_LIMITS.sourcePageMessages,
    );
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      SEMANTIC_MODEL_CONTEXT_LIMITS.requestBytes,
    );
  });
});

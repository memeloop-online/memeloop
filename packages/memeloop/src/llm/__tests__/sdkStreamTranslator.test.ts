import { describe, expect, it, vi } from 'vitest';

import { toPortableStreamParts, translateSdkFullStream } from '../sdkStreamTranslator.js';

describe('AI SDK stream boundary', () => {
  it('maps native text and tool chunks without coercion', () => {
    expect(toPortableStreamParts({ type: 'text-delta', id: 'text-1', text: 'hello' })).toEqual([{
      type: 'text-delta',
      id: 'text-1',
      text: 'hello',
    }]);
    expect(toPortableStreamParts({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { x: 0.5 },
    })).toEqual([{
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { x: 0.5 },
    }]);
    expect(toPortableStreamParts({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { x: 0.5 },
      output: { type: 'json', value: { answer: 'ok' }, providerMetadata: { vendor: 'ignored' } },
      providerMetadata: { vendor: 'ignored' },
    })).toEqual([{
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'lookup',
      output: { type: 'json', value: { answer: 'ok' } },
    }]);
    expect(toPortableStreamParts({
      type: 'tool-error',
      toolCallId: 'call-2',
      toolName: 'lookup',
      input: {},
      error: 'lookup failed',
    })).toEqual([{
      type: 'tool-result',
      toolCallId: 'call-2',
      toolName: 'lookup',
      output: { type: 'error-text', value: 'lookup failed' },
    }]);
  });

  it('fails closed with a stable code for provider output the portable contract cannot represent', () => {
    expect(() =>
      toPortableStreamParts({
        type: 'file',
        file: { base64: 'AA==', mediaType: 'application/octet-stream' },
      })
    ).toThrowError(expect.objectContaining({ code: 'LLM_STREAM_UNSUPPORTED_PART' }));
    expect(() =>
      toPortableStreamParts({
        type: 'tool-approval-request',
        approvalId: 'approval-1',
        toolCall: { toolCallId: 'call-1', toolName: 'lookup', input: {} },
      })
    ).toThrowError(expect.objectContaining({ code: 'LLM_STREAM_UNSUPPORTED_PART' }));
  });

  it('rejects missing, non-string, and accessor fields instead of coercing them', () => {
    expect(() => toPortableStreamParts({ type: 'text-delta', text: 'hello' }))
      .toThrow("field 'id'");
    expect(() => toPortableStreamParts({ type: 'text-delta', id: 7, text: 'hello' }))
      .toThrow("field 'id'");

    const read = vi.fn(() => 'secret');
    const malicious = Object.defineProperty(
      { type: 'text-delta', id: 'text-1' },
      'text',
      { enumerable: true, get: read },
    );
    expect(() => toPortableStreamParts(malicious)).toThrow("field 'text'");
    expect(read).not.toHaveBeenCalled();
  });

  it('projects final usage exactly once before finish and tolerates absent optional counts', () => {
    expect(toPortableStreamParts({
      type: 'finish',
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: { cacheReadTokens: 3 },
        outputTokenDetails: { reasoningTokens: undefined },
      },
    })).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 3 },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('enforces usage-before-finish and rejects truncated SDK streams with a stable code', async () => {
    const complete = (async function*() {
      yield { type: 'text-delta', id: 'text-1', text: 'hello' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: {},
          outputTokenDetails: {},
        },
      };
    })();
    const parts = [];
    for await (const part of translateSdkFullStream(complete)) parts.push(part);
    expect(parts.map(part => part.type)).toEqual(['text-delta', 'usage', 'finish']);

    const truncated = translateSdkFullStream((async function*() {
      yield { type: 'text-delta', id: 'text-1', text: 'partial' };
    })());
    await expect(async () => {
      for await (const _part of truncated) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'LLM_STREAM_TRUNCATED' });
  });
});

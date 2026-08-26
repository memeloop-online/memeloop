import { describe, expect, it } from 'vitest';

import { toPortableGenerateResultParts } from '../sdkGenerateResultTranslator.js';

function result() {
  return {
    reasoningText: 'checked the constraints',
    text: 'answer',
    toolCalls: [{ toolCallId: 'call-1', toolName: 'lookup', input: { x: 0.5 } }],
    output: { answer: 'structured' },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: { cacheReadTokens: 3 },
      outputTokenDetails: { reasoningTokens: 2 },
    },
    finishReason: 'tool-calls',
    files: [],
    sources: [],
    toolResults: [],
  };
}

describe('AI SDK complete-result boundary', () => {
  it('preserves reasoning, text, tool calls, structured output, usage, and finish order', () => {
    expect(toPortableGenerateResultParts(result(), true)).toEqual([
      { type: 'reasoning-delta', id: 'reasoning-final', text: 'checked the constraints' },
      { type: 'text-delta', id: 'text-final', text: 'answer' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { x: 0.5 } },
      { type: 'structured-output', output: { answer: 'structured' } },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
  });

  it('fails instead of silently dropping unsupported complete-result content', () => {
    expect(() => toPortableGenerateResultParts({ ...result(), files: [{}] }, false))
      .toThrow('unsupported files');
    expect(() =>
      toPortableGenerateResultParts({
        ...result(),
        toolCalls: [{ toolCallId: 'call-1', toolName: 'lookup', input: { bad: Number.NaN } }],
      }, false)
    ).toThrow('portable LLM JSON');
  });
});

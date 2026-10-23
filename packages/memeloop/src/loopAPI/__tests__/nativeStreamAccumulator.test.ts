import { describe, expect, it, vi } from 'vitest';

import { PORTABLE_LLM_STREAM_LIMITS, type PortableLlmStreamPart } from '../../llm/response.js';
import { streamLlm } from '../agent-tool-loop/llmStream.js';
import { NATIVE_MODEL_TRANSIENT_STREAM_LIMITS, NativeModelStreamAccumulator } from '../agent-tool-loop/nativeStreamAccumulator.js';

describe('NativeModelStreamAccumulator', () => {
  it('exposes bounded Unicode-safe text and reasoning snapshots without changing the durable result', () => {
    const accumulator = new NativeModelStreamAccumulator();
    const text = `${'a'.repeat(NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.textBytes - 3)}🙂tail`;
    const reasoning = `${
      '思'.repeat(
        Math.floor(NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.reasoningBytes / 3),
      )
    }考`;
    accumulator.apply({ type: 'text-delta', id: 'text', text });
    accumulator.apply({ type: 'reasoning-delta', id: 'reasoning', text: reasoning });

    const snapshot = accumulator.transientSnapshot();
    expect(new TextEncoder().encode(snapshot.assistantText).byteLength).toBeLessThanOrEqual(
      NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.textBytes,
    );
    expect(new TextEncoder().encode(snapshot.assistantReasoning).byteLength).toBeLessThanOrEqual(
      NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.reasoningBytes,
    );
    expect(snapshot.assistantText.endsWith('\ud83d')).toBe(false);
    expect(snapshot.textTruncated).toBe(true);
    expect(snapshot.reasoningTruncated).toBe(true);

    accumulator.apply({ type: 'finish', finishReason: 'stop' });
    expect(accumulator.finalize()).toMatchObject({
      assistantText: text,
      assistantReasoning: reasoning,
    });
  });

  it('reports streamed tool-input progress and only exposes bounded completed tool arguments', () => {
    const accumulator = new NativeModelStreamAccumulator();
    accumulator.apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'lookup' });
    accumulator.apply({ type: 'tool-input-delta', toolCallId: 'call-1', delta: '{"query":"hi"}' });
    expect(accumulator.transientSnapshot()).toMatchObject({
      activeToolInputs: [{
        toolCallId: 'call-1',
        toolName: 'lookup',
        inputBytes: 14,
        ended: false,
      }],
      nativeCalls: [],
    });
    accumulator.apply({ type: 'tool-input-end', toolCallId: 'call-1' });
    accumulator.apply({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { query: 'hi' },
    });
    const completed = accumulator.transientSnapshot();
    expect(completed.activeToolInputs).toEqual([]);
    expect(completed.nativeCalls).toEqual([{
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { query: 'hi' },
    }]);

    // Subscriber mutation never changes the accumulator's final durable value.
    completed.nativeCalls[0].input.query = 'mutated';
    accumulator.apply({ type: 'finish', finishReason: 'tool-calls' });
    expect(accumulator.finalize().nativeCalls[0].input).toEqual({ query: 'hi' });
  });

  it('assembles one-byte tool-input deltas up to 1 MiB without repeated whole-buffer encoding', () => {
    const accumulator = new NativeModelStreamAccumulator();
    accumulator.apply({ type: 'tool-input-start', toolCallId: 'c', toolName: 't' });
    const prefix = '{"value":"';
    const suffix = '"}';
    for (const character of prefix) {
      accumulator.apply({ type: 'tool-input-delta', toolCallId: 'c', delta: character });
    }
    const payloadBytes = PORTABLE_LLM_STREAM_LIMITS.toolInputBytes - prefix.length - suffix.length;
    for (let index = 0; index < payloadBytes; index += 1) {
      accumulator.apply({ type: 'tool-input-delta', toolCallId: 'c', delta: 'a' });
    }
    for (const character of suffix) {
      accumulator.apply({ type: 'tool-input-delta', toolCallId: 'c', delta: character });
    }
    accumulator.apply({ type: 'tool-input-end', toolCallId: 'c' });
    accumulator.apply({
      type: 'tool-call',
      toolCallId: 'c',
      toolName: 't',
      input: { value: 'a'.repeat(payloadBytes) },
    });
    accumulator.apply({ type: 'finish', finishReason: 'tool-calls' });

    expect(accumulator.finalize().nativeCalls).toHaveLength(1);
  }, 30_000);

  it('rejects dangling and split/final-mismatched tool inputs', () => {
    const dangling = new NativeModelStreamAccumulator();
    dangling.apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'lookup' });
    expect(() => dangling.finalize()).toThrow('dangling tool input');

    const mismatch = new NativeModelStreamAccumulator();
    mismatch.apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'lookup' });
    mismatch.apply({ type: 'tool-input-delta', toolCallId: 'call-1', delta: '{"x":1}' });
    mismatch.apply({ type: 'tool-input-end', toolCallId: 'call-1' });
    expect(() => {
      mismatch.apply({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: { x: 2 },
      });
    }).toThrow('does not match');
  });

  it('requires exactly one finish and preserves exactly one bounded usage snapshot', () => {
    const truncated = new NativeModelStreamAccumulator();
    truncated.apply({ type: 'text-delta', id: 'text-1', text: 'partial' });
    expect(() => truncated.finalize()).toThrow('LLM_STREAM_TRUNCATED');

    const complete = new NativeModelStreamAccumulator();
    complete.apply({ type: 'usage', inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(() => {
      complete.apply({ type: 'usage', totalTokens: 12 });
    })
      .toThrow('LLM_STREAM_DUPLICATE_USAGE');
    complete.apply({ type: 'finish', finishReason: 'stop' });
    expect(complete.finalize().usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(() => {
      complete.apply({ type: 'finish', finishReason: 'stop' });
    })
      .toThrow('after finish');
  });

  it('rejects control characters in portable stream identifiers', () => {
    const accumulator = new NativeModelStreamAccumulator();
    expect(() => {
      accumulator.apply({ type: 'finish', finishReason: 'stop\nforged' });
    })
      .toThrow('finish reason');
    expect(() => {
      accumulator.apply({
        type: 'tool-call',
        toolCallId: 'call\u0000forged',
        toolName: 'lookup',
        input: {},
      });
    }).toThrow('tool call');
  });

  it('bounds tool-call count', () => {
    const accumulator = new NativeModelStreamAccumulator();
    for (let index = 0; index < PORTABLE_LLM_STREAM_LIMITS.toolCalls; index += 1) {
      accumulator.apply({
        type: 'tool-call',
        toolCallId: `call-${index}`,
        toolName: 'lookup',
        input: {},
      });
    }
    expect(() => {
      accumulator.apply({
        type: 'tool-call',
        toolCallId: 'call-overflow',
        toolName: 'lookup',
        input: {},
      });
    }).toThrow('tool call limit');
  });

  it('closes the provider iterator exactly once when aggregate output overflows', async () => {
    const return_ = vi.fn(async () => ({ done: true as const, value: undefined }));
    let emitted = 0;
    const delta: PortableLlmStreamPart = {
      type: 'text-delta',
      id: 't',
      text: 'x'.repeat(PORTABLE_LLM_STREAM_LIMITS.deltaBytes),
    };
    const provider = {
      name: 'test',
      chat: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              emitted += 1;
              return { done: false as const, value: delta };
            },
            return: return_,
          };
        },
      }),
    };
    const accumulator = new NativeModelStreamAccumulator();
    const request = {
      providerId: 'test',
      logicalModelId: 'model',
      wireModelId: 'model',
      apiMode: 'chat-completions' as const,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    await expect((async () => {
      for await (const part of streamLlm(provider, request)) accumulator.apply(part);
    })()).rejects.toThrow('aggregate byte limit');
    expect(emitted).toBeLessThan(20);
    expect(return_).toHaveBeenCalledTimes(1);
  });

  it('fails a normally exhausted truncated provider stream without double-closing it', async () => {
    const return_ = vi.fn(async () => ({ done: true as const, value: undefined }));
    let emitted = false;
    const provider = {
      name: 'test',
      chat: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (emitted) return { done: true as const, value: undefined };
              emitted = true;
              return {
                done: false as const,
                value: { type: 'text-delta' as const, id: 'text-1', text: 'truncated' },
              };
            },
            return: return_,
          };
        },
      }),
    };
    const accumulator = new NativeModelStreamAccumulator();
    const request = {
      providerId: 'test',
      logicalModelId: 'model',
      wireModelId: 'model',
      apiMode: 'chat-completions' as const,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    for await (const part of streamLlm(provider, request)) accumulator.apply(part);

    expect(() => accumulator.finalize()).toThrow('LLM_STREAM_TRUNCATED');
    expect(return_).not.toHaveBeenCalled();
  });
});

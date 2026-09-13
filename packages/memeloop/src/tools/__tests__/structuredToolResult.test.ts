import { describe, expect, it } from 'vitest';

import {
  canonicalizeToolResult,
  MAX_TOOL_RESULT_CANONICAL_BYTES,
  MAX_TOOL_RESULT_SUMMARY_BYTES,
  MAX_TOOL_RESULT_SUMMARY_CODE_UNITS,
  MEMELOOP_STRUCTURED_TOOL_KEY,
  ToolResultCanonicalizationError,
  truncateToolSummary,
} from '../structuredToolResult.js';

describe('structuredToolResult', () => {
  it('bounds summaries without splitting Unicode and does not let callers raise the hard limit', () => {
    expect(truncateToolSummary('abc', 10)).toBe('abc');
    expect(truncateToolSummary('1234567890', 10)).toBe('1234567890');
    expect(truncateToolSummary('12345678901', 10)).toBe('1234567...');

    const summary = '😀'.repeat(MAX_TOOL_RESULT_SUMMARY_CODE_UNITS);
    const bounded = truncateToolSummary(summary, Number.MAX_SAFE_INTEGER);
    expect(bounded).toMatch(/\.\.\.$/u);
    expect(bounded.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SUMMARY_CODE_UNITS);
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_SUMMARY_BYTES,
    );
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(bounded)))
      .not.toThrow();
  });

  it('canonicalizes a detached structured payload and validates exact detail references', () => {
    const raw = {
      producerMetadata: 'not persisted',
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: 's',
        detailRef: { type: 'agent-run', conversationId: 'c', nodeId: 'n' },
      },
    };
    const result = canonicalizeToolResult(raw);
    expect(result).toEqual({
      summary: 's',
      detailRef: { type: 'agent-run', conversationId: 'c', nodeId: 'n' },
      isError: false,
    });
    expect(result.detailRef).not.toBe(raw[MEMELOOP_STRUCTURED_TOOL_KEY].detailRef);
  });

  it.each([
    { type: 'agent-run' },
    { type: 'terminal-session', conversationId: 'wrong-field' },
    { type: 'file', fileUri: '' },
    { type: 'file', fileUri: 'memeloop://file', unexpected: true },
    { type: 'other', runId: 'run-1' },
    { type: 'agent-run', runId: 'r', exitCode: 1.5 },
  ])('rejects malformed exact detail reference %#', (detailRef) => {
    expect(() =>
      canonicalizeToolResult({
        [MEMELOOP_STRUCTURED_TOOL_KEY]: { summary: 'safe summary', detailRef },
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_detail_reference' }));
  });

  it('never invokes accessors while rejecting hostile plugin results', () => {
    let getterCalls = 0;
    const rootAccessor = Object.defineProperty({}, 'result', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'secret';
      },
    });
    const nestedAccessor = {
      result: Object.defineProperty({}, 'secret', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 'secret';
        },
      }),
    };
    const detailAccessor = {
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: 'summary',
        detailRef: Object.defineProperty({ type: 'agent-run' }, 'runId', {
          enumerable: true,
          get() {
            getterCalls += 1;
            return 'run-1';
          },
        }),
      },
    };

    for (const value of [rootAccessor, nestedAccessor, detailAccessor]) {
      expect(() => canonicalizeToolResult(value)).toThrow(
        expect.objectContaining({ code: 'unsafe_result' }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it('rejects cycles, dangerous keys, exotic prototypes, excess depth and node counts', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const dangerous = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    });
    let deep: unknown = null;
    for (let index = 0; index < 34; index += 1) deep = [deep];

    for (const value of [cyclic, dangerous, new Date(0)]) {
      expect(() => canonicalizeToolResult(value)).toThrow(
        expect.objectContaining({ code: 'unsafe_result' }),
      );
    }
    for (const value of [deep, Array.from({ length: 4_096 }, () => null)]) {
      expect(() => canonicalizeToolResult(value)).toThrow(
        expect.objectContaining({ code: 'result_too_large' }),
      );
    }
  });

  it('accepts the exact canonical byte maximum and rejects max plus one', () => {
    const exact = 'x'.repeat(MAX_TOOL_RESULT_CANONICAL_BYTES - 2);
    expect(canonicalizeToolResult(exact)).toEqual({ summary: exact, isError: false });
    expect(() => canonicalizeToolResult(`${exact}x`)).toThrow(
      expect.objectContaining({ code: 'result_too_large' }),
    );
  });

  it('keeps normal built-in result envelopes canonical, detached and stable', () => {
    const pluginOwned = { b: 2, a: [true, null] };
    const result = canonicalizeToolResult({ result: pluginOwned });
    expect(result).toEqual({
      summary: '{"a":[true,null],"b":2}',
      payload: { a: [true, null], b: 2 },
      isError: false,
    });
    expect(result.payload).not.toBe(pluginOwned);
    expect(canonicalizeToolResult({ result: 'ok' })).toEqual({ summary: 'ok', isError: false });
    expect(canonicalizeToolResult({ error: 'failed' })).toEqual({ summary: 'failed', isError: true });
    expect(canonicalizeToolResult({ error: { code: 'INTERNAL', message: 'nested failure' } }))
      .toEqual({ summary: 'nested failure', isError: true });
    expect(canonicalizeToolResult(null)).toEqual({ summary: 'null', isError: false });
  });

  it('returns typed errors for malformed structured data and oversized inline results', () => {
    for (const payload of [null, { summary: '' }, { summary: 'x', extra: true }]) {
      expect(() => canonicalizeToolResult({ [MEMELOOP_STRUCTURED_TOOL_KEY]: payload }))
        .toThrow(expect.objectContaining({ code: 'invalid_structured_result' }));
    }
    try {
      canonicalizeToolResult({ result: 'x'.repeat(MAX_TOOL_RESULT_CANONICAL_BYTES) });
      throw new Error('expected canonicalization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolResultCanonicalizationError);
      expect(error).toMatchObject({ code: 'result_too_large' });
    }
  });
});

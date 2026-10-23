import { describe, expect, it } from 'vitest';

import { matchAllToolCallings, matchToolCalling, RESPONSE_PATTERN_LIMITS, TOOL_PARAMETER_PARSE_ERROR_KEY } from '../responsePatternUtility.js';

describe('responsePatternUtility', () => {
  it('matchToolCalling parses tool_use JSON body', () => {
    const text = `Hello <tool_use name="wiki-search">{"q":"foo"}</tool_use> tail`;
    const m = matchToolCalling(text);
    expect(m).toEqual({
      found: true,
      toolId: 'wiki-search',
      parameters: { q: 'foo' },
      originalText: '<tool_use name="wiki-search">{"q":"foo"}</tool_use>',
    });
  });

  it('matchAllToolCallings finds multiple calls and parallel flag', () => {
    const text = `<parallel_tool_calls>
<tool_use name="a">{}</tool_use>
<function_call name="b">{"x":1,}</function_call>
</parallel_tool_calls>`;
    const { calls, parallel } = matchAllToolCallings(text);
    expect(parallel).toBe(true);
    expect(calls.map((c) => c.toolId).sort()).toEqual(['a', 'b']);
  });

  it('preserves a precise parse error instead of disguising malformed JSON as input', () => {
    const match = matchToolCalling(
      '<tool_use name="wiki-operation">{"workspaceName":"wiki","options":"{}}"</tool_use>',
    );
    expect(match.found).toBe(true);
    if (!match.found) return;
    expect(match.parameters).not.toHaveProperty('input');
    expect(match.parameters[TOOL_PARAMETER_PARSE_ERROR_KEY]).toContain(
      'Invalid tool arguments JSON',
    );
  });

  it('accepts an exact Unicode response budget and rejects one byte over', () => {
    const exact = '🙂'.repeat(RESPONSE_PATTERN_LIMITS.maxResponseBytes / 4);
    expect(new TextEncoder().encode(exact).byteLength).toBe(RESPONSE_PATTERN_LIMITS.maxResponseBytes);
    expect(matchAllToolCallings(exact)).toEqual({ calls: [], parallel: false });

    expect(() => matchAllToolCallings(`${exact}a`)).toThrowError(
      expect.objectContaining({
        name: 'ResponsePatternParseError',
        code: 'response_too_large',
      }),
    );
  });

  it('rejects more text calls than the bounded protocol allows', () => {
    const calls = Array.from(
      { length: RESPONSE_PATTERN_LIMITS.maxToolCalls + 1 },
      (_, index) => `<tool_use name="tool-${index}">{}</tool_use>`,
    ).join('');
    expect(() => matchAllToolCallings(calls)).toThrowError(
      expect.objectContaining({
        name: 'ResponsePatternParseError',
        code: 'tool_call_limit',
      }),
    );
  });

  it('rejects an oversized tool argument body before JSON parsing', () => {
    const oversizedBody = `<tool_use name="bounded">${
      'x'.repeat(
        RESPONSE_PATTERN_LIMITS.maxParameterBytes + 1,
      )
    }</tool_use>`;
    expect(() => matchToolCalling(oversizedBody)).toThrowError(
      expect.objectContaining({
        name: 'ResponsePatternParseError',
        code: 'parameters_too_large',
      }),
    );
  });

  it('does not silently swallow invalid runtime input', () => {
    expect(() => {
      Reflect.apply(matchToolCalling, undefined, [null]);
    }).toThrowError(
      expect.objectContaining({
        name: 'ResponsePatternParseError',
        code: 'invalid_response',
      }),
    );
  });
});

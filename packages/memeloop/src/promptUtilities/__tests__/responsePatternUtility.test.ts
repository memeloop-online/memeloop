import { describe, expect, it } from 'vitest';

import { matchAllToolCallings, matchToolCalling, TOOL_PARAMETER_PARSE_ERROR_KEY } from '../responsePatternUtility.js';

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
});

import { describe, expect, it } from 'vitest';

import { extractMemeloopStructuredToolPayload, MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';

describe('structuredToolResult', () => {
  it('truncateToolSummary returns original when within max and truncates otherwise', () => {
    expect(truncateToolSummary('abc', 10)).toBe('abc');
    expect(truncateToolSummary('1234567890', 10)).toBe('1234567890');
    expect(truncateToolSummary('12345678901', 10)).toBe('1234567...');
  });

  it('extractMemeloopStructuredToolPayload validates shape', () => {
    expect(extractMemeloopStructuredToolPayload(null)).toBeNull();
    expect(extractMemeloopStructuredToolPayload('x')).toBeNull();
    expect(extractMemeloopStructuredToolPayload({})).toBeNull();
    expect(extractMemeloopStructuredToolPayload({ [MEMELOOP_STRUCTURED_TOOL_KEY]: null })).toBeNull();
    expect(extractMemeloopStructuredToolPayload({ [MEMELOOP_STRUCTURED_TOOL_KEY]: { summary: '' } })).toBeNull();

    const ok = extractMemeloopStructuredToolPayload({
      [MEMELOOP_STRUCTURED_TOOL_KEY]: { summary: 's', detailRef: { type: 'sub-agent', conversationId: 'c', nodeId: 'n' } },
    });
    expect(ok?.summary).toBe('s');
    expect((ok as any).detailRef.type).toBe('sub-agent');
  });
});

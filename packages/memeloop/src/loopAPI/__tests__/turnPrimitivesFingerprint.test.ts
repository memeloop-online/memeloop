import { describe, expect, it } from 'vitest';

import { fingerprintPluginToolCalls } from '../agent-tool-loop/turnPrimitives.js';

function call(parameters: Record<string, unknown>) {
  return {
    found: true as const,
    toolId: 'search',
    parameters,
    originalText: '<tool_use />',
  };
}

describe('tool-call fingerprint', () => {
  it('is stable across parameter key order and preserves ordered call arrays', async () => {
    await expect(fingerprintPluginToolCalls([
      call({ z: 1, a: 2 }),
    ])).resolves.toBe(
      await fingerprintPluginToolCalls([
        call({ a: 2, z: 1 }),
      ]),
    );
    await expect(fingerprintPluginToolCalls([
      call({ page: 1 }),
      call({ page: 2 }),
    ])).resolves.not.toBe(
      await fingerprintPluginToolCalls([
        call({ page: 2 }),
        call({ page: 1 }),
      ]),
    );
  });

  it('rejects oversized, deep, and non-JSON tool arguments before hashing', async () => {
    await expect(fingerprintPluginToolCalls([
      call({ value: 'x'.repeat(512 * 1_024 + 1) }),
    ])).rejects.toThrow('canonical_json_max_string_code_units');
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    await expect(fingerprintPluginToolCalls([call(deep)]))
      .rejects.toThrow('canonical_json_max_depth');
    await expect(fingerprintPluginToolCalls([call({ value: undefined })]))
      .rejects.toThrow('canonical_json_unsupported_type');
  });

  it('does not let volatile call identity or source text spoof a new call', async () => {
    const first = {
      ...call({ page: 1 }),
      originalText: '<tool_use id="first" />',
      timestamp: 1,
      toolCallId: 'call-first',
    };
    const second = {
      ...call({ page: 1 }),
      originalText: '<tool_use id="second" />',
      timestamp: 2,
      toolCallId: 'call-second',
    };

    await expect(fingerprintPluginToolCalls([first])).resolves.toBe(
      await fingerprintPluginToolCalls([second]),
    );
  });
});

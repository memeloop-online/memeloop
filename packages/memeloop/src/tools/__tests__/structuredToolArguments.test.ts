import { describe, expect, it, vi } from 'vitest';

import {
  canonicalizePreToolUseHookResult,
  canonicalizePreToolUseModification,
  canonicalizeToolArguments,
  canonicalizeToolCallIdentity,
  MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
  ToolArgumentNormalizationError,
} from '../structuredToolArguments.js';

describe('structured tool arguments', () => {
  it('returns a canonical detached record and stable locale-independent digests', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent comparison must not run');
    });
    try {
      const first = canonicalizeToolCallIdentity('lookup', { z: 1, a: ['x', true] });
      const second = canonicalizeToolCallIdentity('lookup', { a: ['x', true], z: 1 });
      expect(first.parameters).toEqual({ a: ['x', true], z: 1 });
      expect(first.canonical).toBe('{"a":["x",true],"z":1}');
      expect(first.digest).toMatch(/^[\da-f]{64}$/u);
      expect(first.callDigest).toBe(second.callDigest);
      expect(first.callDigest).toMatch(/^[\da-f]{64}$/u);
      expect(localeCompare).not.toHaveBeenCalled();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('accepts exact max bytes and rejects max plus one', () => {
    const emptyEnvelopeBytes = new TextEncoder().encode('{"value":""}').byteLength;
    const exact = { value: 'x'.repeat(MAX_TOOL_ARGUMENT_CANONICAL_BYTES - emptyEnvelopeBytes) };
    expect(new TextEncoder().encode(canonicalizeToolArguments(exact).canonical).byteLength).toBe(
      MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
    );
    expect(() => canonicalizeToolArguments({ value: `${exact.value}x` })).toThrow(
      expect.objectContaining({ code: 'result_too_large' }),
    );
  });

  it('never invokes original or hook-modified accessors', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    for (
      const operation of [
        () => canonicalizeToolArguments(accessor),
        () => canonicalizePreToolUseModification({ parameters: accessor }),
        () => canonicalizePreToolUseHookResult({ allowed: true, modified: { parameters: accessor } }),
      ]
    ) {
      expect(operation).toThrow(expect.objectContaining({ code: 'unsafe' }));
    }
    expect(getterCalls).toBe(0);
  });

  it('validates and detaches the complete PreToolUse hook result', () => {
    const source = {
      allowed: true,
      modified: { parameters: { z: 2, a: 1 }, toolId: 'echo' },
      permissionAction: 'ask' as const,
      reason: 'approval required',
    };
    const normalized = canonicalizePreToolUseHookResult(source);
    source.modified.parameters.z = 3;
    expect(normalized).toEqual({
      allowed: true,
      modified: { parameters: { a: 1, z: 2 }, toolId: 'echo' },
      permissionAction: 'ask',
      reason: 'approval required',
    });
  });

  it('rejects cycles, exotic prototypes, dangerous keys, invalid roots and tool ids', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const dangerous = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    });
    for (const value of [cyclic, dangerous, new Date(0)]) {
      expect(() => canonicalizeToolArguments(value)).toThrow(
        expect.objectContaining({ code: 'unsafe' }),
      );
    }
    for (const value of [null, [], 'text']) {
      expect(() => canonicalizeToolArguments(value)).toThrow(
        expect.objectContaining({ code: 'not_object' }),
      );
    }
    for (const toolId of ['', '\ud800', 'x'.repeat(513)]) {
      expect(() => canonicalizeToolCallIdentity(toolId, {})).toThrow(
        expect.objectContaining({ code: 'invalid_tool_id' }),
      );
    }
  });

  it('returns stable typed errors without retaining hostile causes', () => {
    try {
      canonicalizeToolArguments({ value: BigInt(1) });
      throw new Error('expected normalization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolArgumentNormalizationError);
      expect(error).toMatchObject({ code: 'unsafe', message: 'tool_arguments_unsafe' });
      expect(error).not.toHaveProperty('cause');
    }
  });
});

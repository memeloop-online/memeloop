import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { assertPortableLlmRequest, PORTABLE_LLM_REQUEST_LIMITS, type PortableLlmRequest } from '../../llm/request.js';
import { toolSchemaToJsonSchema } from '../schemaRegistry.js';

function requestWithSchema(inputSchema: Record<string, unknown>): PortableLlmRequest {
  return {
    providerId: 'test',
    logicalModelId: 'logical-model',
    wireModelId: 'wire-model',
    apiMode: 'chat-completions',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'foreign-tool', inputSchema } as never],
  };
}

describe('toolSchemaToJsonSchema portable boundary', () => {
  it('deep-normalizes a foreign-realm schema before strict request validation', () => {
    const foreignSchema = runInNewContext(`({
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: {
          type: 'array',
          items: { type: 'object', properties: { enabled: { type: 'boolean' } } }
        }
      },
      required: ['query']
    })`) as Record<string, unknown>;
    expect(Object.getPrototypeOf(foreignSchema)).not.toBe(Object.prototype);

    const normalized = toolSchemaToJsonSchema(foreignSchema);

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    const properties = normalized.properties as Record<string, unknown>;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    const filters = properties.filters as Record<string, unknown>;
    expect(Object.getPrototypeOf(filters)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(filters.items as object)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(normalized.required as object)).toBe(Array.prototype);
    expect(() => {
      assertPortableLlmRequest(requestWithSchema(normalized));
    }).not.toThrow();
  });

  it('rejects cycles, dangerous keys, non-JSON values, and custom prototypes', () => {
    const cycle: Record<string, unknown> = { type: 'object' };
    cycle.self = cycle;
    const polluted = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const nonJson = { type: 'object', properties: { missing: undefined } };
    const nonFinite = { type: 'object', maximum: Number.POSITIVE_INFINITY };
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    customPrototype.type = 'object';

    for (const schema of [cycle, polluted, nonJson, nonFinite, customPrototype]) {
      expect(() => toolSchemaToJsonSchema(schema)).toThrow(TypeError);
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects accessors without invoking them', () => {
    const read = vi.fn(() => ({ type: 'string' }));
    const properties = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: read,
    });

    expect(() => toolSchemaToJsonSchema({ type: 'object', properties })).toThrow(TypeError);
    expect(read).not.toHaveBeenCalled();

    const readMethod = vi.fn(() => () => ({ type: 'object' }));
    const methodAccessor = Object.defineProperty({}, 'toJSONSchema', {
      enumerable: true,
      get: readMethod,
    });
    expect(() => toolSchemaToJsonSchema(methodAccessor)).toThrow(TypeError);
    expect(readMethod).not.toHaveBeenCalled();
  });

  it('fails closed at portable depth and schema-byte bounds', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth <= PORTABLE_LLM_REQUEST_LIMITS.jsonDepth; depth += 1) {
      deep = { type: 'object', properties: { nested: deep } };
    }
    const oversized = {
      type: 'object',
      description: 'x'.repeat(PORTABLE_LLM_REQUEST_LIMITS.schemaBytes),
    };

    expect(() => toolSchemaToJsonSchema(deep)).toThrow(/structure limits/);
    expect(() => toolSchemaToJsonSchema(oversized)).toThrow(/schema limits/);
  });
});

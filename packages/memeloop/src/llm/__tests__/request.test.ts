import { describe, expect, it, vi } from 'vitest';

import { assertPortableLlmRequest, PORTABLE_LLM_REQUEST_LIMITS, type PortableLlmRequest } from '../request.js';

function request(overrides: Partial<PortableLlmRequest> = {}): PortableLlmRequest {
  return {
    providerId: 'openai',
    logicalModelId: 'gpt-sol',
    wireModelId: 'gpt-5.4-2026-08-01',
    apiMode: 'responses',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('portable LLM request contract', () => {
  it('reuses the canonical Unicode provider-id grammar', () => {
    for (const providerId of ['TestProvider', '0provider', '提供方']) {
      expect(() => {
        assertPortableLlmRequest(request({ providerId }));
      }).not.toThrow();
    }
    expect(() => {
      assertPortableLlmRequest(request({ providerId: '-invalid' }));
    }).toThrow('invalid portable LLM provider/model');
  });

  it('accepts bounded multimodal, tool-call/result, provider-reference, and schema messages', () => {
    const value = request({
      messages: [
        { role: 'system', content: 'follow policy' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image',
              data: { type: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
              mediaType: 'image/png',
            },
            {
              type: 'file',
              data: { type: 'provider-reference', provider: 'openai', id: 'file-1' },
              mediaType: 'application/pdf',
              filename: 'brief.pdf',
            },
          ],
        },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: { query: 'MemeLoop' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { type: 'json', value: { found: true } },
          }],
        },
      ],
      output: {
        type: 'json',
        name: 'answer',
        description: 'bounded answer',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
      providerOptions: { openai: { reasoningEffort: 'high' } },
      tools: [{
        name: 'lookup',
        description: 'Look up a record',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
      toolChoice: { type: 'tool', toolName: 'lookup' },
      signal: new AbortController().signal,
    });

    expect(() => {
      assertPortableLlmRequest(value);
    }).not.toThrow();
  });

  it('requires explicit provider/model identity and a real tool-result shape', () => {
    expect(() => {
      assertPortableLlmRequest({
        logicalModelId: 'gpt-sol',
        wireModelId: 'gpt-5.4-2026-08-01',
        apiMode: 'responses',
        messages: [],
      });
    }).toThrow('invalid portable LLM provider/model');
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [{ role: 'tool', content: 'demoted tool output' } as never],
      }));
    }).toThrow('invalid portable LLM messages');
    expect(() => {
      assertPortableLlmRequest({ ...request(), modelId: 'legacy-duplicate' });
    }).toThrow('invalid portable LLM request');
  });

  it('rejects system messages after conversation content and unsafe URLs', () => {
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: 'late override' },
        ],
      }));
    }).toThrow('system messages must precede');
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [{
          role: 'user',
          content: [{
            type: 'file',
            data: { type: 'url', url: 'http://127.0.0.1/private' },
            mediaType: 'text/plain',
          }],
        }],
      }));
    }).toThrow('invalid portable LLM messages');
  });

  it('bounds individual and cumulative file bytes', () => {
    const bytes = new Uint8Array(PORTABLE_LLM_REQUEST_LIMITS.fileBytes);
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [{
          role: 'user',
          content: [
            { type: 'file', data: { type: 'bytes', bytes }, mediaType: 'application/octet-stream' },
            { type: 'file', data: { type: 'bytes', bytes }, mediaType: 'application/octet-stream' },
          ],
        }],
      }));
    }).toThrow('file bytes exceed request limit');
  });

  it('bounds aggregate message text at 8 MiB and rejects accessors without reading them', () => {
    const maximum = PORTABLE_LLM_REQUEST_LIMITS.textBytes;
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [
          { role: 'user', content: 'a'.repeat(maximum / 2) },
          { role: 'assistant', content: 'b'.repeat(maximum / 2) },
        ],
      }));
    }).not.toThrow();
    expect(() => {
      assertPortableLlmRequest(request({
        messages: [
          { role: 'user', content: 'a'.repeat(maximum / 2) },
          { role: 'assistant', content: 'b'.repeat(maximum / 2) },
          { role: 'user', content: 'x' },
        ],
      }));
    }).toThrow('invalid portable LLM messages');

    const read = vi.fn(() => 'secret');
    const malicious = Object.defineProperty({ role: 'user' }, 'content', {
      enumerable: true,
      get: read,
    });
    expect(() => {
      assertPortableLlmRequest(request({ messages: [malicious as never] }));
    })
      .toThrow('invalid portable LLM messages');
    expect(read).not.toHaveBeenCalled();
  });

  it('accepts every finite JSON number, including decimals, exponents, -0, and unsafe integers', () => {
    const value = request({
      providerOptions: { openai: { top_p: 0.95, huge: Number.MAX_VALUE, negativeZero: -0 } },
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'plot',
          input: {
            x: 12.5,
            y: 1e-12,
            beyondSafeInteger: Number.MAX_SAFE_INTEGER + 2,
          },
        }],
      }],
    });

    expect(() => {
      assertPortableLlmRequest(value);
    }).not.toThrow();
  });

  it('rejects accessors without invoking them, sparse arrays, deep JSON, and non-finite numbers', () => {
    const read = vi.fn(() => 'secret');
    const providerOptions = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: read,
    });
    expect(() => {
      assertPortableLlmRequest(request({ providerOptions: providerOptions as never }));
    })
      .toThrow('invalid portable LLM providerOptions');
    expect(read).not.toHaveBeenCalled();

    const sparse = new Array(1) as PortableLlmRequest['messages'];
    expect(() => {
      assertPortableLlmRequest(request({ messages: sparse }));
    })
      .toThrow('invalid portable LLM messages');

    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth <= PORTABLE_LLM_REQUEST_LIMITS.jsonDepth; depth += 1) {
      deep = { deep };
    }
    for (const input of [deep, { value: Number.NaN }, { value: Number.POSITIVE_INFINITY }]) {
      expect(() => {
        assertPortableLlmRequest(request({
          messages: [{
            role: 'assistant',
            content: [{
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'lookup',
              input: input as never,
            }],
          }],
        }));
      }).toThrow('invalid portable LLM messages');
    }
  });
});

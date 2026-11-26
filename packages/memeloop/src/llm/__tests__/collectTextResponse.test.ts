import { describe, expect, it } from 'vitest';

import { collectPortableLlmTextResponse } from '../collectTextResponse.js';
import type { PortableLlmStreamPart } from '../response.js';

describe('collectPortableLlmTextResponse', () => {
  it('collects a bounded portable text stream', async () => {
    async function* stream(): AsyncGenerator<PortableLlmStreamPart> {
      yield { type: 'text-delta', id: 'text-1', text: 'hello ' };
      yield { type: 'reasoning-delta', id: 'reasoning-1', text: 'private' };
      yield { type: 'text-delta', id: 'text-1', text: 'world' };
      yield { type: 'finish', finishReason: 'stop' };
    }

    await expect(collectPortableLlmTextResponse(stream())).resolves.toBe('hello world');
  });

  it('rejects a truncated stream', async () => {
    async function* stream(): AsyncGenerator<PortableLlmStreamPart> {
      yield { type: 'text-delta', id: 'text-1', text: 'partial' };
    }

    await expect(collectPortableLlmTextResponse(stream())).rejects.toMatchObject({
      code: 'LLM_STREAM_TRUNCATED',
    });
  });

  it('honours external cancellation while consuming', async () => {
    const controller = new AbortController();
    async function* stream(): AsyncGenerator<PortableLlmStreamPart> {
      yield { type: 'text-delta', id: 'text-1', text: 'partial' };
      controller.abort(new Error('cancelled'));
      yield { type: 'finish', finishReason: 'stop' };
    }

    await expect(collectPortableLlmTextResponse(stream(), controller.signal)).rejects.toThrow('cancelled');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { PortableLlmRequest } from '../../llm/request.js';
import type { PortableLlmStreamPart } from '../../llm/response.js';
import { streamLlm } from '../agent-tool-loop/llmStream.js';

function request(signal: AbortSignal): PortableLlmRequest {
  return {
    providerId: 'test',
    logicalModelId: 'model-alias',
    wireModelId: 'model',
    apiMode: 'chat-completions',
    messages: [{ role: 'user', content: 'hello' }],
    signal,
  };
}

describe('streamLlm cancellation', () => {
  it('settles signal abort while provider next and return both remain pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const return_ = vi.fn(() => new Promise<IteratorResult<PortableLlmStreamPart>>(() => {}));
    const provider = {
      name: 'test',
      chat: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<PortableLlmStreamPart>>(() => {}),
            return: return_,
          };
        },
      }),
    };
    const iterator = streamLlm(provider, request(controller.signal));
    const pending = iterator.next();
    const outcome = Promise.race([
      pending.then(
        () => 'unexpected-resolution',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>(resolve => {
        setTimeout(() => {
          resolve('did-not-settle');
        }, 1);
      }),
    ]);

    controller.abort(new Error('cancelled-by-test'));
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBe('cancelled-by-test');
    expect(return_).toHaveBeenCalledTimes(1);
    await iterator.return();
    expect(return_).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([
    ['synchronous throw', () => {
      throw new Error('close sync failure');
    }],
    ['asynchronous rejection', () => Promise.reject(new Error('close async failure'))],
  ])('absorbs a provider return %s without changing abort outcome', async (_label, return_) => {
    const controller = new AbortController();
    const close = vi.fn(return_);
    const provider = {
      name: 'test',
      chat: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<PortableLlmStreamPart>>(() => {}),
            return: close,
          };
        },
      }),
    };
    const iterator = streamLlm(provider, request(controller.signal));
    const pending = iterator.next();
    controller.abort(new Error('abort-wins'));

    await expect(pending).rejects.toThrow('abort-wins');
    // Let a rejected cleanup promise reach the host rejection checkpoint. The
    // suite would fail on an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('best-effort closes exactly once when the stream consumer returns early', async () => {
    const return_ = vi.fn(() => Promise.reject(new Error('consumer close failure')));
    let emitted = false;
    const provider = {
      name: 'test',
      chat: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (emitted) return new Promise<IteratorResult<PortableLlmStreamPart>>(() => {});
              emitted = true;
              return {
                done: false as const,
                value: { type: 'text-delta' as const, id: 'text', text: 'first' },
              };
            },
            return: return_,
          };
        },
      }),
    };
    const iterator = streamLlm(provider, request(new AbortController().signal));

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text-delta', text: 'first' },
    });
    await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
    await iterator.return();
    await Promise.resolve();
    expect(return_).toHaveBeenCalledTimes(1);
  });

  it('does not call return after normal provider exhaustion', async () => {
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
                value: { type: 'finish' as const, finishReason: 'stop' },
              };
            },
            return: return_,
          };
        },
      }),
    };
    const iterator = streamLlm(provider, request(new AbortController().signal));

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'finish', finishReason: 'stop' },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(return_).not.toHaveBeenCalled();
  });
});

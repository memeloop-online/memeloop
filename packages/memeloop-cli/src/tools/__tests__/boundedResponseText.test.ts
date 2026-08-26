import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundedResponseTextError, fetchBoundedText, readBoundedResponseText } from '../boundedResponseText.js';

const encoder = new TextEncoder();

function chunkedResponse(chunks: Uint8Array[], headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers },
  );
}

describe('bounded response text', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('decodes exact-max Unicode split across chunks', async () => {
    const bytes = encoder.encode('A你🙂');
    const response = chunkedResponse([...bytes].map(byte => Uint8Array.of(byte)));

    await expect(readBoundedResponseText(response, bytes.byteLength)).resolves.toBe('A你🙂');
  });

  it('rejects chunked max+1 before decoding the excess body', async () => {
    const response = chunkedResponse([encoder.encode('1234'), encoder.encode('5')]);

    await expect(readBoundedResponseText(response, 4)).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });

  it('rejects an oversized content-length without acquiring a reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const response = {
      body,
      headers: new Headers({ 'content-length': '9' }),
    } as Response;

    await expect(readBoundedResponseText(response, 8)).rejects.toEqual(
      new BoundedResponseTextError('response_too_large'),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed UTF-8', async () => {
    const response = chunkedResponse([Uint8Array.of(0xC3, 0x28)]);

    await expect(readBoundedResponseText(response, 2)).rejects.toMatchObject({
      code: 'response_invalid_utf8',
    });
  });

  it('treats a Fetch response with no body as bounded empty text', async () => {
    const response = new Response(null, { status: 204 });

    await expect(readBoundedResponseText(response, 1)).resolves.toBe('');
  });

  it('keeps the timeout active while a slow body is being read and cancels it', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const reading = fetchBoundedText('https://example.invalid', {}, {
      maximumBytes: 32,
      timeoutMs: 100,
    });
    const outcome = expect(reading).rejects.toMatchObject({ code: 'response_timeout' });
    await vi.advanceTimersByTimeAsync(100);

    await outcome;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('propagates an external abort and cancels a pending body read', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const controller = new AbortController();
    const reason = new Error('caller-stopped');

    const reading = fetchBoundedText('https://example.invalid', {
      signal: controller.signal,
    }, {
      maximumBytes: 32,
      timeoutMs: 1_000,
    });
    const outcome = expect(reading).rejects.toBe(reason);
    controller.abort(reason);

    await outcome;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

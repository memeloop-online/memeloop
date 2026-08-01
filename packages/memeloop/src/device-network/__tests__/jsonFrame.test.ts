import { describe, expect, it, vi } from 'vitest';

import { createJsonFrameReader, encodeJsonFrame, encodeJsonFrames, JsonFrameError } from '../jsonFrame.js';

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function* chunks(values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

function reader(source: AsyncIterable<Uint8Array>, overrides: Partial<{
  maxPayloadBytes: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  signal: AbortSignal;
  abort: (error: JsonFrameError) => void;
}> = {}): AsyncIterable<unknown> {
  return createJsonFrameReader(source, {
    maxPayloadBytes: 1024,
    idleTimeoutMs: 100,
    totalTimeoutMs: 500,
    ...overrides,
  });
}

function join(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((size, value) => size + value.byteLength, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

describe('JSON framing v2', () => {
  it('round-trips Unicode when every byte is delivered separately', async () => {
    const value = { text: '镜中世界 🪞', nested: ['こんにちは', true] };
    const frame = encodeJsonFrame(value);
    expect(await collect(reader(chunks([...frame].map((byte) => Uint8Array.of(byte)))))).toEqual([
      value,
    ]);
  });

  it('retains header and payload remainder across arbitrary chunk boundaries', async () => {
    const frame = encodeJsonFrame({ ok: true, count: 42 });
    expect(
      await collect(reader(chunks([
        frame.slice(0, 2),
        frame.slice(2, 7),
        frame.slice(7),
      ]))),
    ).toEqual([{ ok: true, count: 42 }]);
  });

  it('decodes multiple frames coalesced in the same chunk', async () => {
    const frames = [encodeJsonFrame(1), encodeJsonFrame({ two: 2 }), encodeJsonFrame('三')];
    expect(await collect(reader(chunks([join(...frames)])))).toEqual([1, { two: 2 }, '三']);
  });

  it('encodes an iterable of frames', async () => {
    const encoded = await collect(encodeJsonFrames([{ one: 1 }, { two: 2 }], 32));
    expect(encoded).toHaveLength(2);
    expect(await collect(reader(chunks(encoded as Uint8Array[])))).toEqual([
      { one: 1 },
      { two: 2 },
    ]);
  });

  it('accepts an exact maximum payload and rejects max + 1', async () => {
    const exact = encodeJsonFrame('1234', 6);
    expect(await collect(reader(chunks([exact]), { maxPayloadBytes: 6 }))).toEqual(['1234']);
    expect(() => encodeJsonFrame('12345', 6)).toThrowError(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    );
  });

  it('rejects an announced payload larger than the configured maximum before reading it', async () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 1025, false);
    await expect(collect(reader(chunks([header])))).rejects.toMatchObject({
      code: 'FRAME_TOO_LARGE',
    });
  });

  it.each([
    ['zero-length payload', Uint8Array.of(0, 0, 0, 0), 'INVALID_JSON'],
    ['truncated header', Uint8Array.of(0, 0), 'TRUNCATED_FRAME'],
    ['truncated payload', Uint8Array.of(0, 0, 0, 3, 0x7b), 'TRUNCATED_FRAME'],
    ['invalid UTF-8', Uint8Array.of(0, 0, 0, 2, 0xc3, 0x28), 'INVALID_UTF8'],
    ['invalid JSON', Uint8Array.of(0, 0, 0, 1, 0x7b), 'INVALID_JSON'],
  ])('rejects %s with a stable error code', async (_name, frame, code) => {
    await expect(collect(reader(chunks([frame])))).rejects.toMatchObject({ code });
  });

  it('does not let empty chunks refresh the idle deadline', async () => {
    async function* emptySlowloris(): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(0);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        yield new Uint8Array(0);
      }
    }
    await expect(collect(reader(emptySlowloris(), {
      idleTimeoutMs: 25,
      totalTimeoutMs: 200,
    }))).rejects.toMatchObject({ code: 'IDLE_TIMEOUT' });
  });

  it('enforces a total frame deadline against a byte-at-a-time slowloris', async () => {
    const frame = encodeJsonFrame({ slow: true });
    async function* slowBytes(): AsyncIterable<Uint8Array> {
      for (const byte of frame) {
        yield Uint8Array.of(byte);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }
    await expect(collect(reader(slowBytes(), {
      idleTimeoutMs: 30,
      totalTimeoutMs: 35,
    }))).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
  });

  it('maps external cancellation to ABORTED', async () => {
    const controller = new AbortController();
    async function* stalled(): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(0);
      await new Promise(() => undefined);
    }
    setTimeout(() => {
      controller.abort(new Error('cancelled by caller'));
    }, 10);
    await expect(collect(reader(stalled(), {
      signal: controller.signal,
      idleTimeoutMs: 100,
    }))).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('aborts the underlying stream exactly once for a framing failure', async () => {
    const abort = vi.fn();
    await expect(collect(reader(chunks([Uint8Array.of(0, 0, 0, 1, 0x7b)]), {
      abort,
    }))).rejects.toBeInstanceOf(JsonFrameError);
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_JSON' }));
  });
});

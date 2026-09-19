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

  it('copies only a linear number of bytes for byte-at-a-time input', async () => {
    const value = { text: 'x'.repeat(64 * 1024) };
    const frame = encodeJsonFrame(value);
    const originalSet = Uint8Array.prototype.set;
    let copiedBytes = 0;
    const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function(
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ): void {
      copiedBytes += source.length;
      originalSet.call(this, source, offset);
    });
    try {
      expect(
        await collect(reader(
          chunks([...frame].map((byte) => Uint8Array.of(byte))),
          {
            maxPayloadBytes: frame.byteLength,
            // This is a structural copy-complexity assertion, not a transport
            // deadline assertion. A full-suite worker can legitimately need
            // more than the reader helper's 500 ms default to schedule 65k
            // iterator pulls plus spies. Keep a finite budget below Vitest's
            // timeout while the dedicated slowloris test below exercises the
            // production total-deadline behavior with a tight budget.
            idleTimeoutMs: 5_000,
            totalTimeoutMs: 15_000,
          },
        )),
      ).toEqual([value]);
      // Header and payload bytes are each copied into their final allocation
      // once. This operation-count assertion detects the former O(n²)
      // repeated-concatenation implementation without relying on wall time.
      expect(copiedBytes).toBe(frame.byteLength);
    } finally {
      setSpy.mockRestore();
    }
  }, 20_000);

  it('decodes an exact 16 MiB payload using bounded chunk storage', async () => {
    const maxPayloadBytes = 16 * 1024 * 1024;
    const value = 'x'.repeat(maxPayloadBytes - 2);
    const frame = encodeJsonFrame(value, maxPayloadBytes);
    const frameChunks: Uint8Array[] = [];
    for (let offset = 0; offset < frame.byteLength; offset += 64 * 1024) {
      frameChunks.push(frame.subarray(offset, offset + 64 * 1024));
    }
    expect(
      await collect(reader(chunks(frameChunks), {
        maxPayloadBytes,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 20_000,
      })),
    ).toEqual([value]);
  }, 30_000);

  it('does not retain aliased chunks reused by the producer', async () => {
    const frame = encodeJsonFrame({ text: 'producer-owned reusable buffer 🪞' });
    async function* reusedBuffer(): AsyncIterable<Uint8Array> {
      const reusable = new Uint8Array(7);
      for (let offset = 0; offset < frame.byteLength; offset += reusable.byteLength) {
        const length = Math.min(reusable.byteLength, frame.byteLength - offset);
        reusable.fill(0);
        reusable.set(frame.subarray(offset, offset + length));
        yield reusable.subarray(0, length);
      }
    }
    await expect(collect(reader(reusedBuffer()))).resolves.toEqual([
      { text: 'producer-owned reusable buffer 🪞' },
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
    const abort = vi.fn();
    new DataView(header.buffer).setUint32(0, 1025, false);
    await expect(collect(reader(chunks([header]), { abort }))).rejects.toMatchObject({
      code: 'FRAME_TOO_LARGE',
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }));
  });

  it.each([
    ['zero-length payload', Uint8Array.of(0, 0, 0, 0), 'INVALID_JSON'],
    ['truncated header', Uint8Array.of(0, 0), 'TRUNCATED_FRAME'],
    ['truncated payload', Uint8Array.of(0, 0, 0, 3, 0x7b), 'TRUNCATED_FRAME'],
    ['invalid UTF-8', Uint8Array.of(0, 0, 0, 2, 0xc3, 0x28), 'INVALID_UTF8'],
    ['invalid JSON', Uint8Array.of(0, 0, 0, 1, 0x7b), 'INVALID_JSON'],
  ])('rejects %s with a stable error code', async (_name, frame, code) => {
    const abort = vi.fn();
    await expect(collect(reader(chunks([frame]), { abort }))).rejects.toMatchObject({ code });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it('does not let empty chunks refresh the idle deadline', async () => {
    const abort = vi.fn();
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
      abort,
    }))).rejects.toMatchObject({ code: 'IDLE_TIMEOUT' });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'IDLE_TIMEOUT' }));
  });

  it('does not count consumer backpressure as source idle time', async () => {
    const iterator = reader(
      chunks([
        encodeJsonFrame({ first: true }),
        encodeJsonFrame({ second: true }),
      ]),
      { idleTimeoutMs: 10 },
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { first: true } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { second: true } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('does not count consumer backpressure against a coalesced partial next frame', async () => {
    const first = encodeJsonFrame({ first: true });
    const second = encodeJsonFrame({ second: true });
    const iterator = reader(
      chunks([
        join(first, second.slice(0, 5)),
        second.slice(5),
      ]),
      {
        idleTimeoutMs: 50,
        totalTimeoutMs: 10,
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { first: true } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { second: true } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('enforces a total frame deadline against a byte-at-a-time slowloris', async () => {
    const frame = encodeJsonFrame({ slow: true });
    const abort = vi.fn();
    async function* slowBytes(): AsyncIterable<Uint8Array> {
      for (const byte of frame) {
        yield Uint8Array.of(byte);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }
    await expect(collect(reader(slowBytes(), {
      idleTimeoutMs: 30,
      totalTimeoutMs: 35,
      abort,
    }))).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOTAL_TIMEOUT' }));
  });

  it('gives total timeout stable priority when idle and total deadlines tie', async () => {
    const abort = vi.fn();
    async function* stalledAtExactTie(): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(0);
      await new Promise(() => undefined);
    }

    await expect(collect(reader(stalledAtExactTie(), {
      idleTimeoutMs: 20,
      totalTimeoutMs: 20,
      abort,
    }))).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOTAL_TIMEOUT' }));
  });

  it('re-arms an early timer without changing the preselected timeout type', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const abort = vi.fn();
    let notifySecondPull!: () => void;
    const secondPull = new Promise<void>((resolve) => {
      notifySecondPull = resolve;
    });
    let pullCount = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            pullCount += 1;
            if (pullCount === 1) {
              return Promise.resolve({ done: false as const, value: Uint8Array.of(0) });
            }
            notifySecondPull();
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
        };
      },
    };

    try {
      const outcome = collect(reader(source, {
        idleTimeoutMs: 20,
        totalTimeoutMs: 20,
        abort,
      }));
      const rejection = expect(outcome).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
      await secondPull;

      // Simulate the real Node behavior that exposed this regression: the
      // selected timer callback runs while the wall clock is still 1 ms shy
      // of its absolute deadline. The reader must re-arm, not report idle.
      const nowSpy = vi.spyOn(Date, 'now')
        .mockReturnValueOnce(1_019)
        .mockReturnValue(1_020);
      await vi.advanceTimersByTimeAsync(20);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(abort).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOTAL_TIMEOUT' }));
      nowSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('maps external cancellation to ABORTED', async () => {
    const controller = new AbortController();
    const abort = vi.fn();
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
      abort,
    }))).rejects.toMatchObject({ code: 'ABORTED' });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts immediately while paused at a yielded frame and does not yield buffered frames', async () => {
    const controller = new AbortController();
    const abort = vi.fn();
    const source = chunks([join(encodeJsonFrame({ first: true }), encodeJsonFrame({ second: true }))]);
    const iterator = reader(source, { signal: controller.signal, abort })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { first: true } });

    controller.abort(new Error('cancelled while consumer handled the first value'));
    expect(abort).toHaveBeenCalledOnce();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED' });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts the underlying stream exactly once for a framing failure', async () => {
    const abort = vi.fn();
    await expect(collect(reader(chunks([Uint8Array.of(0, 0, 0, 1, 0x7b)]), {
      abort,
    }))).rejects.toBeInstanceOf(JsonFrameError);
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_JSON' }));
  });

  it('does not wait for an abort callback that never settles', async () => {
    const abort = vi.fn(() => new Promise<void>(() => undefined));
    const outcome = await Promise.race([
      collect(reader(chunks([Uint8Array.of(0, 0, 0, 1, 0x7b)]), { abort })).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'hung'>((resolve) =>
        setTimeout(() => {
          resolve('hung');
        }, 100)
      ),
    ]);
    expect(outcome).toMatchObject({ code: 'INVALID_JSON' });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts promptly when the consumer returns early without awaiting source cleanup', async () => {
    const abort = vi.fn();
    const frame = encodeJsonFrame({ first: true });
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          next: async () => {
            if (!yielded) {
              yielded = true;
              return { done: false as const, value: frame };
            }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        };
      },
    };
    const iterator = reader(source, { abort })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { first: true } });
    const returned = await Promise.race([
      iterator.return?.(),
      new Promise<'hung'>((resolve) =>
        setTimeout(() => {
          resolve('hung');
        }, 100)
      ),
    ]);
    expect(returned).not.toBe('hung');
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABORTED' }));
  });
});

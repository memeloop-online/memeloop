import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsParallel, executeToolCallsSequential, type ToolCallEntry } from '../parallelExecution.js';

function call(toolId: string): ToolCallEntry['call'] {
  return {
    found: true,
    toolId,
    parameters: {},
    originalText: '',
  };
}

describe('executeToolCallsParallel', () => {
  it('returns [] for empty entries', async () => {
    expect(await executeToolCallsParallel([])).toEqual([]);
  });

  it('runs single entry', async () => {
    const r = await executeToolCallsParallel([
      {
        call: call('a'),
        executor: async () => ({ success: true, content: 'ok' }),
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('fulfilled');
    expect(r[0].result).toEqual({ success: true, content: 'ok' });
  });

  it('runs two in parallel', async () => {
    const r = await executeToolCallsParallel([
      { call: call('x'), executor: async () => ({ success: true, content: '1' }) },
      { call: call('y'), executor: async () => ({ success: true, content: '2' }) },
    ]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
  });

  it('handles rejection', async () => {
    const r = await executeToolCallsParallel([
      {
        call: call('z'),
        executor: async () => {
          throw new Error('boom');
        },
      },
    ]);
    expect(r[0].status).toBe('rejected');
    expect(r[0].error).toBe('boom');
  });

  it('times out slow tool', async () => {
    vi.useFakeTimers();
    const p = executeToolCallsParallel(
      [
        {
          call: call('slow'),
          executor: async () => {
            await new Promise<void>((res) => {
              setTimeout(res, 99_999);
            });
            return { success: true, content: 'never' };
          },
          timeoutMs: 100,
        },
      ],
      0,
    );
    await vi.advanceTimersByTimeAsync(150);
    const r = await p;
    vi.useRealTimers();
    expect(r[0].status).toBe('timeout');
    expect(r[0].error).toContain('slow');
  });

  it('batch timeout when multiple entries hang', async () => {
    vi.useFakeTimers();
    const p = executeToolCallsParallel(
      [
        { call: call('a'), executor: () => new Promise(() => {}) },
        { call: call('b'), executor: () => new Promise(() => {}) },
      ],
      50,
    );
    await vi.advanceTimersByTimeAsync(60);
    const r = await p;
    vi.useRealTimers();
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.status === 'timeout')).toBe(true);
    expect(r[0].error).toContain('Batch timeout');
  });

  it('aborts every outstanding executor when the batch deadline wins', async () => {
    vi.useFakeTimers();
    const observed: AbortSignal[] = [];
    const p = executeToolCallsParallel(
      ['a', 'b'].map(toolId => ({
        call: call(toolId),
        executor: (_parameters: Record<string, unknown>, signal: AbortSignal) => {
          observed.push(signal);
          return new Promise(() => {});
        },
      })),
      50,
    );

    await vi.advanceTimersByTimeAsync(60);
    await p;
    vi.useRealTimers();

    expect(observed).toHaveLength(2);
    expect(observed.every(signal => signal.aborted)).toBe(true);
  });

  it('propagates external cancellation to every outstanding executor', async () => {
    const controller = new AbortController();
    const observed: AbortSignal[] = [];
    const pending = executeToolCallsParallel(
      ['a', 'b'].map(toolId => ({
        call: call(toolId),
        executor: (_parameters: Record<string, unknown>, signal: AbortSignal) => {
          observed.push(signal);
          return new Promise(() => {});
        },
      })),
      0,
      controller.signal,
    );

    controller.abort(new Error('turn-cancelled'));

    const results = await pending;
    expect(observed).toHaveLength(2);
    expect(observed.every(signal => signal.aborted)).toBe(true);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(results.every(result => result.error === 'turn-cancelled')).toBe(true);
  });

  it('batchTimeoutMs 0 skips batch race', async () => {
    const r = await executeToolCallsParallel(
      [
        { call: call('a'), executor: async () => ({ success: true, content: 'a' }) },
        { call: call('b'), executor: async () => ({ success: true, content: 'b' }) },
      ],
      0,
    );
    expect(r).toHaveLength(2);
    expect(r[0].status).toBe('fulfilled');
    expect(r[1].status).toBe('fulfilled');
  });

  it('timeoutMs 0 disables per-tool timer', async () => {
    const r = await executeToolCallsParallel([
      {
        call: call('fast'),
        executor: async () => ({ success: true, content: 'x' }),
        timeoutMs: 0,
      },
    ]);
    expect(r[0].status).toBe('fulfilled');
  });
});

describe('executeToolCallsSequential', () => {
  it('runs in order', async () => {
    const order: string[] = [];
    await executeToolCallsSequential([
      {
        call: call('1'),
        executor: async () => {
          order.push('1');
          return { success: true, content: 'a' };
        },
      },
      {
        call: call('2'),
        executor: async () => {
          order.push('2');
          return { success: true, content: 'b' };
        },
      },
    ]);
    expect(order).toEqual(['1', '2']);
  });
});

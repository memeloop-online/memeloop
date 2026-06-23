import { MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION } from 'memeloop';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createThrottledTerminalOutputNotify } from '../throttleOutputNotify.js';

describe('createThrottledTerminalOutputNotify', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches multiple chunks into one notify after interval', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const t = createThrottledTerminalOutputNotify(notify, 1000);
    t.push({
      sessionId: 's',
      seq: 1,
      stream: 'stdout',
      data: 'a',
      ts: 1,
    });
    t.push({
      sessionId: 's',
      seq: 2,
      stream: 'stdout',
      data: 'b',
      ts: 2,
    });
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe(MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION);
    const payload = notify.mock.calls[0]?.[1] as { merged?: boolean; chunks?: unknown[] };
    expect(payload.merged).toBe(true);
    expect(payload.chunks).toHaveLength(2);
  });

  it('flush sends immediately', () => {
    const notify = vi.fn();
    const t = createThrottledTerminalOutputNotify(notify, 60_000);
    t.push({ sessionId: 's', seq: 1, stream: 'stderr', data: 'x', ts: 1 });
    t.flush();
    expect(notify).toHaveBeenCalledWith(
      MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION,
      expect.objectContaining({ sessionId: 's' }),
    );
  });
});

import { MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION } from 'memeloop';

import type { TerminalOutputChunk } from './types.js';

export interface ThrottledTerminalNotify {
  push: (chunk: TerminalOutputChunk) => void;
  /** 立即推送积压并停止定时器（会话结束时应调用）。 */
  flush: () => void;
}

/**
 * 计划 §16.4：终端输出 WS 通知按固定间隔合并，避免刷屏（默认 1s）。
 */
export function createThrottledTerminalOutputNotify(
  notify: (method: string, parameters: unknown) => void,
  intervalMs = 1000,
): ThrottledTerminalNotify {
  let pending: TerminalOutputChunk[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (batch.length === 1) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      notify(MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION, batch[0]);
      return;
    }
    const first = batch[0];
    const last = batch[batch.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    notify(MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION, {
      sessionId: first.sessionId,
      chunks: batch,
      merged: true as const,
      seq: last.seq,
      ts: last.ts,
    });
  };

  return {
    push(chunk: TerminalOutputChunk): void {
      pending.push(chunk);
      if (!timer) {
        timer = setTimeout(flush, intervalMs);
      }
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },
  };
}

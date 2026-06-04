import { describe, expect, it, vi } from 'vitest';

import { streamRuntimeAgentReplyToIm } from '../streamAgentReplyToIm.js';
import { TextMessageRenderer } from '../textRenderer.js';

describe('streamRuntimeAgentReplyToIm', () => {
  it('flushes buffered assistant text then sends askQuestion line on ask-question tool step', async () => {
    const flushed: string[] = [];
    const runtime = {
      subscribeToUpdates: vi.fn((_cid: string, cb: (u: unknown) => void) => {
        queueMicrotask(() => {
          cb({ type: 'agent-step', step: { type: 'message', data: { content: 'hello ' } } });
        });
        queueMicrotask(() => {
          cb({
            type: 'agent-step',
            step: {
              type: 'tool',
              data: {
                toolId: 'ask-question',
                parameters: { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
              },
            },
          });
        });
        queueMicrotask(() => {
          cb({ type: 'agent-done' });
        });
        return () => {};
      }),
    };

    await streamRuntimeAgentReplyToIm({
      runtime: runtime as any,
      conversationId: 'c1',
      platform: 'telegram',
      renderer: new TextMessageRenderer(),
      flush: async (t) => {
        flushed.push(t);
      },
    });

    expect(flushed.length).toBeGreaterThanOrEqual(1);
    const joined = flushed.join('');
    expect(joined).toContain('hello');
    expect(joined).toContain('Pick one');
    expect(joined).toContain('1. A');
  });

  it('splits long assistant stream into multiple flushes at Telegram 4096 cap (§20.6.1)', async () => {
    const flushed: string[] = [];
    const longPiece = 'x'.repeat(5000);
    const runtime = {
      subscribeToUpdates: vi.fn((_cid: string, cb: (u: unknown) => void) => {
        queueMicrotask(() => {
          cb({ type: 'agent-step', step: { type: 'message', data: { content: longPiece } } });
        });
        queueMicrotask(() => {
          cb({ type: 'agent-done' });
        });
        return () => {};
      }),
    };

    await streamRuntimeAgentReplyToIm({
      runtime: runtime as any,
      conversationId: 'c1',
      platform: 'telegram',
      renderer: new TextMessageRenderer(),
      flush: async (t) => {
        flushed.push(t);
      },
    });

    expect(flushed.length).toBeGreaterThanOrEqual(2);
    expect(flushed.every((s) => s.length <= 4096)).toBe(true);
    expect(flushed.join('')).toBe(longPiece);
  });
});

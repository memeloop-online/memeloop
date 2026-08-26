import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAgentRunLogDetailLoader, MEMELOOP_MESSAGE_DETAIL_LIMIT, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES, validateMessageDetailPage } from '../chat/messageDetail.js';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';

function message(messageId: string): ChatMessage {
  return {
    messageId,
    turnId: messageId,
    conversationId: 'conversation',
    originNodeId: 'node',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'assistant',
    content: 'bounded summary',
    detailRef: { type: 'agent-run', conversationId: 'conversation', nodeId: 'node' },
  };
}

function exportOnlyMessage(messageId: string, capability: 'detail' | 'export' = 'export'): ChatMessage {
  return {
    ...message(messageId),
    detailRef: undefined,
    metadata: {
      displayTruncation: {
        truncated: true,
        originalCharacterCount: 100_000,
        originalEstimatedBytes: 100_000,
        originalEstimatedRenderRows: 1_000,
        contentTruncated: true,
        omittedFields: [],
        capability,
      },
    },
  };
}

describe('bounded message detail', () => {
  it('adapts exactly one bounded agent-run pull without following continuation cursors', async () => {
    const pull = vi.fn().mockResolvedValue({
      items: [{ label: 'tool', content: 'first page' }],
      truncated: true,
      nextCursor: 'opaque-next',
    });
    const loader = createAgentRunLogDetailLoader({ pull });
    const controller = new AbortController();
    const result = await loader(message('run'), {
      limit: MEMELOOP_MESSAGE_DETAIL_LIMIT,
      maxBytes: MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
      signal: controller.signal,
    });
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      maxBytes: 256 * 1024,
      message: expect.objectContaining({ messageId: 'run' }),
      signal: controller.signal,
    }));
    expect(result).toEqual({ text: 'tool: first page', itemCount: 1, truncated: true, nextCursor: 'opaque-next' });
  });

  it('accepts an exact canonical JSON byte budget and rejects max+1 and 16 MiB payloads', () => {
    const base = { text: '', itemCount: 1, truncated: true, nextCursor: 'next' };
    let low = 1;
    let high = MEMELOOP_MESSAGE_DETAIL_MAX_BYTES;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      try {
        validateMessageDetailPage({ ...base, text: 'x'.repeat(middle) });
        low = middle;
      } catch {
        high = middle - 1;
      }
    }
    expect(() => validateMessageDetailPage({ ...base, text: 'x'.repeat(low) })).not.toThrow();
    expect(() => validateMessageDetailPage({ ...base, text: 'x'.repeat(low + 1) })).toThrow(RangeError);
    expect(() => validateMessageDetailPage({ ...base, text: 'x'.repeat(16 * 1024 * 1024) })).toThrow(RangeError);
  });

  it('rejects accessors and unpaired surrogates without invoking them', () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { itemCount: 1, truncated: false };
    Object.defineProperty(hostile, 'text', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'secret';
      },
    });
    expect(() => validateMessageDetailPage(hostile)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    expect(() => validateMessageDetailPage({ text: '\uD800', itemCount: 1, truncated: false })).toThrow(TypeError);
  });

  it('aborts a stale request and ignores its result after switching messages', async () => {
    let resolveOld!: (value: { text: string; itemCount: number; truncated: false }) => void;
    let resolveNew!: (value: { text: string; itemCount: number; truncated: false }) => void;
    const signals: AbortSignal[] = [];
    const loadMessageDetail = vi.fn((current: ChatMessage, request: { signal: AbortSignal }) => {
      signals.push(request.signal);
      return new Promise<{ text: string; itemCount: number; truncated: false }>(resolve => {
        if (current.messageId === 'old') resolveOld = resolve;
        else resolveNew = resolve;
      });
    });
    const { rerender, unmount } = render(<MemeLoopMessage message={message('old')} loadMessageDetail={loadMessageDetail} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(1);
    });

    rerender(<MemeLoopMessage message={message('new')} loadMessageDetail={loadMessageDetail} />);
    await waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
    resolveOld({ text: 'stale secret', itemCount: 1, truncated: false });
    expect(screen.queryByText('stale secret')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(2);
    });
    resolveNew({ text: 'fresh detail', itemCount: 1, truncated: false });
    expect(await screen.findByText('fresh detail')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reload details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(3);
    });
    unmount();
    expect(signals[2]?.aborted).toBe(true);
  });

  it('exports one message by identity only and cancels the host stream on unmount', async () => {
    let exportSignal: AbortSignal | undefined;
    const exportMessage = vi.fn((_messageId: string, options: { signal: AbortSignal }) => {
      exportSignal = options.signal;
      return new Promise<void>(() => {});
    });
    const { unmount } = render(<MemeLoopMessage message={exportOnlyMessage('exportable')} exportMessage={exportMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export full message' }));
    await waitFor(() => {
      expect(exportMessage).toHaveBeenCalledTimes(1);
    });
    expect(exportMessage.mock.calls[0]).toHaveLength(2);
    expect(exportMessage.mock.calls[0]?.[0]).toBe('exportable');
    expect(exportMessage.mock.calls[0]?.[1]).toEqual({ signal: exportSignal });
    expect(exportSignal?.aborted).toBe(false);

    unmount();
    expect(exportSignal?.aborted).toBe(true);
  });

  it('falls back from an unavailable detail reader to the same single-message export affordance', () => {
    const exportMessage = vi.fn().mockResolvedValue(undefined);
    render(<MemeLoopMessage message={exportOnlyMessage('projected', 'detail')} exportMessage={exportMessage} />);
    expect(screen.queryByRole('button', { name: 'Load details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export full message' })).toBeInTheDocument();
  });

  it('releases the previous Web detail before retaining another bounded page', async () => {
    const first = message('detail-first');
    const second = message('detail-second');
    const loadMessageDetail = vi.fn((current: ChatMessage) =>
      Promise.resolve({
        text: `${current.messageId}-FULL-${current.messageId === first.messageId ? 'A' : 'B'}`.repeat(4_000),
        itemCount: 1,
        truncated: false as const,
      })
    );
    function SingleDetailBudget() {
      const [activeMessageId, setActiveMessageId] = React.useState<string | undefined>(undefined);
      return (
        <>
          {[first, second].map(current => (
            <MemeLoopMessage
              key={current.messageId}
              message={current}
              loadMessageDetail={loadMessageDetail}
              detailDisplayActive={activeMessageId === current.messageId}
              onActivateDetailDisplay={setActiveMessageId}
            />
          ))}
        </>
      );
    }
    render(<SingleDetailBudget />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Load details' })[0]);
    await waitFor(() => {
      expect(document.body.textContent).toContain('detail-first-FULL');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(document.body.textContent).toContain('detail-second-FULL');
      expect(document.body.textContent).not.toContain('detail-first-FULL');
    });
    expect(loadMessageDetail).toHaveBeenCalledTimes(2);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAgentRunLogDetailLoader, MEMELOOP_MESSAGE_DETAIL_LIMIT, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES, validateMessageDetailPage } from '../chat/messageDetail.js';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';

function message(messageId: string): ConversationMessageListProjection {
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

function exportOnlyMessage(messageId: string, capability: 'detail' | 'export' = 'export'): ConversationMessageListProjection {
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

  it('enforces the aggregate byte budget while formatting a near-limit page', async () => {
    const formatItem = vi.fn((item: { label: string; content: string }) => `${item.label}: ${item.content}`);
    const loader = createAgentRunLogDetailLoader({
      pull: vi.fn().mockResolvedValue({
        items: Array.from({ length: 50 }, (_, index) => ({
          label: `项${index}`,
          content: '😀'.repeat(40_000),
        })),
        truncated: true,
      }),
      formatItem,
    });
    await expect(loader(message('aggregate'), {
      limit: MEMELOOP_MESSAGE_DETAIL_LIMIT,
      maxBytes: MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
      signal: new AbortController().signal,
    })).rejects.toThrow('aggregate exceeds its byte budget');
    expect(formatItem.mock.calls.length).toBeLessThan(50);
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
    const loadMessageDetail = vi.fn((current: ConversationMessageListProjection, request: { signal: AbortSignal }) => {
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

  it('appends validated cursor pages without a cumulative display budget', async () => {
    const firstPage = `first page ${'x'.repeat(32 * 1024)} tail`;
    const loadMessageDetail = vi.fn()
      .mockResolvedValueOnce({ text: firstPage, itemCount: 1, truncated: true, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ text: 'second page', itemCount: 1, truncated: false });
    render(<MemeLoopMessage message={message('paged')} loadMessageDetail={loadMessageDetail} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(screen.getByText((content: string) => content.endsWith('tail'))).toBeInTheDocument();
    });
    expect(loadMessageDetail.mock.calls[0]?.[1]).not.toHaveProperty('cursor');
    expect(screen.getByRole('button', { name: 'Load more details' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(2);
    });
    expect(loadMessageDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'paged' }),
      expect.objectContaining({ cursor: 'cursor-2', limit: 50, maxBytes: 256 * 1024, signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText('second page')).toBeInTheDocument();
    expect(screen.getByText((content: string) => content.endsWith('tail'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more details' })).not.toBeInTheDocument();
  });

  it('aborts and ignores a stale cursor page after the message changes', async () => {
    let resolveCursorPage!: (value: { text: string; itemCount: number; truncated: false }) => void;
    let cursorSignal: AbortSignal | undefined;
    const loadMessageDetail = vi.fn((current: ConversationMessageListProjection, request: { cursor?: string; signal: AbortSignal }) => {
      if (request.cursor === 'old-cursor') {
        cursorSignal = request.signal;
        return new Promise<{ text: string; itemCount: number; truncated: false }>(resolve => {
          resolveCursorPage = resolve;
        });
      }
      return Promise.resolve({
        text: current.messageId === 'old' ? 'old first page' : 'new first page',
        itemCount: 1,
        truncated: current.messageId === 'old',
        ...(current.messageId === 'old' ? { nextCursor: 'old-cursor' } : {}),
      });
    });
    const { rerender } = render(<MemeLoopMessage message={message('old')} loadMessageDetail={loadMessageDetail} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    expect(await screen.findByText('old first page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more details' }));
    await waitFor(() => {
      expect(cursorSignal).toBeDefined();
    });

    rerender(<MemeLoopMessage message={message('new')} loadMessageDetail={loadMessageDetail} />);
    expect(cursorSignal?.aborted).toBe(true);
    resolveCursorPage({ text: 'stale cursor page', itemCount: 1, truncated: false });
    expect(screen.queryByText('stale cursor page')).not.toBeInTheDocument();
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

  it('reports detail failures without exposing the provider error text', async () => {
    const onOperationError = vi.fn();
    const loadMessageDetail = vi.fn().mockRejectedValue(new Error('provider secret'));
    render(
      <MemeLoopMessage
        message={message('detail-failure')}
        loadMessageDetail={loadMessageDetail}
        labels={{ detailLoadFailed: 'Localized detail failure' }}
        onOperationError={onOperationError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(screen.getByText('Localized detail failure')).toBeInTheDocument();
    });
    expect(onOperationError).toHaveBeenCalledWith(expect.any(Error), 'load-detail');
    expect(screen.queryByText('provider secret')).not.toBeInTheDocument();
  });

  it('reports export failures without swallowing the host operation', async () => {
    const onOperationError = vi.fn();
    const exportMessage = vi.fn().mockRejectedValue(new Error('export secret'));
    render(
      <MemeLoopMessage
        message={exportOnlyMessage('export-failure')}
        exportMessage={exportMessage}
        onOperationError={onOperationError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export full message' }));
    await waitFor(() => {
      expect(onOperationError).toHaveBeenCalledWith(expect.any(Error), 'export-message');
    });
    expect(screen.queryByText('export secret')).not.toBeInTheDocument();
  });

  it('releases the previous Web detail before retaining another bounded page', async () => {
    const first = message('detail-first');
    const second = message('detail-second');
    const loadMessageDetail = vi.fn((current: ConversationMessageListProjection) =>
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

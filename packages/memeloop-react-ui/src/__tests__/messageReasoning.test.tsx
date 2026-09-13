import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationMessageListProjection, ConversationMessageReasoningProjection } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { validateMessageReasoningPage } from '../chat/messageReasoning.js';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';

function message(
  reasoning: ConversationMessageReasoningProjection,
  content = '',
): ConversationMessageListProjection {
  return {
    messageId: 'assistant-1',
    turnId: 'user-1',
    conversationId: 'conversation-1',
    originNodeId: 'peer-1',
    originSequence: 2,
    lamportClock: 2,
    timestamp: 2,
    role: 'assistant',
    content,
    reasoning,
  };
}

const labels = {
  reasoning: 'Reasoning label',
  thinking: 'Thinking label',
  showReasoning: 'Show reasoning label',
  hideReasoning: 'Hide reasoning label',
  loadMoreReasoning: 'Load more reasoning label',
  reasoningLoadFailed: 'Reasoning failed label',
};

describe('MemeLoop reasoning presentation', () => {
  it('renders streamed reasoning above an independently streamed answer without an ellipsis body', () => {
    const view = render(
      <MemeLoopMessage
        message={message({ text: 'first thought', totalBytes: 13, hasMore: false })}
        isStreaming
        labels={labels}
      />,
    );

    expect(screen.getByRole('button', { name: /Thinking label/u }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Thinking label')).toBeTruthy();
    expect(screen.queryByText('…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Thinking label/u }));
    expect(screen.getByTestId('message-reasoning-text').textContent).toContain('first thought');

    view.rerender(
      <MemeLoopMessage
        message={message({ text: 'first thought, then verify', totalBytes: 26, hasMore: false }, 'streamed answer')}
        isStreaming
        labels={labels}
      />,
    );
    expect(screen.getByRole('button', { name: /Thinking label/u }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('message-reasoning-text').textContent).toContain('first thought, then verify');
    expect(screen.getByTestId('assistant-streaming-text').textContent).toContain('streamed answer');
    expect(screen.queryByTestId('message-display-truncated')).toBeNull();
  });

  it('pages persisted reasoning independently and keeps the answer resident', async () => {
    const first = new TextEncoder().encode('理由一。');
    const second = new TextEncoder().encode('理由二。');
    const totalBytes = first.byteLength + second.byteLength;
    const loader = vi.fn(async (_message: ConversationMessageListProjection, request: { offset: number }) =>
      request.offset === 0
        ? { found: true as const, offset: 0, totalBytes, bytes: first }
        : { found: true as const, offset: first.byteLength, totalBytes, bytes: second }
    );
    expect(() =>
      validateMessageReasoningPage(
        { found: true, offset: 0, totalBytes, bytes: first },
        { offset: 0, maxBytes: 64 * 1024 },
      )
    ).not.toThrow();
    render(
      <MemeLoopMessage
        message={message({ text: '', totalBytes, hasMore: true }, 'final answer')}
        loadMessageReasoning={loader}
        labels={labels}
      />,
    );

    expect(screen.getByText('final answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reasoning label/u }).getAttribute('aria-expanded')).toBe('false');
    expect(loader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Reasoning label/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more reasoning label' }));
    await waitFor(() => {
      expect(screen.getByTestId('message-reasoning-text').textContent).toContain('理由一。');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more reasoning label' }));
    await waitFor(() => {
      expect(screen.getByTestId('message-reasoning-text').textContent).toContain('理由一。理由二。');
    });
    expect(loader).toHaveBeenNthCalledWith(1, expect.objectContaining({ messageId: 'assistant-1' }), expect.objectContaining({ offset: 0 }));
    expect(loader).toHaveBeenNthCalledWith(2, expect.objectContaining({ messageId: 'assistant-1' }), expect.objectContaining({ offset: first.byteLength }));
    expect(screen.queryByRole('button', { name: 'Load more reasoning label' })).toBeNull();
  });

  it('reports reasoning failures while keeping the retry action localized', async () => {
    const onOperationError = vi.fn();
    const loader = vi.fn().mockRejectedValue(new Error('provider secret'));
    render(
      <MemeLoopMessage
        message={message({ text: '', totalBytes: 8, hasMore: true }, 'answer')}
        loadMessageReasoning={loader}
        onOperationError={onOperationError}
        labels={{ ...labels, reasoningLoadFailed: 'Localized reasoning failure' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reasoning label/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more reasoning label' }));
    await waitFor(() => {
      expect(screen.getByText('Localized reasoning failure')).toBeInTheDocument();
    });
    expect(onOperationError).toHaveBeenCalledWith(expect.any(Error), 'load-reasoning');
    expect(screen.queryByText('provider secret')).not.toBeInTheDocument();
  });
});

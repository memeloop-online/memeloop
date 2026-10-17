import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationMessageListProjection } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { RenderedMessageContent } from '../chat/content/RenderedMessageContent.js';

const message: ConversationMessageListProjection = {
  messageId: 'answer',
  conversationId: 'chat',
  turnId: 'turn',
  role: 'assistant',
  timestamp: 1,
  lamportClock: 1,
  originNodeId: 'node',
  originSequence: 1,
  content: "''wiki bold''",
  contentType: 'text/vnd.tiddlywiki',
};

describe('rich message rendering', () => {
  it('renders complete text when only unrelated metadata was omitted from the list', async () => {
    const renderHtml = vi.fn(async () => '<strong>wiki bold</strong>');
    render(
      <RenderedMessageContent
        message={{
          ...message,
          metadata: {
            displayTruncation: {
              truncated: true,
              contentTruncated: false,
              originalCharacterCount: 13,
              capability: 'export',
              originalEstimatedBytes: 13,
              originalEstimatedRenderRows: 1,
              omittedFields: [],
            },
          },
        }}
        renderHtml={renderHtml}
      />,
    );
    await screen.findByTestId('rendered-message');
    expect(renderHtml).toHaveBeenCalled();
  });
  it('keeps the truncation notice and does not render an incomplete document', () => {
    const renderHtml = vi.fn(async () => '<b>partial</b>');
    render(
      <RenderedMessageContent
        message={{
          ...message,
          metadata: {
            displayTruncation: {
              truncated: true,
              contentTruncated: true,
              originalCharacterCount: 100000,
              capability: 'detail',
              originalEstimatedBytes: 100000,
              originalEstimatedRenderRows: 1000,
              omittedFields: [],
            },
          },
        }}
        renderHtml={renderHtml}
      />,
    );
    expect(screen.getByText(/Message shortened/)).toBeInTheDocument();
    expect(renderHtml).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rendered-message')).not.toBeInTheDocument();
  });
  it('isolates rendered HTML and offers original source', async () => {
    const renderHtml = vi.fn(async () => '<strong>wiki bold</strong><script>window.secret=1</script>');
    render(<RenderedMessageContent message={message} renderHtml={renderHtml} />);
    const frame = await screen.findByTestId('rendered-message');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    fireEvent.click(screen.getByTestId('message-render-toggle'));
    expect(screen.getByText("''wiki bold''")).toBeInTheDocument();
  });

  it('ignores a stale workspace result and falls back on unavailable workspaces', async () => {
    let finish: ((html: string) => void) | undefined;
    const oldRenderer = () =>
      new Promise<string>(resolve => {
        finish = resolve;
      });
    const nextRenderer = vi.fn(async () => undefined);
    const view = render(<RenderedMessageContent message={message} renderHtml={oldRenderer} />);
    view.rerender(<RenderedMessageContent message={message} renderHtml={nextRenderer} />);
    await act(async () => {
      finish?.('<b>wrong wiki</b>');
    });
    await waitFor(() => {
      expect(nextRenderer).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('rendered-message')).not.toBeInTheDocument();
    expect(screen.getByText("''wiki bold''")).toBeInTheDocument();
  });
});

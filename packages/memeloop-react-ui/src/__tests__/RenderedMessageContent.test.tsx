import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  it('keeps a rendered Markdown table mounted as text streams and finishes', async () => {
    const renderHtml = vi.fn(async () => '<p>wrong renderer</p>');
    const first = '| Date | Activity |\n| --- | --- |\n| Tuesday | **Review** |\n';
    const markdown = (content: string) => ({ ...message, content, contentType: 'text/plain' as const });
    const view = render(<RenderedMessageContent message={markdown(first)} isStreaming preferredFormat='markdown' renderHtml={renderHtml} />);
    const table = await screen.findByRole('table');
    expect(screen.getByText('Review').tagName).toBe('STRONG');
    const last = `${first}| Wednesday | Planning |\n\nSummary for [[Calendar]]`;
    view.rerender(<RenderedMessageContent message={markdown(last)} isStreaming preferredFormat='markdown' renderHtml={renderHtml} />);
    await screen.findByText('Planning');
    expect(screen.getByRole('table')).toBe(table);
    view.rerender(<RenderedMessageContent message={markdown(last)} preferredFormat='markdown' renderHtml={renderHtml} />);
    await screen.findByText('Summary for [[Calendar]]');
    expect(screen.getByRole('table')).toBe(table);
    expect(renderHtml).not.toHaveBeenCalled();
  });

  it('coalesces wiki updates and updates the same table and first row through completion', async () => {
    const requests: { text: string; resolve: (html: string) => void }[] = [];
    const renderHtml = (text: string) => new Promise<string>(resolve => requests.push({ text, resolve }));
    const content = { ...message, contentType: 'text/plain' };
    const first = '|! Task |h\n| Read notes |\n';
    const last = `${first}| Write summary |\n`;
    const row = '<tr><td>Read notes</td></tr>';
    const view = render(<RenderedMessageContent message={{ ...content, content: first }} isStreaming preferredFormat='wikitext' renderHtml={renderHtml} />);
    view.rerender(<RenderedMessageContent message={{ ...content, content: `${first}| Write` }} isStreaming preferredFormat='wikitext' renderHtml={renderHtml} />);
    expect(requests.map(request => request.text)).toEqual([first]);
    await act(async () => {
      requests[0].resolve(`<table><tbody>${row}</tbody></table>`);
    });

    const frame = await screen.findByTestId<HTMLIFrameElement>('rendered-message');
    const document = frame.contentDocument!;
    // jsdom doesn't load the iframe's srcDoc.
    document.body.innerHTML = '<main id="message-body"></main>';
    await act(async () => frame.dispatchEvent(new Event('load')));
    const table = document.querySelector('table');
    const firstRow = table?.rows[0];
    expect(firstRow?.textContent).toBe('Read notes');
    view.rerender(<RenderedMessageContent message={{ ...content, content: last }} preferredFormat='wikitext' renderHtml={renderHtml} />);
    await act(async () => {
      requests[1].resolve(`<table><tbody>${row}<tr><td>Write summary</td></tr></tbody></table>`);
    });
    expect(requests.map(request => request.text)).toEqual([first, last]);
    expect(screen.getByTestId('rendered-message')).toBe(frame);
    expect(document.querySelector('table')).toBe(table);
    expect(table?.rows[0]).toBe(firstRow);
    expect(table?.rows[1]?.textContent).toBe('Write summary');
  });

  it('shows the full reply if the final WikiText render fails after a successful preview', async () => {
    let rejectRender: (reason: Error) => void = () => {};
    const onRenderError = vi.fn();
    const renderHtml = vi.fn<(text: string) => Promise<string>>()
      .mockResolvedValueOnce('<p>First paragraph</p>')
      .mockImplementationOnce(() =>
        new Promise((_resolve, reject) => {
          rejectRender = reject;
        })
      );
    const view = render(
      <RenderedMessageContent message={{ ...message, content: 'First paragraph' }} isStreaming renderHtml={renderHtml} onRenderError={onRenderError} />,
    );
    const frame = await screen.findByTestId('rendered-message');
    const content = 'First paragraph and the rest of the reply';
    view.rerender(<RenderedMessageContent message={{ ...message, content }} renderHtml={renderHtml} onRenderError={onRenderError} />);
    expect(screen.getByTestId('rendered-message')).toBe(frame);
    const failure = new Error('Wiki render unavailable');
    await act(async () => {
      rejectRender(failure);
    });
    expect(screen.getByText(content)).toBeVisible();
    expect(onRenderError).toHaveBeenCalledWith(failure);
  });

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
  it('isolates rendered HTML without an unnecessary source switch', async () => {
    const renderHtml = vi.fn(async () => '<strong>wiki bold</strong><script>window.secret=1</script>');
    render(<RenderedMessageContent message={message} renderHtml={renderHtml} />);
    const frame = await screen.findByTestId('rendered-message');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(screen.queryByTestId('message-render-toggle')).not.toBeInTheDocument();
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

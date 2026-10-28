import React from 'react';
import '@testing-library/jest-dom/vitest';
import { createTheme, ThemeProvider } from '@mui/material';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ConversationEditingAdapter, ConversationMessageListProjection } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { RenderedMessageContent } from '../chat/content/RenderedMessageContent.js';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';

const message: ConversationMessageListProjection = {
  messageId: 'question',
  conversationId: 'chat',
  turnId: 'turn',
  role: 'user',
  content: '<strong>Question</strong>',
  contentType: 'text/html',
  timestamp: 1,
  lamportClock: 1,
  originNodeId: 'node',
  originSequence: 1,
};

describe('shared message footer', () => {
  it('renders both messages without source-toggle controls', async () => {
    render(
      <>
        <MemeLoopMessage message={message} renderContent={item => <RenderedMessageContent message={item} />} />
        <MemeLoopMessage message={{ ...message, messageId: 'second', role: 'assistant' }} renderContent={item => <RenderedMessageContent message={item} />} />
      </>,
    );
    await screen.findAllByTestId('rendered-message');
    expect(screen.getAllByTestId('rendered-message')).toHaveLength(2);
    expect(screen.queryByTestId('message-render-toggle')).not.toBeInTheDocument();
  });

  it('keeps editing and rendering controls outside the user surface across closing the editor', async () => {
    const editing: ConversationEditingAdapter = {
      branches: [],
      loadSource: vi.fn(async () => ({ text: message.content, sourceRevision: 'one', draft: null })),
      saveDraft: vi.fn(async () => 1),
      submit: vi.fn(async () => {}),
      switchBranch: vi.fn(async () => {}),
    };
    render(
      <MemeLoopMessage
        message={message}
        editing={editing}
        renderContent={item => <RenderedMessageContent message={item} />}
        renderTurnActions={() => <button>Copy</button>}
      />,
    );
    await screen.findByTestId('rendered-message');
    const toolbar = screen.getByTestId('message-toolbar');
    expect(screen.queryByTestId('message-render-toggle')).not.toBeInTheDocument();
    expect(within(toolbar).getByTestId('message-edit')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByTestId('user-message-surface')).not.toContainElement(toolbar);
    fireEvent.click(screen.getByTestId('message-edit'));
    const input = await screen.findByTestId('message-edit-input');
    expect(screen.queryByTestId('message-render-toggle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(await screen.findByTestId('rendered-message')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('uses transparent rendered surfaces and readable role colors in %s mode', async mode => {
    const theme = createTheme({ palette: { mode } });
    const view = render(
      <ThemeProvider theme={theme}>
        <MemeLoopMessage message={message} renderContent={item => <RenderedMessageContent message={item} />} />
      </ThemeProvider>,
    );
    const frame = await screen.findByTestId('rendered-message');
    expect(getComputedStyle(frame).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(frame.getAttribute('srcdoc')).toContain(`color:${theme.palette.primary.contrastText}`);
    view.rerender(
      <ThemeProvider theme={theme}>
        <MemeLoopMessage message={{ ...message, role: 'assistant' }} renderContent={item => <RenderedMessageContent message={item} />} />
      </ThemeProvider>,
    );
    const reply = await screen.findByTestId('rendered-message');
    expect(reply.getAttribute('srcdoc')).toContain(`color:${theme.palette.text.primary}`);
    expect(screen.queryByTestId('message-render-toggle')).not.toBeInTheDocument();
  });
});

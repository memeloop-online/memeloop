import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MessageContent } from '../chat/content/MessageContent.js';
import { MemeLoopRuntimeProvider } from '../chat/runtime/MemeLoopRuntimeProvider.js';
import type { WebMemeLoopChatAdapter } from '../chat/types.js';

function adapter(overrides: Partial<WebMemeLoopChatAdapter> = {}): WebMemeLoopChatAdapter {
  return {
    conversationId: 'conversation-1',
    messages: [],
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function projection(overrides: Partial<ConversationMessageListProjection> = {}): ConversationMessageListProjection {
  return {
    messageId: 'message-1',
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    originNodeId: 'node-1',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'tool',
    content: 'bounded tool summary',
    ...overrides,
  };
}

function renderWithProvider(node: React.ReactNode, overrides: Partial<WebMemeLoopChatAdapter> = {}) {
  return render(
    <MemeLoopRuntimeProvider adapter={adapter(overrides)}>{node}</MemeLoopRuntimeProvider>,
  );
}

describe('MessageContent presentation registry', () => {
  it('renders the first registered presentation in Core order and resolves an answer', () => {
    const resolveAskQuestion = vi.fn().mockResolvedValue(undefined);
    const message = projection({
      presentations: [
        { kind: 'tool-result', toolName: 'unknown-tool', detailAvailable: false, truncated: true },
        {
          kind: 'tool-result',
          toolName: 'ask-question',
          detailAvailable: false,
          payload: {
            type: 'ask-question',
            questionId: 'question-1',
            question: 'Which workspace?',
            options: [{ label: 'Wiki A' }],
          },
        },
      ],
    });

    renderWithProvider(<MessageContent message={message} />, { resolveAskQuestion });

    expect(screen.getByTestId('ask-question-container')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Wiki A'));
    expect(resolveAskQuestion).toHaveBeenCalledWith('question-1', 'Wiki A');
  });

  it('falls back to bounded content for unknown or truncated presentations', () => {
    const message = projection({
      content: 'safe bounded summary',
      presentations: [
        {
          kind: 'tool-result',
          toolName: 'unknown-tool',
          detailAvailable: true,
          payload: { secret: 'must-not-be-rendered' },
        },
        { kind: 'tool-result', toolName: 'ask-question', detailAvailable: true, truncated: true },
      ],
    });

    renderWithProvider(<MessageContent message={message} />);

    expect(screen.getByText('safe bounded summary')).toBeInTheDocument();
    expect(screen.queryByText('must-not-be-rendered')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ask-question-container')).not.toBeInTheDocument();
  });

  it('does not render an ellipsis body for a reasoning-only projection', () => {
    const message = projection({
      role: 'assistant',
      content: '',
      reasoning: { text: '', totalBytes: 32, hasMore: true },
    });

    renderWithProvider(<MessageContent message={message} />);

    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });

  it('does not label a complete text projection when only structured parts were omitted', () => {
    const message = projection({
      role: 'assistant',
      content: '2',
      metadata: {
        displayTruncation: {
          truncated: true,
          originalCharacterCount: 1,
          originalEstimatedBytes: 1,
          originalEstimatedRenderRows: 1,
          contentTruncated: false,
          omittedFields: ['parts'],
          capability: 'detail',
        },
      },
    });

    renderWithProvider(<MessageContent message={message} />);

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByTestId('message-display-truncated')).not.toBeInTheDocument();
  });

  it('labels a text projection when its visible content was shortened', () => {
    const message = projection({
      role: 'assistant',
      content: 'truncated prefix',
      metadata: {
        displayTruncation: {
          truncated: true,
          originalCharacterCount: 42,
          originalEstimatedBytes: 42,
          originalEstimatedRenderRows: 1,
          contentTruncated: true,
          omittedFields: [],
          capability: 'detail',
        },
      },
    });

    renderWithProvider(<MessageContent message={message} />);

    expect(screen.getByTestId('message-display-truncated')).toHaveTextContent(
      'Message shortened for display (42 characters).',
    );
  });

  it('allows hosts to register a renderer without changing the generic switch', () => {
    const message = projection({
      presentations: [{ kind: 'tool-result', toolName: 'host-tool', detailAvailable: false }],
    });
    renderWithProvider(
      <MessageContent
        message={message}
        toolResultRenderers={{
          'host-tool': () => <span data-testid='host-tool-rendered'>Host result</span>,
        }}
      />,
    );

    expect(screen.getByTestId('host-tool-rendered')).toHaveTextContent('Host result');
  });
});

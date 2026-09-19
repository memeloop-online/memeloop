import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MemeLoopChatAdapter } from '../chat/coreTypes.js';
import { NativeAgentChatView } from '../native/AgentChatView.js';

interface CapturedGiftedMessage {
  _id: string;
}

interface CapturedGiftedChatProps {
  messages: readonly CapturedGiftedMessage[];
  renderCustomView?: (props: { currentMessage?: CapturedGiftedMessage }) => React.ReactNode;
}

const giftedChatCapture = vi.hoisted(() => ({
  current: undefined as CapturedGiftedChatProps | undefined,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const View = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', undefined, children);
  const Text = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('span', undefined, children);
  const Pressable = ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
    style,
  }: {
    accessibilityLabel?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    style?: unknown;
  }) =>
    ReactModule.createElement('button', {
      'aria-label': accessibilityLabel,
      'data-min-height': typeof style === 'object' && style !== null && 'minHeight' in style ? String(style.minHeight) : undefined,
      disabled,
      onClick: onPress,
      type: 'button',
    }, children);
  const Modal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) => visible ? ReactModule.createElement('div', undefined, children) : null;
  const TextInput = () => ReactModule.createElement('input');
  const FlatList = () => null;
  return {
    FlatList,
    I18nManager: { isRTL: false },
    Modal,
    Pressable,
    Text,
    TextInput,
    useWindowDimensions: () => ({ width: 1_024, height: 768, scale: 1, fontScale: 1 }),
    View,
  };
});

vi.mock('react-native-paper', () => ({
  useTheme: () => ({
    colors: {
      backdrop: 'theme-backdrop',
      error: 'theme-error',
      inverseOnSurface: 'theme-inverse-on-surface',
      inverseSurface: 'theme-inverse-surface',
      onPrimary: 'theme-on-primary',
      onPrimaryContainer: 'theme-on-primary-container',
      onSurface: 'theme-on-surface',
      onSurfaceVariant: 'theme-on-surface-variant',
      outline: 'theme-outline',
      primary: 'theme-primary',
      primaryContainer: 'theme-primary-container',
      surface: 'theme-surface',
      surfaceVariant: 'theme-surface-variant',
    },
  }),
}));

vi.mock('react-native-gifted-chat', async () => {
  const ReactModule = await import('react');
  return {
    GiftedChat: (props: CapturedGiftedChatProps) => {
      giftedChatCapture.current = props;
      return ReactModule.createElement('div', { 'data-testid': 'gifted-chat' });
    },
  };
});

const genericErrorPresentation = {
  title: 'Operation failed',
  message: 'Try again.',
};

function projectedMessage(
  conversationId: string,
  capability: 'detail' | 'export',
): ConversationMessageListProjection {
  return {
    messageId: `${conversationId}-assistant`,
    turnId: `${conversationId}-turn`,
    conversationId,
    originNodeId: 'node',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'assistant',
    content: 'bounded projection',
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

function adapter(
  conversationId: string,
  message: ConversationMessageListProjection,
  exportMessage: NonNullable<MemeLoopChatAdapter['exportMessage']>,
  onError?: MemeLoopChatAdapter['onError'],
): MemeLoopChatAdapter {
  return {
    conversationId,
    messages: [message],
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
    exportMessage,
    onError,
  };
}

function renderCapturedFooter(): ReturnType<typeof render> {
  const props = giftedChatCapture.current;
  if (!props?.renderCustomView || !props.messages[0]) throw new Error('GiftedChat footer was not captured');
  return render(<>{props.renderCustomView({ currentMessage: props.messages[0] })}</>);
}

function capturedFooterNodes(): React.ReactNode {
  const props = giftedChatCapture.current;
  if (!props?.renderCustomView) throw new Error('GiftedChat footer was not captured');
  return props.messages.map(message => <React.Fragment key={message._id}>{props.renderCustomView?.({ currentMessage: message })}</React.Fragment>);
}

describe('NativeAgentChatView single-message export', () => {
  it('renders an accessible localized action only when truncation needs export recovery', () => {
    const exportMessage = vi.fn().mockResolvedValue(undefined);
    const ordinaryMessage = { ...projectedMessage('ordinary', 'export'), metadata: undefined };
    const main = render(
      <NativeAgentChatView
        adapter={adapter('ordinary', ordinaryMessage, exportMessage)}
        labels={{ exportFullMessage: '导出完整消息' }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const ordinaryFooter = renderCapturedFooter();
    expect(screen.queryByRole('button', { name: '导出完整消息' })).not.toBeInTheDocument();
    ordinaryFooter.unmount();

    main.rerender(
      <NativeAgentChatView
        adapter={adapter('detail', projectedMessage('detail', 'detail'), exportMessage)}
        labels={{ exportFullMessage: '导出完整消息' }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    renderCapturedFooter();
    expect(screen.getByRole('button', { name: '导出完整消息' })).toHaveTextContent('导出完整消息');
    expect(screen.getByRole('button', { name: '导出完整消息' })).toHaveAttribute('data-min-height', '44');
  });

  it('passes identity and signal only, and aborts superseded and generation-stale exports once', async () => {
    const signals: AbortSignal[] = [];
    const abortCounts: number[] = [];
    const exportMessage = vi.fn((messageId: string, options: { signal: AbortSignal }) => {
      expect(messageId).toMatch(/-assistant$/u);
      const index = signals.length;
      signals.push(options.signal);
      abortCounts[index] = 0;
      options.signal.addEventListener('abort', () => {
        abortCounts[index] += 1;
      });
      return new Promise<void>(() => {});
    });
    const main = render(
      <NativeAgentChatView
        adapter={adapter('A', projectedMessage('A', 'export'), exportMessage)}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const footer = renderCapturedFooter();
    const action = screen.getByRole('button', { name: 'Export full message' });

    fireEvent.click(action);
    await waitFor(() => {
      expect(exportMessage).toHaveBeenCalledTimes(1);
    });
    expect(exportMessage.mock.calls[0]).toHaveLength(2);
    expect(exportMessage.mock.calls[0]?.[0]).toBe('A-assistant');
    expect(exportMessage.mock.calls[0]?.[1]).toEqual({ signal: signals[0] });
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.click(action);
    await waitFor(() => {
      expect(exportMessage).toHaveBeenCalledTimes(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(abortCounts[0]).toBe(1);
    expect(signals[1]?.aborted).toBe(false);

    main.rerender(
      <NativeAgentChatView
        adapter={adapter('B', projectedMessage('B', 'export'), exportMessage)}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    await waitFor(() => {
      expect(signals[1]?.aborted).toBe(true);
    });
    expect(abortCounts[1]).toBe(1);
    main.unmount();
    expect(abortCounts).toEqual([1, 1]);
    footer.unmount();
  });

  it('reports host failures but suppresses failures from a superseded export', async () => {
    let rejectFirst!: (error: Error) => void;
    const onError = vi.fn();
    const exportMessage = vi.fn()
      .mockImplementationOnce(() =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        })
      )
      .mockRejectedValueOnce(new Error('current export failed'));
    render(
      <NativeAgentChatView
        adapter={adapter('errors', projectedMessage('errors', 'export'), exportMessage, onError)}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    renderCapturedFooter();
    const action = screen.getByRole('button', { name: 'Export full message' });

    fireEvent.click(action);
    await waitFor(() => {
      expect(exportMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(action);
    rejectFirst(new Error('stale export failed'));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'current export failed' }), 'export-message');
    });
  });

  it('aborts a pending export once when the native view unmounts', async () => {
    let signal: AbortSignal | undefined;
    let abortCount = 0;
    const exportMessage = vi.fn((_messageId: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      signal.addEventListener('abort', () => {
        abortCount += 1;
      });
      return new Promise<void>(() => {});
    });
    const main = render(
      <NativeAgentChatView
        adapter={adapter('unmount', projectedMessage('unmount', 'export'), exportMessage)}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const footer = renderCapturedFooter();
    fireEvent.click(screen.getByRole('button', { name: 'Export full message' }));
    await waitFor(() => {
      expect(exportMessage).toHaveBeenCalledTimes(1);
    });

    main.unmount();
    expect(signal?.aborted).toBe(true);
    expect(abortCount).toBe(1);
    footer.unmount();
    expect(abortCount).toBe(1);
  });
});

describe('NativeAgentChatView timeline cancellation', () => {
  it('silences a superseded seek and reports only the current non-cancellation failure', async () => {
    const message = projectedMessage('timeline', 'export');
    const signals: AbortSignal[] = [];
    const abortCounts: number[] = [];
    const rejectOperations: Array<(error: Error) => void> = [];
    const loadTimelineAround = vi.fn((_entryIndex: number, _revision: string, signal?: AbortSignal) => {
      if (!signal) throw new Error('timeline signal is required');
      const index = signals.length;
      signals.push(signal);
      abortCounts[index] = 0;
      signal.addEventListener('abort', () => {
        abortCounts[index] += 1;
      });
      return new Promise<void>((_resolve, reject) => {
        rejectOperations.push(reject);
      });
    });
    const onError = vi.fn();
    render(
      <NativeAgentChatView
        adapter={{
          ...adapter('timeline', message, vi.fn().mockResolvedValue(undefined), onError),
          timeline: {
            reset: false,
            items: [{
              kind: 'message',
              entryId: message.messageId,
              conversationId: 'timeline',
              cursor: 'cursor-1',
              timestamp: 1,
              lamportClock: 1,
              originNodeId: 'node',
              entryIndex: 0,
              turnIndex: 0,
              messageId: message.messageId,
              turnId: message.turnId,
              role: 'assistant',
              actorId: 'assistant',
              actorLabel: 'Agent',
              preview: 'remembered user message',
            }],
            revision: 'revision-1',
            totalMessages: 1,
            totalTurns: 1,
            totalEntries: 2,
            hasMoreBefore: false,
            hasMoreAfter: true,
          },
          loadTimelineAround,
        }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Conversation timeline: assistant message 1 of 2' }));
    const seek = screen.getByRole('button', { name: 'Seek conversation timeline' });

    fireEvent.click(seek);
    await waitFor(() => {
      expect(loadTimelineAround).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(seek);
    await waitFor(() => {
      expect(loadTimelineAround).toHaveBeenCalledTimes(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(abortCounts[0]).toBe(1);
    rejectOperations[0]?.(new Error('stale seek failed'));
    expect(onError).not.toHaveBeenCalled();

    rejectOperations[1]?.(new Error('current seek failed'));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'current seek failed' }), 'load-timeline-around');
    });
  });
});

describe('NativeAgentChatView detail display', () => {
  it('appends cursor pages with no aggregate detail cap', async () => {
    const message = {
      ...projectedMessage('cursor-pages', 'detail'),
      detailRef: { type: 'agent-run' as const, conversationId: 'cursor-pages', nodeId: 'node' },
    };
    const firstPage = `native first page ${'x'.repeat(32 * 1024)} tail`;
    const loadMessageDetail = vi.fn()
      .mockResolvedValueOnce({ text: firstPage, itemCount: 1, truncated: true, nextCursor: 'native-cursor-2' })
      .mockResolvedValueOnce({ text: 'native second page', itemCount: 1, truncated: false });
    render(
      <NativeAgentChatView
        adapter={{ ...adapter('cursor-pages', message, vi.fn().mockResolvedValue(undefined)), loadMessageDetail }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const footer = renderCapturedFooter();

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(1);
    });
    footer.rerender(<>{capturedFooterNodes()}</>);
    expect(screen.getByText((content: string) => content.endsWith('tail'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more details' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(2);
    });
    expect(loadMessageDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'cursor-pages-assistant' }),
      expect.objectContaining({ cursor: 'native-cursor-2', limit: 50, maxBytes: 256 * 1024, signal: expect.any(AbortSignal) }),
    );
    footer.rerender(<>{capturedFooterNodes()}</>);
    expect(screen.getByText('native second page')).toBeInTheDocument();
    expect(screen.getByText((content: string) => content.endsWith('tail'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more details' })).not.toBeInTheDocument();
  });

  it('aborts and ignores a stale native cursor page when the conversation changes', async () => {
    const oldMessage = {
      ...projectedMessage('native-old', 'detail'),
      detailRef: { type: 'agent-run' as const, conversationId: 'native-old', nodeId: 'node' },
    };
    let cursorSignal: AbortSignal | undefined;
    let resolveCursorPage!: (value: { text: string; itemCount: number; truncated: false }) => void;
    const loadMessageDetail = vi.fn((_message: ConversationMessageListProjection, request: { cursor?: string; signal: AbortSignal }) => {
      if (request.cursor === 'native-old-cursor') {
        cursorSignal = request.signal;
        return new Promise<{ text: string; itemCount: number; truncated: false }>(resolve => {
          resolveCursorPage = resolve;
        });
      }
      return Promise.resolve({ text: 'native first page', itemCount: 1, truncated: true as const, nextCursor: 'native-old-cursor' });
    });
    const main = render(
      <NativeAgentChatView
        adapter={{ ...adapter('native-old', oldMessage, vi.fn().mockResolvedValue(undefined)), loadMessageDetail }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const footer = renderCapturedFooter();

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(1);
    });
    footer.rerender(<>{capturedFooterNodes()}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Load more details' }));
    await waitFor(() => {
      expect(cursorSignal).toBeDefined();
    });

    main.rerender(
      <NativeAgentChatView
        adapter={{ ...adapter('native-new', projectedMessage('native-new', 'detail'), vi.fn().mockResolvedValue(undefined)), loadMessageDetail }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    expect(cursorSignal?.aborted).toBe(true);
    resolveCursorPage({ text: 'stale native cursor page', itemCount: 1, truncated: false });
    footer.rerender(<>{capturedFooterNodes()}</>);
    expect(screen.queryByText('stale native cursor page')).not.toBeInTheDocument();
  });

  it('retains details for only the active message while opening multiple messages', async () => {
    const first = {
      ...projectedMessage('details', 'detail'),
      messageId: 'detail-first',
      turnId: 'turn-first',
      detailRef: { type: 'agent-run' as const, conversationId: 'details', nodeId: 'node' },
    };
    const second = {
      ...projectedMessage('details', 'detail'),
      messageId: 'detail-second',
      turnId: 'turn-second',
      originSequence: 2,
      lamportClock: 2,
      detailRef: { type: 'agent-run' as const, conversationId: 'details', nodeId: 'node' },
    };
    const loadMessageDetail = vi.fn((message: ConversationMessageListProjection, request: { maxBytes: number }) =>
      Promise.resolve({
        text: `${message.messageId}-FULL-${message.messageId === 'detail-first' ? 'A' : 'B'}`.repeat(4_000),
        itemCount: 1,
        truncated: false as const,
      }).then(page => {
        expect(request.maxBytes).toBe(256 * 1024);
        return page;
      })
    );
    render(
      <NativeAgentChatView
        adapter={{
          ...adapter('details', first, vi.fn().mockResolvedValue(undefined)),
          messages: [first, second],
          loadMessageDetail,
        }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const footers = render(<>{capturedFooterNodes()}</>);
    const loadActions = screen.getAllByRole('button', { name: 'Load details' });

    fireEvent.click(loadActions[0]);
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(1);
    });
    footers.rerender(<>{capturedFooterNodes()}</>);
    const firstLoadedId = loadMessageDetail.mock.calls[0]?.[0].messageId;
    expect(document.body.textContent).toContain(`${firstLoadedId}-FULL`);

    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));
    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledTimes(2);
    });
    footers.rerender(<>{capturedFooterNodes()}</>);
    const secondLoadedId = loadMessageDetail.mock.calls[1]?.[0].messageId;
    expect(secondLoadedId).not.toBe(firstLoadedId);
    expect(document.body.textContent).toContain(`${secondLoadedId}-FULL`);
    expect(document.body.textContent).not.toContain(`${firstLoadedId}-FULL`);
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeAgentChatView, type NativeMemeLoopChatAdapter, type NativeMemeLoopFileAttachment } from '../native/AgentChatView.js';

interface CapturedGiftedChatProps {
  onSend?: (messages: Array<{ text: string }>) => void;
  renderAccessory?: () => React.ReactNode;
  renderActions?: () => React.ReactNode;
}

const capture = vi.hoisted(() => ({
  dimensions: { width: 1_024, height: 768, scale: 1, fontScale: 1 },
  gifted: undefined as CapturedGiftedChatProps | undefined,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const View = ({ accessibilityLabel, children, style }: { accessibilityLabel?: string; children?: React.ReactNode; style?: unknown }) =>
    ReactModule.createElement('div', { 'aria-label': accessibilityLabel, 'data-native-style': JSON.stringify(style) }, children);
  const Text = ({ children, numberOfLines, style }: { children?: React.ReactNode; numberOfLines?: number; style?: unknown }) =>
    ReactModule.createElement('span', { 'data-native-style': JSON.stringify(style), 'data-number-of-lines': numberOfLines }, children);
  const Pressable = ({ accessibilityLabel, children, disabled, onPress, style }: {
    accessibilityLabel?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    style?: unknown;
  }) =>
    ReactModule.createElement('button', {
      'aria-label': accessibilityLabel,
      'data-native-style': JSON.stringify(style),
      disabled,
      onClick: onPress,
      type: 'button',
    }, children);
  return {
    FlatList: () => null,
    I18nManager: { isRTL: false },
    Image: () => null,
    Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) => visible ? ReactModule.createElement('div', undefined, children) : null,
    Pressable,
    Text,
    TextInput: () => ReactModule.createElement('input'),
    useWindowDimensions: () => capture.dimensions,
    View,
  };
});

vi.mock('react-native-paper', () => ({
  useTheme: () => ({
    colors: {
      backdrop: 'backdrop',
      error: 'error',
      inverseOnSurface: 'inverse-on-surface',
      inverseSurface: 'inverse-surface',
      onPrimary: 'on-primary',
      onPrimaryContainer: 'on-primary-container',
      onSurface: 'on-surface',
      onSurfaceVariant: 'on-surface-variant',
      outline: 'outline',
      primary: 'primary',
      primaryContainer: 'primary-container',
      surface: 'surface',
      surfaceVariant: 'surface-variant',
    },
  }),
}));

vi.mock('react-native-gifted-chat', async () => {
  const ReactModule = await import('react');
  return {
    GiftedChat: (props: CapturedGiftedChatProps) => {
      capture.gifted = props;
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'gifted-chat' },
        props.renderActions?.(),
        props.renderAccessory?.(),
      );
    },
  };
});

const file = (filename: string, size = 10): NativeMemeLoopFileAttachment => ({
  filename,
  size,
  type: 'image/png',
  uri: `file:///private/cache/${filename}`,
});

function adapter(conversationId = 'conversation'): NativeMemeLoopChatAdapter {
  return {
    conversationId,
    messages: [],
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
  };
}

const genericErrorPresentation = { title: 'Failed', message: 'Try again.' };

beforeEach(() => {
  capture.dimensions = { width: 1_024, height: 768, scale: 1, fontScale: 1 };
  capture.gifted = undefined;
});

describe('Native attachment composer', () => {
  it('selects, replaces, sends and releases host-owned files exactly once', async () => {
    const first = file('first.png');
    const second = file('second.png');
    const pickAttachment = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const releaseAttachment = vi.fn().mockResolvedValue(undefined);
    const chatAdapter = adapter();
    render(
      <NativeAgentChatView
        adapter={chatAdapter}
        labels={{
          addAttachment: 'Add image',
          removeAttachment: name => `Remove ${name}`,
          replaceAttachment: name => `Replace ${name}`,
          selectedAttachment: name => `Selected ${name}`,
        }}
        pickAttachment={pickAttachment}
        releaseAttachment={releaseAttachment}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    expect(await screen.findByText('Selected first.png')).toBeInTheDocument();
    expect(pickAttachment.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conversation', signal: expect.any(AbortSignal) });

    fireEvent.click(screen.getByRole('button', { name: 'Replace first.png' }));
    expect(await screen.findByText('Selected second.png')).toBeInTheDocument();
    await waitFor(() => {
      expect(releaseAttachment).toHaveBeenCalledWith(first);
    });

    await act(async () => {
      capture.gifted?.onSend?.([{ text: 'inspect this' }]);
    });
    await waitFor(() => {
      expect(chatAdapter.sendMessage).toHaveBeenCalledWith({ file: second, text: 'inspect this' });
      expect(releaseAttachment).toHaveBeenCalledWith(second);
    });
    expect(screen.queryByText('Selected second.png')).not.toBeInTheDocument();
    expect(releaseAttachment).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale picker generation and releases its late result', async () => {
    let resolvePicker!: (value: NativeMemeLoopFileAttachment) => void;
    let signal: AbortSignal | undefined;
    let abortCount = 0;
    const late = file('late.png');
    const pickAttachment = vi.fn((context: { signal: AbortSignal }) => {
      signal = context.signal;
      signal.addEventListener('abort', () => {
        abortCount += 1;
      });
      return new Promise<NativeMemeLoopFileAttachment>(resolve => {
        resolvePicker = resolve;
      });
    });
    const releaseAttachment = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <NativeAgentChatView
        adapter={adapter('first')}
        pickAttachment={pickAttachment}
        releaseAttachment={releaseAttachment}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => {
      expect(pickAttachment).toHaveBeenCalledTimes(1);
    });
    view.rerender(
      <NativeAgentChatView
        adapter={adapter('second')}
        pickAttachment={pickAttachment}
        releaseAttachment={releaseAttachment}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    expect(signal?.aborted).toBe(true);
    expect(abortCount).toBe(1);
    await act(async () => {
      resolvePicker(late);
    });
    await waitFor(() => {
      expect(releaseAttachment).toHaveBeenCalledWith(late);
    });
    view.unmount();
    expect(abortCount).toBe(1);
    expect(releaseAttachment).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized selection and keeps compact controls narrow/large-text safe', async () => {
    capture.dimensions = { width: 320, height: 640, scale: 2, fontScale: 1.6 };
    const onError = vi.fn();
    render(
      <NativeAgentChatView
        adapter={{ ...adapter(), onError }}
        attachmentPolicy={{ maxFileBytes: 16 }}
        labels={{ addAttachment: 'Attach localized' }}
        pickAttachment={vi.fn().mockResolvedValue(file('large.png', 17))}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );
    const action = screen.getByRole('button', { name: 'Attach localized' });
    expect(action).toHaveTextContent('+');
    expect(JSON.parse(action.getAttribute('data-native-style') ?? '{}')).toMatchObject({ minHeight: 44, minWidth: 44, paddingHorizontal: 6 });
    fireEvent.click(action);
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'attachment-file-too-large' }), 'select-attachment');
    });
    expect(screen.getByText('Try again.')).toBeInTheDocument();
  });
});

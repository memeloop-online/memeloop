import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemeLoopChatAdapter } from '../chat/coreTypes.js';
import type { MemeLoopVisibleAttachmentLoader } from '../chat/visibleAttachmentHydration.js';
import { NativeAgentChatView } from '../native/AgentChatView.js';

type HydrationRequest = Parameters<MemeLoopVisibleAttachmentLoader>[0];
type HydrationResult = Awaited<ReturnType<MemeLoopVisibleAttachmentLoader>>;

interface GiftedMessage {
  _id: string;
}

interface GiftedProps {
  listViewProps?: {
    onViewableItemsChanged?: (input: { viewableItems: readonly { isViewable: boolean; item: GiftedMessage }[] }) => void;
  };
  messages: readonly GiftedMessage[];
  renderCustomView?: (props: { currentMessage?: GiftedMessage }) => React.ReactNode;
}

const capture = vi.hoisted(() => ({ current: undefined as GiftedProps | undefined }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const View = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', undefined, children);
  const Text = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('span', undefined, children);
  const Pressable = ({ accessibilityLabel, children, onPress }: { accessibilityLabel?: string; children?: React.ReactNode; onPress?: () => void }) =>
    ReactModule.createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, type: 'button' }, children);
  const Image = ({ accessibilityLabel, source }: { accessibilityLabel?: string; source: { uri: string } }) =>
    ReactModule.createElement('img', { alt: accessibilityLabel, src: source.uri });
  return {
    FlatList: () => null,
    I18nManager: { isRTL: false },
    Image,
    Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) => visible ? ReactModule.createElement('div', undefined, children) : null,
    Pressable,
    Text,
    TextInput: () => ReactModule.createElement('input'),
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
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
    GiftedChat: (props: GiftedProps) => {
      capture.current = props;
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'gifted-chat' },
        ...props.messages.map(message =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: message._id },
            props.renderCustomView?.({ currentMessage: message }),
          )
        ),
      );
    },
  };
});

const genericErrorPresentation = { title: 'Operation failed', message: 'Try again.' };

function projection(): ConversationMessageListProjection {
  return {
    messageId: 'native-image',
    turnId: 'native-image',
    conversationId: 'native-conversation',
    originNodeId: 'native-node',
    originSequence: 1,
    timestamp: 2,
    lamportClock: 3,
    role: 'user',
    content: 'two images',
    metadata: {
      displayTruncation: {
        truncated: true,
        originalCharacterCount: 10,
        originalEstimatedBytes: 10,
        originalEstimatedRenderRows: 1,
        contentTruncated: false,
        omittedFields: ['attachments'],
        capability: 'detail',
      },
    },
  };
}

function adapter(loader: MemeLoopVisibleAttachmentLoader, onError = vi.fn()): MemeLoopChatAdapter {
  return {
    conversationId: 'native-conversation',
    messages: [projection()],
    isRunning: false,
    isLoading: false,
    error: null,
    loadVisibleAttachments: loader,
    onError,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
  };
}

async function markMessageVisible() {
  await act(async () => {
    const props = capture.current;
    const message = props?.messages[0];
    if (!message) throw new Error('GiftedChat message missing');
    props.listViewProps?.onViewableItemsChanged?.({ viewableItems: [{ isViewable: true, item: message }] });
  });
}

beforeEach(() => {
  capture.current = undefined;
});

describe('Native visible attachment hydration', () => {
  it('renders every verified visible URI with a filename accessibility label', async () => {
    const loader: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: HydrationRequest) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: [
        {
          reference: { contentHash: `sha256:${'a'.repeat(64)}`, filename: 'one.png', mimeType: 'image/png', size: 10 },
          source: { kind: 'uri' as const, uri: 'content://memeloop/one' },
        },
        {
          reference: { contentHash: `sha256:${'b'.repeat(64)}`, filename: 'two.jpg', mimeType: 'image/jpeg', size: 20 },
          source: { kind: 'uri' as const, uri: 'file:///verified/two.jpg' },
        },
      ],
    }));
    render(<NativeAgentChatView adapter={adapter(loader)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);

    expect(loader).not.toHaveBeenCalled();
    await markMessageVisible();
    expect(await screen.findByRole('img', { name: 'Attachment: one.png' })).toHaveAttribute('src', 'content://memeloop/one');
    expect(screen.getByRole('img', { name: 'Attachment: two.jpg' })).toHaveAttribute('src', 'file:///verified/two.jpg');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('rejects a remote HTTPS URI through the unified operation error path', async () => {
    const onError = vi.fn();
    const loader: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: HydrationRequest) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: [{
        reference: { contentHash: `sha256:${'c'.repeat(64)}`, filename: 'remote.png', mimeType: 'image/png', size: 1 },
        source: { kind: 'uri' as const, uri: 'https://example.test/remote.png' },
      }],
    }));
    render(<NativeAgentChatView adapter={adapter(loader, onError)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);
    await markMessageVisible();

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'load-visible-attachments');
    });
    expect(screen.getByText('Try again.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('aborts a pending read when the Native surface unmounts', async () => {
    let signal: AbortSignal | undefined;
    const loader: MemeLoopVisibleAttachmentLoader = vi.fn(request => {
      signal = request.signal;
      return new Promise<null>(() => {});
    });
    const view = render(<NativeAgentChatView adapter={adapter(loader)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);
    await markMessageVisible();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    view.unmount();
    await act(async () => Promise.resolve());
    expect(signal?.aborted).toBe(true);
  });

  it('clears a prior loader generation and ignores a superseded late result', async () => {
    const first: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: HydrationRequest) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: [{
        reference: { contentHash: `sha256:${'d'.repeat(64)}`, filename: 'old.png', mimeType: 'image/png', size: 1 },
        source: { kind: 'uri' as const, uri: 'content://memeloop/old' },
      }],
    }));
    let resolveSecond!: (value: HydrationResult) => void;
    const second: MemeLoopVisibleAttachmentLoader = vi.fn(() =>
      new Promise<HydrationResult>(resolve => {
        resolveSecond = resolve;
      })
    );
    const third: MemeLoopVisibleAttachmentLoader = vi.fn(async (request: HydrationRequest) => ({
      identity: request.identity,
      revision: request.revision,
      attachments: [{
        reference: { contentHash: `sha256:${'e'.repeat(64)}`, filename: 'new.png', mimeType: 'image/png', size: 1 },
        source: { kind: 'uri' as const, uri: 'content://memeloop/new' },
      }],
    }));
    const view = render(<NativeAgentChatView adapter={adapter(first)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);
    await markMessageVisible();
    expect(await screen.findByRole('img', { name: 'Attachment: old.png' })).toBeInTheDocument();

    view.rerender(<NativeAgentChatView adapter={adapter(second)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: 'Attachment: old.png' })).not.toBeInTheDocument();
      expect(second).toHaveBeenCalledTimes(1);
    });
    const secondRequest = vi.mocked(second).mock.calls[0]?.[0];
    view.rerender(<NativeAgentChatView adapter={adapter(third)} resolveErrorPresentation={() => null} genericErrorPresentation={genericErrorPresentation} />);
    expect(await screen.findByRole('img', { name: 'Attachment: new.png' })).toBeInTheDocument();
    await act(async () => {
      resolveSecond({
        identity: secondRequest.identity,
        revision: secondRequest.revision,
        attachments: [{
          reference: { contentHash: `sha256:${'f'.repeat(64)}`, filename: 'stale.png', mimeType: 'image/png', size: 1 },
          source: { kind: 'uri', uri: 'content://memeloop/stale' },
        }],
      });
    });
    expect(screen.queryByRole('img', { name: 'Attachment: stale.png' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Attachment: new.png' })).toBeInTheDocument();
  });
});

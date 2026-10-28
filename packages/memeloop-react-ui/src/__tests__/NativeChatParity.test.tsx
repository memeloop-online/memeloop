import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationEditingAdapter, ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAgentChatView, type NativeMemeLoopChatAdapter } from '../native/AgentChatView.js';

const nativeBack = vi.hoisted(() => ({
  platform: { OS: 'web' },
  addEventListener: vi.fn(),
  remove: vi.fn(),
}));

beforeEach(() => {
  nativeBack.platform.OS = 'web';
  nativeBack.addEventListener.mockReset().mockReturnValue({ remove: nativeBack.remove });
  nativeBack.remove.mockReset();
});

vi.mock('react-native', () => {
  const View = ({ children, testID, style, accessibilityElementsHidden, pointerEvents }: {
    children?: React.ReactNode;
    testID?: string;
    style?: React.CSSProperties;
    accessibilityElementsHidden?: boolean;
    pointerEvents?: 'auto' | 'none';
  }) => <div data-testid={testID} style={{ ...style, pointerEvents }} aria-hidden={accessibilityElementsHidden}>{children}</div>;
  return {
    Platform: nativeBack.platform,
    BackHandler: { addEventListener: nativeBack.addEventListener },
    View,
    Text: View,
    Image: View,
    FlatList: () => null,
    I18nManager: { isRTL: false },
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
    Pressable: ({ children, accessibilityLabel, accessibilityState, disabled, onPress, onHoverIn, onHoverOut, testID }: {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      disabled?: boolean;
      onPress?: () => void;
      onHoverIn?: () => void;
      onHoverOut?: () => void;
      testID?: string;
    }) =>
      onPress
        ? <button aria-label={accessibilityLabel} aria-expanded={accessibilityState?.expanded} disabled={disabled} onClick={onPress}>{children}</button>
        : <div data-testid={testID} onMouseEnter={onHoverIn} onMouseLeave={onHoverOut}>{children}</div>,
    Modal: ({ children, visible, onRequestClose }: { children?: React.ReactNode; visible?: boolean; onRequestClose?: () => void }) =>
      visible
        ? (
          <div>
            <button onClick={onRequestClose}>Native back</button>
            {children}
          </div>
        )
        : null,
    TextInput: ({ accessibilityLabel, value, editable, onChangeText, onKeyPress }: {
      accessibilityLabel?: string;
      value?: string;
      editable?: boolean;
      onChangeText?: (value: string) => void;
      onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
    }) => (
      <textarea
        aria-label={accessibilityLabel}
        value={value}
        disabled={editable === false}
        onChange={event => onChangeText?.(event.target.value)}
        onKeyDown={event => onKeyPress?.({ nativeEvent: { key: event.key } })}
      />
    ),
  };
});
vi.mock('react-native-paper', async () => ({
  ...(await import('./nativePaperMock.js')).nativePaperControls,
  useTheme: () => ({ colors: {} }),
}));
vi.mock('react-native-gifted-chat', async () => {
  const { memo } = await import('react');
  type RowProps = {
    currentMessage: { _id: string };
    renderMessageText?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
    renderCustomView?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
    renderBubble?: (props: unknown) => React.ReactNode;
    extraData?: object;
    shouldUpdateMessage?: (previous: { extraData?: object }, next: { extraData?: object }) => boolean;
  };
  // GiftedChat's real Message memo ignores changed rendering callbacks unless
  // its explicit shouldUpdateMessage hook opts this row into an update.
  const Row = memo(
    (props: RowProps) => <div>{props.renderBubble?.(props)}</div>,
    (previous, next) => !next.shouldUpdateMessage?.(previous, next) && previous.currentMessage === next.currentMessage,
  );
  return {
    Bubble: (
      props: {
        currentMessage: { _id: string };
        onPress?: () => void;
        onLongPress?: () => void;
        renderMessageText?: (props: unknown) => React.ReactNode;
        renderCustomView?: (props: unknown) => React.ReactNode;
      },
    ) => (
      <div data-testid={`bubble-${props.currentMessage._id}`} onClick={props.onPress} onContextMenu={props.onLongPress}>
        {props.renderMessageText?.(props)}
        {props.renderCustomView?.(props)}
      </div>
    ),
    GiftedChat: ({ messages, ...props }: {
      messages: { _id: string }[];
      renderMessageText?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
      renderCustomView?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
      renderBubble?: (props: unknown) => React.ReactNode;
      extraData?: object;
      shouldUpdateMessage?: RowProps['shouldUpdateMessage'];
    }) => <div>{messages.map(currentMessage => <Row key={currentMessage._id} currentMessage={currentMessage} {...props} />)}</div>,
  };
});

function message(
  id: string,
  role: ConversationMessageListProjection['role'],
  content: string,
  metadata?: ConversationMessageListProjection['metadata'],
): ConversationMessageListProjection {
  return { messageId: id, conversationId: 'chat', turnId: 'turn', originNodeId: 'node', originSequence: 1, timestamp: 1, lamportClock: 1, role, content, metadata };
}
function fixture(messages = [message('user', 'user', 'Preview')]) {
  let draft: { text: string | null; revision: number } | null = null;
  const editing: ConversationEditingAdapter = {
    loadSource: vi.fn(async () => ({ text: 'Full original message', sourceRevision: 'source', draft })),
    saveDraft: vi.fn(async (_id: string, text: string | null, revision: number) => {
      if (revision !== (draft?.revision ?? 0)) throw new Error('conflict');
      draft = { text, revision: revision + 1 };
      return draft.revision;
    }),
    submit: vi.fn(async () => {}),
    branches: [{ messageId: 'user', selected: 0, alternatives: [{ conversationId: 'chat', messageId: 'user' }, { conversationId: 'branch', messageId: 'variant' }] }],
    switchBranch: vi.fn(async () => {}),
  };
  const adapter: NativeMemeLoopChatAdapter = {
    conversationId: 'chat',
    messages,
    editing,
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    deleteTurn: vi.fn(async () => {}),
    retryTurn: vi.fn(async () => {}),
  };
  const view = () => <NativeAgentChatView adapter={adapter} resolveErrorPresentation={() => null} genericErrorPresentation={{ title: 'Failed', message: 'Retry' }} />;
  return { adapter, editing, view, draft: () => draft };
}

describe('native shared chat parity', () => {
  it('subscribes to Android back only while actions are visible and removes the handler on close or unmount', () => {
    nativeBack.platform.OS = 'android';
    const mounted = render(fixture().view());
    expect(nativeBack.addEventListener).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('bubble-user'));
    expect(nativeBack.addEventListener).toHaveBeenCalledTimes(1);
    expect(nativeBack.addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    const handler = nativeBack.addEventListener.mock.calls[0][1] as () => boolean;
    act(() => {
      expect(handler()).toBe(true);
    });
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    expect(nativeBack.remove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('bubble-user'));
    expect(nativeBack.addEventListener).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(nativeBack.remove).toHaveBeenCalledTimes(2);
  });

  it.each(['web', 'ios'])('does not subscribe to hardware back on %s while preserving hover and explicit close', platform => {
    nativeBack.platform.OS = platform;
    render(fixture().view());
    fireEvent.mouseEnter(screen.getByTestId('message-actions-user'));
    expect(screen.getByTestId('message-actions-toolbar')).toBeVisible();
    fireEvent.mouseLeave(screen.getByTestId('message-actions-user'));
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bubble-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    expect(nativeBack.addEventListener).not.toHaveBeenCalled();
    expect(nativeBack.remove).not.toHaveBeenCalled();
  });

  it('reveals assistant copy and explicit retry on long press without starting a retry or loading an editor', async () => {
    const f = fixture([message('assistant', 'assistant', 'Full assistant response')]);
    const copy = vi.fn(async () => {});
    render(
      <NativeAgentChatView
        adapter={f.adapter}
        onCopyMessage={copy}
        labels={{ copyMessage: '复制', retryTurn: '重试' }}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={{ title: 'Failed', message: 'Retry' }}
      />,
    );
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId('bubble-assistant'));
    fireEvent.contextMenu(screen.getByTestId('bubble-assistant'));
    const toolbar = screen.getByTestId('message-actions-toolbar');
    expect(toolbar).toHaveStyle({ opacity: '1', alignSelf: 'flex-start' });
    expect(f.adapter.retryTurn).not.toHaveBeenCalled();
    expect(f.editing.loadSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Edit and branch' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith(f.adapter.messages[0]);
    });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(f.adapter.retryTurn).toHaveBeenCalledWith('turn');
    });
  });

  it('reveals actions below the bubble on hover or tap without retrying the turn', () => {
    const f = fixture();
    render(f.view());
    expect(screen.queryByRole('button', { name: 'Edit and branch' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId('message-actions-user'));
    const toolbar = screen.getByTestId('message-actions-toolbar');
    expect(toolbar).toContainElement(screen.getByRole('button', { name: 'Edit and branch' }));
    expect(screen.getByTestId('bubble-user')).not.toContainElement(toolbar);
    fireEvent.mouseLeave(screen.getByTestId('message-actions-user'));
    expect(screen.queryByTestId('message-actions-toolbar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bubble-user'));
    expect(screen.getByRole('button', { name: 'Edit and branch' })).toBeVisible();
    expect(f.adapter.retryTurn).not.toHaveBeenCalled();
  });

  it('renders asynchronously loaded branches through GiftedChat memo without replacing the message or losing an open draft', async () => {
    const f = fixture();
    const branches = f.editing.branches;
    f.editing.branches = [];
    const mounted = render(f.view());
    fireEvent.click(screen.getByTestId('bubble-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit and branch' }));
    const editor = await screen.findByRole('textbox');
    fireEvent.change(editor, { target: { value: 'retain draft' } });
    f.adapter.editing = { ...f.editing, branches };
    mounted.rerender(f.view());
    expect(screen.getByRole('button', { name: 'Next history' })).toBeVisible();
    expect(screen.getByRole('textbox')).toBe(editor);
    expect(editor).toHaveValue('retain draft');
  });

  it('delegates copy from the outside toolbar to the host full-content handler', async () => {
    const f = fixture();
    const copy = vi.fn(async () => {});
    render(
      <NativeAgentChatView
        adapter={f.adapter}
        resolveErrorPresentation={() => null}
        genericErrorPresentation={{ title: 'Failed', message: 'Retry' }}
        onCopyMessage={copy}
        labels={{ copyMessage: '复制' }}
      />,
    );
    fireEvent.click(screen.getByTestId('bubble-user'));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith(f.adapter.messages[0]);
    });
    expect(f.editing.loadSource).not.toHaveBeenCalled();
  });

  it('autosaves full-source edits, flushes on back/Escape, discards, sends and switches branches', async () => {
    const f = fixture();
    render(f.view());
    fireEvent.click(screen.getByTestId('bubble-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit and branch' }));
    const input = await screen.findByRole('textbox', { name: 'Edit message' });
    expect(input).toHaveValue('Full original message');
    fireEvent.change(input, { target: { value: 'draft text' } });
    await waitFor(() => {
      expect(f.draft()?.text).toBe('draft text');
    });
    fireEvent.change(input, { target: { value: 'back draft' } });
    fireEvent.click(screen.getByText('Native back'));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(f.draft()?.text).toBe('back draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit and branch' }));
    expect(await screen.findByRole('textbox')).toHaveValue('back draft');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'escape draft' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(f.draft()?.text).toBe('escape draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit and branch' }));
    await screen.findByRole('textbox');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(f.draft()?.text).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit and branch' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'new branch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(f.editing.submit).toHaveBeenCalledWith('user', 'new branch', 'source', f.draft()?.revision);
    });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Next history' }));
    await waitFor(() => {
      expect(f.editing.switchBranch).toHaveBeenCalledWith('branch', 'variant');
    });
  });

  it('shows live status immediately, folds three work levels and keeps final reply visible', () => {
    const f = fixture();
    f.adapter.isRunning = true;
    const mounted = render(f.view());
    expect(screen.getByText('Working…')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bubble-user'));
    expect(screen.getByRole('button', { name: 'Edit and branch' })).toBeDisabled();
    f.adapter.isRunning = false;
    f.adapter.messages = [
      message('user', 'user', 'Question'),
      message('tool1', 'tool', 'first result', { toolActivity: [{ kind: 'result', name: 'search', callId: 'one', input: 'query one' }] }),
      message('tool2', 'tool', 'second result', { toolActivity: [{ kind: 'result', name: 'read', callId: 'two', input: 'path two' }] }),
      message('reply', 'assistant', 'Final answer'),
    ];
    mounted.rerender(f.view());
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText('first result')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Completed work · 2 steps' }));
    fireEvent.click(screen.getByRole('button', { name: '2 tool calls' }));
    expect(screen.queryByText('query one')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    expect(screen.getByText('query one')).toBeInTheDocument();
    expect(screen.getByText('first result')).toBeInTheDocument();
    expect(screen.queryByText('second result')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Completed work · 2 steps' }));
    expect(screen.queryByText('first result')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
  });

  it('keeps tool errors visible rather than hiding them in completed work', () => {
    const f = fixture([
      message('user', 'user', 'Question'),
      message('failure', 'tool', 'Permission required', { toolActivity: [{ kind: 'result', name: 'read', isError: true }] }),
      message('reply', 'assistant', 'Please authorize access'),
    ]);
    render(f.view());
    expect(screen.getByText('Permission required')).toBeInTheDocument();
    expect(screen.getByText('Please authorize access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Completed work/ })).not.toBeInTheDocument();
  });
});

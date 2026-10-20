import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationEditingAdapter, ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NativeAgentChatView, type NativeMemeLoopChatAdapter } from '../native/AgentChatView.js';

vi.mock('react-native', () => {
  const View = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    View,
    Text: View,
    Image: View,
    FlatList: () => null,
    I18nManager: { isRTL: false },
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
    Pressable: ({ children, accessibilityLabel, accessibilityState, disabled, onPress }: {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      disabled?: boolean;
      onPress?: () => void;
    }) => <button aria-label={accessibilityLabel} aria-expanded={accessibilityState?.expanded} disabled={disabled} onClick={onPress}>{children}</button>,
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
vi.mock('react-native-paper', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('react-native-gifted-chat', () => ({
  GiftedChat: ({ messages, renderMessageText, renderCustomView }: {
    messages: { _id: string }[];
    renderMessageText?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
    renderCustomView?: (props: { currentMessage: { _id: string } }) => React.ReactNode;
  }) => <div>{messages.map(currentMessage => <div key={currentMessage._id}>{renderMessageText?.({ currentMessage })}{renderCustomView?.({ currentMessage })}</div>)}</div>,
}));

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
  it('autosaves full-source edits, flushes on back/Escape, discards, sends and switches branches', async () => {
    const f = fixture();
    render(f.view());
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

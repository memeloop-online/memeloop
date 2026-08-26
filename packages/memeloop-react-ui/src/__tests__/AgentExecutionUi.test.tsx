import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentRunFailure, type ChatMessage, createMissingApiKeyAgentRunError } from 'memeloop';
import React, { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentChatView, getConversationError } from '../agent/AgentChatView';
import { ExecutionTargetSelector } from '../agent/ExecutionTargetSelector';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage';
import type { MemeLoopChatAdapter } from '../chat/types';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 'msg-1',
    turnId: 'user-1',
    conversationId: 'conv-1',
    originNodeId: 'node-1',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'assistant',
    content: 'Summary only',
    ...overrides,
  };
}

function createAdapter(messages: readonly ChatMessage[], overrides: Partial<MemeLoopChatAdapter> = {}): MemeLoopChatAdapter {
  return {
    conversationId: messages[0]?.conversationId ?? 'conv-1',
    messages,
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

function DraftComposer() {
  const [draft, setDraft] = useState('');
  return (
    <input
      aria-label='Draft'
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
    />
  );
}

describe('Agent execution UI', () => {
  it('ignores legacy provider strings and preserves only typed error metadata', () => {
    const error = getConversationError([
      assistantMessage({
        role: 'error',
        content: 'provider body with secret sk-legacy',
        metadata: { errorDetail: { name: 'MissingAPIKeyError', message: 'secret legacy diagnostic' } },
      }),
    ]);

    expect(error).toMatchObject({ name: 'Error', message: 'agent-run-failed' });
    expect(error?.message).not.toContain('secret');
  });

  it('carries canonical AgentRunError metadata without parsing message content', () => {
    const agentRunError = createMissingApiKeyAgentRunError({ providerId: 'siliconflow', diagnosticId: 'diagnostic-1' });
    const error = getConversationError([
      assistantMessage({
        role: 'error',
        content: 'untrusted provider response',
        metadata: { agentRunError },
      }),
    ]);

    expect(error).toBeInstanceOf(AgentRunFailure);
    expect((error as AgentRunFailure).agentRunError).toEqual(agentRunError);
  });

  it('does not keep a historical failure active after a successful response', () => {
    const error = getConversationError([
      assistantMessage({ role: 'error', content: 'Previous failure' }),
      assistantMessage({ messageId: 'msg-2', content: 'Recovered' }),
    ]);

    expect(error).toBeNull();
  });

  it('preserves the composer draft across message-only adapter updates', () => {
    const initialAdapter = createAdapter([]);
    const { rerender } = render(
      <AgentChatView adapter={initialAdapter} composerComponent={DraftComposer} />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'Keep this draft' },
    });

    rerender(
      <AgentChatView
        adapter={{ ...initialAdapter, messages: [assistantMessage()] }}
        composerComponent={DraftComposer}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
  });

  it('preserves composer state when host-provided slot identities change', () => {
    const adapter = createAdapter([]);
    const { rerender } = render(
      <AgentChatView
        adapter={adapter}
        composerComponent={DraftComposer}
        composerToolbar={<span>Initial toolbar</span>}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'Keep this host draft' },
    });

    rerender(
      <AgentChatView
        adapter={adapter}
        composerComponent={DraftComposer}
        composerToolbar={<span>Updated toolbar</span>}
        renderAttachmentPicker={() => <button type='button'>Pick</button>}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this host draft');
  });

  it('uses host-localized labels for shared turn actions', () => {
    const user = assistantMessage({ messageId: 'user-1', role: 'user', content: '你好' });
    const assistant = assistantMessage({ messageId: 'assistant-1', content: '您好' });
    render(
      <AgentChatView
        adapter={createAdapter([user, assistant])}
        actionLabels={{
          retry: '重新生成',
          deleteTurn: '删除此轮',
          copy: '复制正文',
          copyAll: '复制全部',
          user: '用户',
          agent: '智能体',
        }}
      />,
    );

    expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除此轮' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制正文' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制全部' })).not.toBeInTheDocument();
  });

  it('delegates complete export to an explicit host streaming/file capability without calling it on mount', async () => {
    const exportConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatView
        adapter={createAdapter([assistantMessage()], { exportConversation })}
        actionLabels={{ copyAll: '导出完整对话' }}
      />,
    );
    expect(exportConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导出完整对话' }));
    await waitFor(() => {
      expect(exportConversation).toHaveBeenCalledTimes(1);
    });
    expect(exportConversation).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it('cancels full exports on supersede, conversation generation, and unmount', async () => {
    const signals: AbortSignal[] = [];
    const abortCounts: number[] = [];
    const exportConversation = vi.fn((options: { signal: AbortSignal }) => {
      const index = signals.length;
      signals.push(options.signal);
      abortCounts[index] = 0;
      options.signal.addEventListener('abort', () => {
        abortCounts[index] += 1;
      });
      return new Promise<void>(() => {});
    });
    const first = assistantMessage({ conversationId: 'conversation-A' });
    const rendered = render(
      <AgentChatView adapter={createAdapter([first], { conversationId: 'conversation-A', exportConversation })} />,
    );
    const action = screen.getByRole('button', { name: 'Copy all' });

    fireEvent.click(action);
    await waitFor(() => {
      expect(exportConversation).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(action);
    await waitFor(() => {
      expect(exportConversation).toHaveBeenCalledTimes(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(abortCounts[0]).toBe(1);

    const second = assistantMessage({ messageId: 'msg-B', turnId: 'turn-B', conversationId: 'conversation-B' });
    rendered.rerender(
      <AgentChatView adapter={createAdapter([second], { conversationId: 'conversation-B', exportConversation })} />,
    );
    await waitFor(() => {
      expect(signals[1]?.aborted).toBe(true);
    });
    expect(abortCounts[1]).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await waitFor(() => {
      expect(exportConversation).toHaveBeenCalledTimes(3);
    });
    rendered.unmount();
    expect(signals[2]?.aborted).toBe(true);
    expect(abortCounts).toEqual([1, 1, 1]);
  });

  it('surfaces non-cancellation full export failures through the shared operation error', async () => {
    const exportConversation = vi.fn().mockRejectedValue(new Error('host export failed'));
    render(
      <AgentChatView
        adapter={createAdapter([assistantMessage()], { exportConversation })}
        operationErrorMessage='Export could not be completed'
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await screen.findByText('Export could not be completed')).toBeInTheDocument();
  });

  it('asks before switching targets while a turn is running and requests restart', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <ExecutionTargetSelector
        targets={[
          { id: 'local', label: 'This device', kind: 'local' },
          { id: 'peer:1', label: 'CLI node', kind: 'remote' },
        ]}
        activeTargetId='local'
        isRunning
        onChange={onChange}
        labels={{
          runOn: '执行位置',
          executionTarget: '执行目标',
          runOnTarget: target => `在${target}执行`,
          confirmTitle: '切换执行目标？',
          confirmDescription: target => `将在${target}重新开始`,
          anotherTarget: '其他目标',
          keepRunning: '继续当前执行',
          stopAndRestart: '停止并重新开始',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '在CLI node执行' }));
    expect(screen.getByText('切换执行目标？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '停止并重新开始' }));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('peer:1', { restartCurrentTurn: true });
    });
  });

  it('loads detailRef content on demand', async () => {
    const loadMessageDetail = vi.fn().mockResolvedValue({ text: 'tool：Full tool output', itemCount: 1, truncated: false });

    render(
      <MemeLoopMessage
        message={assistantMessage({ detailRef: { type: 'agent-run', conversationId: 'remote-conv', nodeId: 'peer-1' } })}
        loadMessageDetail={loadMessageDetail}
        labels={{ loadDetails: '加载完整详情' }}
      />,
    );

    expect(screen.queryByText('tool：Full tool output')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载完整详情' }));

    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1' }),
        expect.objectContaining({ limit: 50, maxBytes: 256 * 1024, signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByText('tool：Full tool output')).toBeInTheDocument();
    });
  });
});

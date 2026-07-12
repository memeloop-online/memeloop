import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { getConversationError } from '../agent/AgentChatView';
import { ExecutionTargetSelector } from '../agent/ExecutionTargetSelector';
import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    originNodeId: 'node-1',
    timestamp: 1,
    lamportClock: 1,
    role: 'assistant',
    content: 'Summary only',
    ...overrides,
  };
}

describe('Agent execution UI', () => {
  it('reads provider failures from canonical error messages', () => {
    const error = getConversationError([
      assistantMessage({
        role: 'error',
        content: 'Error: API key is missing',
        metadata: { errorDetail: { name: 'MissingAPIKeyError', message: 'API key is missing' } },
      }),
    ]);

    expect(error).toMatchObject({ name: 'MissingAPIKeyError', message: 'API key is missing' });
  });

  it('does not keep a historical failure active after a successful response', () => {
    const error = getConversationError([
      assistantMessage({ role: 'error', content: 'Previous failure' }),
      assistantMessage({ messageId: 'msg-2', content: 'Recovered' }),
    ]);

    expect(error).toBeNull();
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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run on CLI node' }));
    expect(screen.getByText('Switch execution target?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop and restart' }));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('peer:1', { restartCurrentTurn: true });
    });
  });

  it('loads detailRef content on demand', async () => {
    const loadMessageDetail = vi.fn().mockResolvedValue([
      assistantMessage({ messageId: 'detail-1', role: 'tool', content: 'Full tool output' }),
    ]);

    render(
      <MemeLoopMessage
        message={assistantMessage({ detailRef: { type: 'agent-run', conversationId: 'remote-conv', nodeId: 'peer-1' } })}
        loadMessageDetail={loadMessageDetail}
      />,
    );

    expect(screen.queryByText('tool: Full tool output')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load details' }));

    await waitFor(() => {
      expect(loadMessageDetail).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1' }));
      expect(screen.getByText('tool: Full tool output')).toBeInTheDocument();
    });
  });
});

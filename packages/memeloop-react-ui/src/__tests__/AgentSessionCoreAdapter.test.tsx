import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentAttachmentInput, AgentSessionController, AgentSessionSnapshot } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentSessionProvider } from '../agent/AgentSessionProvider.js';
import { useAgentSessionChatAdapter } from '../agent/useAgentSessionChatAdapter.js';
import { useAgentSessionCoreAdapter } from '../agent/useAgentSessionCoreAdapter.js';
import type { MemeLoopChatAdapter } from '../chat/coreTypes.js';
import type { WebMemeLoopChatAdapter } from '../chat/types.js';

function initialSnapshot(): AgentSessionSnapshot {
  return {
    agent: null,
    loading: false,
    loadingMoreBefore: false,
    loadingMoreAfter: false,
    error: null,
    messages: [],
    orderedMessageIds: [],
    streamingMessageIds: new Set(),
    hasMoreBefore: true,
    hasMoreAfter: true,
    pendingNewMessageCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeController() {
  let snapshot = initialSnapshot();
  const listeners = new Set<() => void>();
  const before = deferred<undefined>();
  const after = deferred<undefined>();
  const retryTurn = vi.fn().mockResolvedValue(undefined);
  const emit = (patch: Partial<AgentSessionSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadMoreBefore: vi.fn(async () => {
      emit({ loadingMoreBefore: true });
      await before.promise;
      emit({ loadingMoreBefore: false });
    }),
    loadMoreAfter: vi.fn(async () => {
      emit({ loadingMoreAfter: true });
      await after.promise;
      emit({ loadingMoreAfter: false });
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    seekToTurn: vi.fn().mockResolvedValue(undefined),
    seekToTimelineEntry: vi.fn().mockResolvedValue(undefined),
    jumpToLatest: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn,
  } as unknown as AgentSessionController;
  return { after, before, controller, retryTurn, sendMessage: controller.sendMessage as unknown as ReturnType<typeof vi.fn>, emit };
}

describe('useAgentSessionCoreAdapter', () => {
  it('projects before and after loading independently', async () => {
    const fake = fakeController();
    let adapter!: MemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionCoreAdapter({ conversationId: 'conversation', createId: () => 'request' });
      return <span>{`${adapter.isLoadingMoreBefore ? 'before' : '-'}:${adapter.isLoadingMoreAfter ? 'after' : '-'}`}</span>;
    }
    render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );

    let beforeOperation!: Promise<void>;
    act(() => {
      beforeOperation = adapter.loadMoreBefore!();
    });
    expect(screen.getByText('before:-')).toBeInTheDocument();
    await act(async () => {
      fake.before.resolve(undefined);
      await beforeOperation;
    });
    expect(screen.getByText('-:-')).toBeInTheDocument();

    let afterOperation!: Promise<void>;
    act(() => {
      afterOperation = adapter.loadMoreAfter!();
    });
    expect(screen.getByText('-:after')).toBeInTheDocument();
    await act(async () => {
      fake.after.resolve(undefined);
      await afterOperation;
    });
    expect(screen.getByText('-:-')).toBeInTheDocument();
  });

  it('projects durable streaming identities without leaking a mutable Set', () => {
    const fake = fakeController();
    let adapter!: MemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionCoreAdapter({ conversationId: 'conversation', createId: () => 'request' });
      return null;
    }
    render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );

    act(() => {
      fake.emit({ streamingMessageIds: new Set(['streaming-message']) });
    });
    expect(adapter.isMessageStreaming?.('streaming-message')).toBe(true);
    expect(adapter.isMessageStreaming?.('settled-message')).toBe(false);
  });

  it('aborts a Web attachment transform on conversation switch before controller mutation', async () => {
    const fake = fakeController();
    const mapped = deferred<AgentAttachmentInput>();
    let mapperSignal: AbortSignal | undefined;
    let adapter!: WebMemeLoopChatAdapter;
    const mapFile = vi.fn((_file: File, context: { signal: AbortSignal }) => {
      mapperSignal = context.signal;
      return mapped.promise;
    });
    function Consumer({ conversationId }: { conversationId: string }) {
      adapter = useAgentSessionChatAdapter({ conversationId, createId: () => 'request', mapFile });
      return null;
    }
    const rendered = render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer conversationId='A' />
      </AgentSessionProvider>,
    );
    const operation = adapter.sendMessage({ text: 'hello', file: new File(['data'], 'test.txt') });
    await act(async () => Promise.resolve());

    rendered.rerender(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer conversationId='B' />
      </AgentSessionProvider>,
    );
    expect(mapperSignal?.aborted).toBe(true);
    mapped.resolve({} as AgentAttachmentInput);
    await expect(operation).rejects.toThrow('generation changed');
    expect(fake.sendMessage).not.toHaveBeenCalled();
  });

  it('aborts a pending attachment transform on unmount', async () => {
    const fake = fakeController();
    const mapped = deferred<AgentAttachmentInput>();
    let mapperSignal: AbortSignal | undefined;
    let adapter!: WebMemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionChatAdapter({
        conversationId: 'conversation',
        createId: () => 'request',
        mapFile: (_file, context) => {
          mapperSignal = context.signal;
          return mapped.promise;
        },
      });
      return null;
    }
    const rendered = render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );
    const operation = adapter.sendMessage({ text: 'hello', file: new File(['data'], 'test.txt') });
    await act(async () => Promise.resolve());
    rendered.unmount();
    expect(mapperSignal?.aborted).toBe(true);
    mapped.resolve({} as AgentAttachmentInput);
    await expect(operation).rejects.toThrow('disposed');
    expect(fake.sendMessage).not.toHaveBeenCalled();
  });

  it('retries by durable turn identity when the resident window contains only the assistant projection', async () => {
    const fake = fakeController();
    fake.emit({
      messages: [{
        messageId: 'assistant-only',
        turnId: 'durable-turn',
        conversationId: 'conversation',
        originNodeId: 'node',
        originSequence: 1,
        timestamp: 1,
        lamportClock: 1,
        role: 'assistant',
        content: 'bounded assistant projection',
      }],
      orderedMessageIds: ['assistant-only'],
    });
    let nextId = 0;
    let adapter!: MemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionCoreAdapter({
        conversationId: 'conversation',
        createId: () => `id-${String(++nextId)}`,
      });
      return null;
    }
    render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );

    await act(async () => {
      await adapter.retryTurn('durable-turn');
    });
    expect(fake.retryTurn).toHaveBeenCalledWith({
      turnId: 'durable-turn',
      requestId: 'id-1',
      newTurnId: 'id-2',
      definitionId: undefined,
    });
  });

  it('layers host-owned execution targets onto the portable session adapter', async () => {
    const fake = fakeController();
    const setExecutionTarget = vi.fn().mockResolvedValue(undefined);
    const executionTargets = [
      { id: 'local', label: 'This device', kind: 'local' as const },
      { id: 'remote', label: 'Remote device', kind: 'remote' as const },
    ];
    let adapter!: MemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionCoreAdapter({
        conversationId: 'conversation',
        createId: () => 'request',
        executionTargets,
        activeExecutionTargetId: 'remote',
        setExecutionTarget,
      });
      return null;
    }
    render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );

    expect(adapter.executionTargets).toBe(executionTargets);
    expect(adapter.activeExecutionTargetId).toBe('remote');
    await act(async () => {
      await adapter.setExecutionTarget?.('local', { restartCurrentTurn: true });
    });
    expect(setExecutionTarget).toHaveBeenCalledWith('local', { restartCurrentTurn: true });
  });
});

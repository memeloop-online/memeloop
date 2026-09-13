import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentAttachmentInput, AgentSessionController, AgentSessionSnapshot } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentSessionProvider } from '../agent/AgentSessionProvider.js';
import { useAgentSessionChatAdapter } from '../agent/useAgentSessionChatAdapter.js';
import { useAgentSessionCoreAdapter } from '../agent/useAgentSessionCoreAdapter.js';
import type { ConversationTimelineWindowController, ConversationTimelineWindowSnapshot } from '../chat/ConversationTimelineWindowController.js';
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

function fakeTimelineController() {
  let snapshot: ConversationTimelineWindowSnapshot = Object.freeze({
    conversationId: 'conversation',
    loading: true,
    loadingKind: 'initial',
    resetCount: 1,
    error: null,
  });
  const listeners = new Set<() => void>();
  const refreshForRevision = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn();
  const emit = (patch: Partial<ConversationTimelineWindowSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener();
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    refreshForRevision,
  } as unknown as ConversationTimelineWindowController;
  return { controller, emit, refreshForRevision, start };
}

describe('useAgentSessionCoreAdapter', () => {
  it('recovers a missing or stalled timeline page once per revision without an error retry loop', async () => {
    const fake = fakeController();
    const timeline = fakeTimelineController();
    fake.emit({ revision: 'r2' });
    function Consumer({ conversationId }: { conversationId: string }) {
      useAgentSessionCoreAdapter({
        conversationId,
        createId: () => 'request',
        timelineController: timeline.controller,
      });
      return null;
    }
    const rendered = render(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer conversationId='conversation' />
      </AgentSessionProvider>,
    );

    await act(async () => Promise.resolve());
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(1);
    expect(timeline.refreshForRevision).toHaveBeenLastCalledWith('r2', undefined);

    act(() => {
      timeline.emit({
        error: null,
        loading: false,
        loadingKind: null,
        page: Object.freeze({
          reset: false,
          items: [],
          revision: 'r2',
          totalMessages: 0,
          totalTurns: 0,
          totalEntries: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
      });
    });
    await act(async () => Promise.resolve());
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(1);

    act(() => {
      timeline.emit({ page: undefined, loading: false, loadingKind: null, error: new Error('same revision was invalidated after recovery') });
    });
    await act(async () => Promise.resolve());
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(2);
    expect(timeline.refreshForRevision).toHaveBeenLastCalledWith('r2', undefined);

    act(() => {
      timeline.emit({ error: new Error('same revision still unavailable') });
    });
    await act(async () => Promise.resolve());
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(2);

    act(() => {
      fake.emit({ revision: 'r3' });
    });
    await act(async () => Promise.resolve());
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(3);
    expect(timeline.refreshForRevision).toHaveBeenLastCalledWith('r3', undefined);

    rendered.rerender(
      <AgentSessionProvider controller={fake.controller}>
        <Consumer conversationId='next-conversation' />
      </AgentSessionProvider>,
    );
    await act(async () => Promise.resolve());
    expect(timeline.start).toHaveBeenLastCalledWith('next-conversation');
    expect(timeline.refreshForRevision).toHaveBeenCalledTimes(4);
    expect(timeline.refreshForRevision).toHaveBeenLastCalledWith('r3', undefined);
  });

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
      { value: { kind: 'local' as const }, label: 'This device' },
      { value: { kind: 'remote' as const, peerId: 'remote' }, label: 'Remote device' },
    ];
    let adapter!: MemeLoopChatAdapter;
    function Consumer() {
      adapter = useAgentSessionCoreAdapter({
        conversationId: 'conversation',
        createId: () => 'request',
        executionTargets,
        activeExecutionTarget: executionTargets[1].value,
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
    expect(adapter.activeExecutionTarget).toBe(executionTargets[1].value);
    await act(async () => {
      await adapter.setExecutionTarget?.(executionTargets[0].value, { restartCurrentTurn: true });
    });
    expect(setExecutionTarget).toHaveBeenCalledWith(executionTargets[0].value, { restartCurrentTurn: true });
  });
});

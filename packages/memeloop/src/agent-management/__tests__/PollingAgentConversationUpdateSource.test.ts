import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentConversationInvalidation, PollingAgentConversationUpdateSource } from '../PollingAgentConversationUpdateSource.js';
import type { AgentConversationUpdate } from '../types.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PollingAgentConversationUpdateSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('establishes a silent baseline then infers one bounded append invalidation', async () => {
    const readHead = vi.fn()
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 7 })
      .mockResolvedValueOnce({ revision: 'revision-2', totalMessages: 12 });
    const listener = vi.fn<(update: AgentConversationUpdate) => void>();
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 100,
      jitter: interval => interval,
    });

    source.subscribe('conversation-1', listener);
    await settle();
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: 'invalidated',
      conversationId: 'conversation-1',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 5,
    });
    source.dispose();
  });

  it('forwards an external sync invalidation without any Agent status event and re-baselines', async () => {
    let push: ((update: AgentConversationInvalidation) => void) | undefined;
    const unsubscribe = vi.fn();
    const readHead = vi.fn()
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 10 })
      .mockResolvedValueOnce({ revision: 'revision-2', totalMessages: 11 });
    const listener = vi.fn<(update: AgentConversationUpdate) => void>();
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      subscribeInvalidations: (_conversationId, next) => {
        push = next;
        return unsubscribe;
      },
      pollIntervalMs: 100,
    });
    source.subscribe('synced-conversation', listener);
    await settle();

    push?.({
      kind: 'invalidated',
      conversationId: 'synced-conversation',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);

    source.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('aborts a stale conversation read and lets only the latest generation publish', async () => {
    const first = deferred<{ revision: string; totalMessages: number }>();
    const signals: AbortSignal[] = [];
    const readHead = vi.fn().mockImplementation(({ conversationId, signal }) => {
      signals.push(signal);
      if (conversationId === 'conversation-A') return first.promise;
      return Promise.resolve({ revision: 'revision-B1', totalMessages: 20 });
    });
    const listenerA = vi.fn<(update: AgentConversationUpdate) => void>();
    const listenerB = vi.fn<(update: AgentConversationUpdate) => void>();
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 100,
    });

    source.subscribe('conversation-A', listenerA);
    source.subscribe('conversation-B', listenerB);
    expect(signals[0]?.aborted).toBe(true);
    first.resolve({ revision: 'revision-A1', totalMessages: 100_000 });
    await settle();
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(readHead.mock.calls.at(-1)?.[0].conversationId).toBe('conversation-B');
    source.dispose();
  });

  it('releases timers, AbortController work and the precise subscription on stop/dispose', async () => {
    const unsubscribe = vi.fn();
    const signals: AbortSignal[] = [];
    const source = new PollingAgentConversationUpdateSource({
      readHead: vi.fn().mockImplementation(({ signal }) => {
        signals.push(signal);
        return Promise.resolve({ revision: 'revision-1', totalMessages: 1 });
      }),
      subscribeInvalidations: () => unsubscribe,
      pollIntervalMs: 100,
    });
    const stop = source.subscribe('conversation', vi.fn());
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    source.dispose();
    source.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('represents 100,000 logical new messages as one scalar update without resident messages', async () => {
    const readHead = vi.fn()
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 0 })
      .mockResolvedValueOnce({ revision: 'revision-2', totalMessages: 100_000 });
    const updates: AgentConversationUpdate[] = [];
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 100,
    });
    source.subscribe('large-conversation', update => updates.push(update));
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    expect(updates).toEqual([{
      kind: 'invalidated',
      conversationId: 'large-conversation',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 100_000,
    }]);
    expect(Object.keys(updates[0] ?? {})).not.toContain('messages');
    expect(readHead).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('falls back to reset when an inferred append exceeds the public delta bound', async () => {
    const source = new PollingAgentConversationUpdateSource({
      readHead: vi.fn()
        .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 0 })
        .mockResolvedValueOnce({ revision: 'revision-2', totalMessages: 1_000_001 }),
      pollIntervalMs: 100,
    });
    const listener = vi.fn<(update: AgentConversationUpdate) => void>();
    source.subscribe('conversation', listener);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledWith({
      kind: 'invalidated',
      conversationId: 'conversation',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'reset',
    });
    source.dispose();
  });

  it('wakes one matching active conversation without forging a revision', async () => {
    const readHead = vi.fn()
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 1 })
      .mockResolvedValueOnce({ revision: 'revision-2', totalMessages: 2 });
    const listener = vi.fn<(update: AgentConversationUpdate) => void>();
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 10_000,
    });
    source.subscribe('conversation', listener);
    await settle();

    source.wake('conversation');
    await vi.advanceTimersByTimeAsync(0);
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({
      kind: 'invalidated',
      conversationId: 'conversation',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 1,
    });
    source.dispose();
  });

  it('uses a global wake to probe the current subscription', async () => {
    const readHead = vi.fn()
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 1 })
      .mockResolvedValueOnce({ revision: 'revision-1', totalMessages: 1 });
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 10_000,
    });
    source.subscribe('conversation', vi.fn());
    await settle();

    source.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(readHead).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('ignores a wake for an unknown conversation', async () => {
    const readHead = vi.fn().mockResolvedValue({ revision: 'revision-1', totalMessages: 1 });
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 10_000,
    });
    source.subscribe('active-conversation', vi.fn());
    await settle();

    source.wake('unknown-conversation');
    await vi.advanceTimersByTimeAsync(0);
    expect(readHead).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('makes wake a no-op after dispose', async () => {
    const readHead = vi.fn().mockResolvedValue({ revision: 'revision-1', totalMessages: 1 });
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 100,
    });
    source.subscribe('conversation', vi.fn());
    await settle();
    source.dispose();

    source.wake();
    source.wake('conversation');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces a burst of wake notifications into one bounded head read', async () => {
    const readHead = vi.fn().mockResolvedValue({ revision: 'revision-1', totalMessages: 100_000 });
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 10_000,
    });
    source.subscribe('conversation', vi.fn());
    await settle();

    for (let index = 0; index < 1_000; index += 1) source.wake('conversation');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(readHead).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('fences a woken read that resolves after a newer conversation generation', async () => {
    const delayedWake = deferred<{ revision: string; totalMessages: number }>();
    const signals: AbortSignal[] = [];
    const readHead = vi.fn().mockImplementation(({ conversationId, signal }) => {
      signals.push(signal);
      if (conversationId === 'conversation-A' && readHead.mock.calls.length > 1) {
        return delayedWake.promise;
      }
      return Promise.resolve({
        revision: conversationId === 'conversation-A' ? 'revision-A1' : 'revision-B1',
        totalMessages: 1,
      });
    });
    const listenerA = vi.fn<(update: AgentConversationUpdate) => void>();
    const listenerB = vi.fn<(update: AgentConversationUpdate) => void>();
    const source = new PollingAgentConversationUpdateSource({
      readHead,
      pollIntervalMs: 10_000,
    });
    source.subscribe('conversation-A', listenerA);
    await settle();
    source.wake('conversation-A');
    await vi.advanceTimersByTimeAsync(0);

    source.subscribe('conversation-B', listenerB);
    expect(signals[1]?.aborted).toBe(true);
    delayedWake.resolve({ revision: 'revision-A2', totalMessages: 2 });
    await settle();
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
    expect(readHead.mock.calls.at(-1)?.[0].conversationId).toBe('conversation-B');
    source.dispose();
  });
});

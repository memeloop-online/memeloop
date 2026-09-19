import { describe, expect, it } from 'vitest';

import { createContextCompactionBoundary, createContextCompactionBoundaryFromCoverage, effectiveConversationHistory, getContextCompactionBoundary } from '../compactionBoundary.js';
import type { ChatMessage } from '../types.js';

function originHistory(originNodeId: string, count: number, fromSequence = 1): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turnId = '';
  for (let offset = 0; offset < count; offset += 1) {
    const originSequence = fromSequence + offset;
    const role = offset % 2 === 0 ? 'user' as const : 'assistant' as const;
    const messageId = `${originNodeId}-m-${originSequence}`;
    if (role === 'user') turnId = messageId;
    messages.push({
      messageId,
      turnId,
      conversationId: 'conversation',
      originNodeId,
      originSequence,
      timestamp: originSequence,
      lamportClock: originSequence,
      role,
      content: `${role} ${originSequence}`,
    });
  }
  return messages;
}

function summary(
  messageId: string,
  dropped: readonly ChatMessage[],
  originSequence: number,
): ChatMessage {
  const boundary = createContextCompactionBoundary(dropped);
  if (!boundary) throw new Error('test summary requires coverage');
  return {
    messageId,
    turnId: messageId,
    conversationId: 'conversation',
    originNodeId: 'summary-node',
    originSequence,
    timestamp: 10_000 + originSequence,
    lamportClock: 10_000 + originSequence,
    role: 'assistant',
    content: `summary ${messageId}`,
    metadata: { contextCompaction: boundary },
  };
}

describe('context compaction boundaries', () => {
  it('merges incomparable summaries with exact per-origin counts', () => {
    const originA = originHistory('origin-a', 10);
    const originB = originHistory('origin-b', 10);
    const summaryA = summary('summary-a', originA, 1);
    const summaryB = summary('summary-b', originB, 2);

    const merged = createContextCompactionBoundary([summaryA, summaryB]);

    expect(merged).toMatchObject({
      coveredVersion: { 'origin-a': 10, 'origin-b': 10 },
      coveredMessageCountByOrigin: { 'origin-a': 10, 'origin-b': 10 },
      coveredUserTurnCountByOrigin: { 'origin-a': 5, 'origin-b': 5 },
      droppedMessageCount: 20,
      droppedTurnCount: 10,
      previousSummaryMessageIds: ['summary-a', 'summary-b'],
    });
  });

  it('does not double count a repeated merge and counts a late contiguous arrival once', () => {
    const originA = originHistory('origin-a', 10);
    const originB = originHistory('origin-b', 10);
    const firstMerge = summary('summary-merged', [
      summary('summary-a', originA, 1),
      summary('summary-b', originB, 2),
    ], 3);
    const repeated = createContextCompactionBoundary([firstMerge]);
    expect(repeated?.droppedMessageCount).toBe(20);
    expect(repeated?.droppedTurnCount).toBe(10);

    const late = originHistory('origin-a', 1, 11)[0];
    const withLateArrival = createContextCompactionBoundary([firstMerge, late]);
    expect(withLateArrival).toMatchObject({
      coveredVersion: { 'origin-a': 11, 'origin-b': 10 },
      coveredMessageCountByOrigin: { 'origin-a': 11, 'origin-b': 10 },
      droppedMessageCount: 21,
    });
  });

  it('retains incomparable summaries until a later summary dominates both', () => {
    const originA = originHistory('origin-a', 2);
    const originB = originHistory('origin-b', 2);
    const summaryA = summary('summary-a', originA, 1);
    const summaryB = summary('summary-b', originB, 2);
    const incomparable = effectiveConversationHistory([...originA, ...originB, summaryA, summaryB]);
    expect(incomparable.map(message => message.messageId)).toEqual(['summary-a', 'summary-b']);

    const merged = summary('summary-merged', [summaryA, summaryB], 3);
    expect(
      effectiveConversationHistory([
        ...originA,
        ...originB,
        summaryA,
        summaryB,
        merged,
      ]).map(message => message.messageId),
    ).toEqual(['summary-merged']);
    expect(getContextCompactionBoundary(merged)?.droppedMessageCount).toBe(4);
  });

  it('rejects inconsistent counts at an identical per-origin frontier', () => {
    const messages = originHistory('origin-a', 2);
    const first = summary('summary-a', messages, 1);
    const corrupted: ChatMessage = {
      ...summary('summary-b', messages, 2),
      metadata: {
        contextCompaction: {
          ...getContextCompactionBoundary(first),
          coveredMessageCountByOrigin: { 'origin-a': 1 },
          droppedMessageCount: 1,
        },
      },
    };

    expect(() => createContextCompactionBoundary([first, corrupted])).toThrow(
      'conflicting compaction counts',
    );
  });

  it('merges more than 32 incomparable summaries without losing semantic coverage', () => {
    const summaries = Array.from({ length: 40 }, (_, index) => {
      const origin = `origin-${index.toString().padStart(2, '0')}`;
      return summary(`summary-${index.toString().padStart(2, '0')}`, originHistory(origin, 2), index + 1);
    });

    const merged = createContextCompactionBoundary(summaries);

    expect(Object.keys(merged?.coveredVersion ?? {})).toHaveLength(40);
    expect(merged?.droppedMessageCount).toBe(80);
    expect(merged?.droppedTurnCount).toBe(40);
    expect(merged?.previousSummaryMessageIds).toHaveLength(32);
  });

  it('accepts an exact zero-visible-message causal coverage checkpoint', () => {
    expect(createContextCompactionBoundaryFromCoverage({
      coveredVersion: { 'origin-a': 3 },
      coveredMessageCountByOrigin: { 'origin-a': 0 },
      coveredUserTurnCountByOrigin: { 'origin-a': 0 },
    })).toEqual({
      version: 2,
      coveredVersion: { 'origin-a': 3 },
      coveredMessageCountByOrigin: { 'origin-a': 0 },
      coveredUserTurnCountByOrigin: { 'origin-a': 0 },
      droppedMessageCount: 0,
      droppedTurnCount: 0,
    });
  });
});

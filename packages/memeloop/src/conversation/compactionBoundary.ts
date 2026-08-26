import { compareMessageCursor, messageCursor } from '../storage/conversationPaging.js';
import type { ChatMessage } from './types.js';

export const CONTEXT_COMPACTION_METADATA_KEY = 'contextCompaction';

/** Durable, gap-safe semantic coverage for an append-only distributed log. */
export interface ContextCompactionBoundaryV2 {
  version: 2;
  /** Highest contiguous originSequence summarized for each origin. */
  coveredVersion: Record<string, number>;
  /** Exact visible message membership below each per-origin frontier. */
  coveredMessageCountByOrigin: Record<string, number>;
  /** Exact user-rooted turn membership below each per-origin frontier. */
  coveredUserTurnCountByOrigin: Record<string, number>;
  droppedMessageCount: number;
  droppedTurnCount: number;
  previousSummaryMessageIds?: string[];
}

export interface ContextCompactionCoverage {
  coveredVersion: Record<string, number>;
  coveredMessageCountByOrigin: Record<string, number>;
  coveredUserTurnCountByOrigin: Record<string, number>;
}

/**
 * Content-free progress for one bounded compaction slice. Hosts may persist or
 * display this value and use it to schedule a later background slice without
 * receiving any conversation content.
 */
export interface ContextCompactionProgress {
  readonly checkpointRevision?: string;
  readonly processedMessages: number;
  readonly remainingEstimate?: number;
  readonly providerCalls: number;
  readonly workPages: number;
}

const MAX_PREVIOUS_SUMMARY_IDS = 32;

function isCoveredVersion(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(sequence => typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0);
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
}

function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function isContextCompactionBoundaryV2(
  value: unknown,
): value is ContextCompactionBoundaryV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const boundary = value as Partial<ContextCompactionBoundaryV2> & Record<string, unknown>;
  const allowedKeys = new Set([
    'version',
    'coveredVersion',
    'coveredMessageCountByOrigin',
    'coveredUserTurnCountByOrigin',
    'droppedMessageCount',
    'droppedTurnCount',
    'previousSummaryMessageIds',
  ]);
  if (Object.keys(boundary).some(key => !allowedKeys.has(key))) return false;
  if (
    boundary.version !== 2 ||
    !isCoveredVersion(boundary.coveredVersion) ||
    Object.keys(boundary.coveredVersion).length === 0 ||
    !isCountMap(boundary.coveredMessageCountByOrigin) ||
    !isCountMap(boundary.coveredUserTurnCountByOrigin)
  ) return false;
  const origins = new Set(Object.keys(boundary.coveredVersion));
  if (
    Object.keys(boundary.coveredMessageCountByOrigin).some(origin => !origins.has(origin)) ||
    Object.keys(boundary.coveredUserTurnCountByOrigin).some(origin => !origins.has(origin)) ||
    Object.entries(boundary.coveredUserTurnCountByOrigin).some(([origin, count]) => count > (boundary.coveredMessageCountByOrigin?.[origin] ?? 0))
  ) return false;
  const messageCount = sumCounts(boundary.coveredMessageCountByOrigin);
  const turnCount = sumCounts(boundary.coveredUserTurnCountByOrigin);
  if (
    messageCount < 0 ||
    boundary.droppedMessageCount !== messageCount ||
    boundary.droppedTurnCount !== turnCount
  ) return false;
  const previous = boundary.previousSummaryMessageIds;
  return previous === undefined ||
    Array.isArray(previous) &&
      previous.length > 0 &&
      previous.length <= MAX_PREVIOUS_SUMMARY_IDS &&
      new Set(previous).size === previous.length &&
      previous.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256);
}

export function getContextCompactionBoundary(
  message: ChatMessage,
): ContextCompactionBoundaryV2 | undefined {
  const value = message.metadata?.[CONTEXT_COMPACTION_METADATA_KEY];
  return isContextCompactionBoundaryV2(value) ? value : undefined;
}

export function isContextCompactionSummary(message: ChatMessage): boolean {
  return getContextCompactionBoundary(message) !== undefined;
}

function coverageDominates(left: Record<string, number>, right: Record<string, number>): boolean {
  return Object.entries(right).every(([originNodeId, sequence]) => (left[originNodeId] ?? 0) >= sequence);
}

function mergeCoverage(boundaries: readonly ContextCompactionBoundaryV2[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const boundary of boundaries) {
    for (const [originNodeId, sequence] of Object.entries(boundary.coveredVersion)) {
      merged[originNodeId] = Math.max(merged[originNodeId] ?? 0, sequence);
    }
  }
  return merged;
}

function mergeExactCoverage(
  boundaries: readonly ContextCompactionBoundaryV2[],
): ContextCompactionCoverage {
  const result: ContextCompactionCoverage = {
    coveredVersion: {},
    coveredMessageCountByOrigin: {},
    coveredUserTurnCountByOrigin: {},
  };
  for (const boundary of boundaries) {
    for (const [origin, sequence] of Object.entries(boundary.coveredVersion)) {
      const previousSequence = result.coveredVersion[origin] ?? 0;
      const nextMessageCount = boundary.coveredMessageCountByOrigin[origin] ?? 0;
      const nextTurnCount = boundary.coveredUserTurnCountByOrigin[origin] ?? 0;
      if (sequence < previousSequence) continue;
      if (sequence === previousSequence && sequence > 0) {
        if (
          nextMessageCount !== (result.coveredMessageCountByOrigin[origin] ?? 0) ||
          nextTurnCount !== (result.coveredUserTurnCountByOrigin[origin] ?? 0)
        ) throw new Error(`conflicting compaction counts for ${origin}@${sequence}`);
        continue;
      }
      result.coveredVersion[origin] = sequence;
      result.coveredMessageCountByOrigin[origin] = nextMessageCount;
      result.coveredUserTurnCountByOrigin[origin] = nextTurnCount;
    }
  }
  return result;
}

export function contextCompactionCoverageFromSummaries(
  summaries: readonly ChatMessage[],
): ContextCompactionCoverage {
  const boundaries = summaries.map(summary => {
    const boundary = getContextCompactionBoundary(summary);
    if (!boundary) throw new Error(`message ${summary.messageId} is not a v2 compaction summary`);
    return boundary;
  });
  return mergeExactCoverage(boundaries);
}

export function createContextCompactionBoundaryFromCoverage(
  coverage: ContextCompactionCoverage,
  previousSummaryMessageIds: readonly string[] = [],
): ContextCompactionBoundaryV2 {
  // Provenance is diagnostic, while coverage is the semantic truth. Concurrent
  // devices can legitimately produce more summaries than fit in one event, so
  // keep a deterministic bounded sample instead of making compaction wedge.
  const uniquePrevious = [...new Set(previousSummaryMessageIds)].sort().slice(0, MAX_PREVIOUS_SUMMARY_IDS);
  const boundary: ContextCompactionBoundaryV2 = {
    version: 2,
    coveredVersion: { ...coverage.coveredVersion },
    coveredMessageCountByOrigin: { ...coverage.coveredMessageCountByOrigin },
    coveredUserTurnCountByOrigin: { ...coverage.coveredUserTurnCountByOrigin },
    droppedMessageCount: sumCounts(coverage.coveredMessageCountByOrigin),
    droppedTurnCount: sumCounts(coverage.coveredUserTurnCountByOrigin),
    ...(uniquePrevious.length > 0 ? { previousSummaryMessageIds: uniquePrevious } : {}),
  };
  if (!isContextCompactionBoundaryV2(boundary)) {
    throw new Error('invalid exact compaction coverage');
  }
  return boundary;
}

/**
 * Project the audit log into model context. A dominating summary replaces the
 * summaries it semantically includes. Concurrent incomparable summaries are
 * both retained until a later compaction explicitly merges their contents.
 */
export function effectiveConversationHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const summaries = messages.filter(isContextCompactionSummary);
  if (summaries.length === 0) return [...messages];
  const retainedSummaries = summaries.filter(candidate => {
    const candidateBoundary = getContextCompactionBoundary(candidate)!;
    return !summaries.some(other => {
      if (other.messageId === candidate.messageId) return false;
      const otherBoundary = getContextCompactionBoundary(other)!;
      if (!coverageDominates(otherBoundary.coveredVersion, candidateBoundary.coveredVersion)) {
        return false;
      }
      const equivalent = coverageDominates(
        candidateBoundary.coveredVersion,
        otherBoundary.coveredVersion,
      );
      return !equivalent || compareMessageCursor(messageCursor(candidate), messageCursor(other)) < 0;
    });
  }).sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
  const coveredVersion = mergeCoverage(
    retainedSummaries.map(summary => getContextCompactionBoundary(summary)!),
  );
  const tail = messages.filter(message => {
    if (isContextCompactionSummary(message)) return false;
    const sequence = message.originSequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) {
      return true;
    }
    return sequence > (coveredVersion[message.originNodeId] ?? 0);
  });
  return [...retainedSummaries, ...tail];
}

export function createContextCompactionBoundary(
  dropped: readonly ChatMessage[],
): ContextCompactionBoundaryV2 | undefined {
  if (dropped.length === 0) return undefined;
  const previousSummaries = dropped.filter(isContextCompactionSummary);
  const previousBoundaries = previousSummaries.map(summary => getContextCompactionBoundary(summary)!);
  const coverage = mergeExactCoverage(previousBoundaries);
  const coveredVersion = coverage.coveredVersion;
  const previousVersion = { ...coveredVersion };
  const candidates = new Map<string, Set<number>>();
  for (const message of dropped) {
    if (isContextCompactionSummary(message)) continue;
    const sequence = message.originSequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) continue;
    const sequences = candidates.get(message.originNodeId) ?? new Set<number>();
    sequences.add(sequence);
    candidates.set(message.originNodeId, sequences);
  }
  for (const [originNodeId, sequences] of candidates) {
    let frontier = coveredVersion[originNodeId] ?? 0;
    while (sequences.has(frontier + 1)) frontier += 1;
    if (frontier > 0) coveredVersion[originNodeId] = frontier;
  }
  if (Object.keys(coveredVersion).length === 0) return undefined;

  const newlyCovered = dropped.filter(message => {
    if (isContextCompactionSummary(message)) return false;
    const sequence = message.originSequence;
    return typeof sequence === 'number' &&
      sequence > (previousVersion[message.originNodeId] ?? 0) &&
      sequence <= (coveredVersion[message.originNodeId] ?? 0);
  });
  for (const message of newlyCovered) {
    coverage.coveredMessageCountByOrigin[message.originNodeId] = (coverage.coveredMessageCountByOrigin[message.originNodeId] ?? 0) + 1;
    if (message.role === 'user') {
      coverage.coveredUserTurnCountByOrigin[message.originNodeId] = (coverage.coveredUserTurnCountByOrigin[message.originNodeId] ?? 0) + 1;
    }
  }
  return createContextCompactionBoundaryFromCoverage(
    coverage,
    previousSummaries.map(summary => summary.messageId),
  );
}

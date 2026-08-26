import type { ConversationEvent, ConversationEventCursor } from '../conversation/index.js';

/** Highest contiguous originSequence for each conversation+origin pair. */
export type VersionVector = Record<string, number>;

/**
 * Version-vector entries are scoped to one conversation and one message
 * origin. Lamport clocks are allocated per conversation, so a node-wide key
 * would incorrectly hide a new short conversation after a long one was
 * acknowledged.
 */
export function versionVectorKey(conversationId: string, originNodeId: string): string {
  return JSON.stringify([conversationId, originNodeId]);
}

export function parseVersionVectorKey(
  key: string,
): { conversationId: string; originNodeId: string } | undefined {
  try {
    const value: unknown = JSON.parse(key);
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'string' ||
      value[0].length === 0 ||
      typeof value[1] !== 'string' ||
      value[1].length === 0
    ) return undefined;
    return { conversationId: value[0], originNodeId: value[1] };
  } catch {
    return undefined;
  }
}

export interface ConversationMeta {
  conversationId: string;
  title: string;
  lastMessagePreview: string;
  lastMessageTimestamp: number;
  messageCount: number;
  originNodeId: string;
  /** Lamport clock of the origin metadata event; never substitute messageCount. */
  originClock: number;
  definitionId: string;
  instanceDelta?: Record<string, unknown>;
  isUserInitiated: boolean;
  sourceChannel?: {
    channelId: string;
    platform: string;
    imUserId: string;
  };
}

export function isConversationMeta(value: unknown): value is ConversationMeta {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.conversationId === 'string' &&
    typeof o.title === 'string' &&
    typeof o.originNodeId === 'string' &&
    typeof o.originClock === 'number' &&
    typeof o.definitionId === 'string' &&
    typeof o.messageCount === 'number' &&
    typeof o.lastMessageTimestamp === 'number' &&
    typeof o.isUserInitiated === 'boolean'
  );
}

export interface VersionRange {
  conversationId: string;
  originNodeId: string;
  fromExclusive: number;
  toInclusive: number;
}

export function computeMissingVersionRanges(
  currentVersion: VersionVector,
  availableVersion: VersionVector,
): VersionRange[] {
  const ranges: VersionRange[] = [];
  for (const [key, availableClock] of Object.entries(availableVersion)) {
    const identity = parseVersionVectorKey(key);
    if (!identity) continue;
    const currentClock = currentVersion[key] ?? 0;
    if (availableClock > currentClock) {
      ranges.push({ ...identity, fromExclusive: currentClock, toInclusive: availableClock });
    }
  }
  return ranges.sort((left, right) =>
    compareCodeUnits(left.conversationId, right.conversationId) ||
    compareCodeUnits(left.originNodeId, right.originNodeId)
  );
}

export function versionVectorCoversRange(
  vector: VersionVector,
  range: VersionRange,
): boolean {
  const key = versionVectorKey(range.conversationId, range.originNodeId);
  return (vector[key] ?? 0) >= range.toInclusive;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Bounded, forward-only raw event page used by peer anti-entropy. */
export interface ConversationEventSyncPage {
  items: ConversationEvent[];
  /** Cursor of the final returned matching event. */
  nextCursor?: ConversationEventCursor;
}

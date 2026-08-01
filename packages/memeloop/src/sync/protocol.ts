export type VersionVector = Record<string, number>;

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
  originNodeId: string;
  fromExclusive: number;
  toInclusive: number;
}

export function computeMissingVersionRanges(
  currentVersion: VersionVector,
  availableVersion: VersionVector,
): VersionRange[] {
  const ranges: VersionRange[] = [];
  for (const [originNodeId, availableClock] of Object.entries(availableVersion)) {
    const currentClock = currentVersion[originNodeId] ?? 0;
    if (availableClock > currentClock) {
      ranges.push({ originNodeId, fromExclusive: currentClock, toInclusive: availableClock });
    }
  }
  return ranges.sort((left, right) => left.originNodeId.localeCompare(right.originNodeId));
}

export interface ConversationMetadataPage {
  items: ConversationMeta[];
  nextCursor?: string;
}

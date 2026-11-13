import type { ConversationEvent, ConversationEventCursor, ConversationEventPage, DeviceConnectionGrant, VersionRange } from 'memeloop/device-network/portable';
import { assertCanonicalConversationEvents, canonicalConversationEventBytes } from 'memeloop/device-network/portable';
import { SYNC_MESSAGE_PAGE_MAX_BYTES } from './protocolConstants.js';
import { assertOnlyParameterKeys, objectParameter } from './requestParameters.js';

export function canonicalEventBatchParameter(value: unknown): readonly ConversationEvent[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('invalid_sync_events');
  const events: readonly unknown[] = value;
  assertCanonicalConversationEvents(events);
  return events;
}

function isSyncIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    !Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

export function stringParameter(parameters: Record<string, unknown>, key: string): string {
  const value = parameters[key];
  if (!isSyncIdentifier(value)) {
    throw new Error('invalid_sync_params');
  }
  return value;
}

export function nonNegativeIntegerParameter(parameters: Record<string, unknown>, key: string): number {
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid_sync_params');
  }
  return value;
}

export function positiveIntegerParameter(parameters: Record<string, unknown>, key: string): number {
  const value = nonNegativeIntegerParameter(parameters, key);
  if (value === 0) throw new Error('invalid_sync_params');
  return value;
}

export function versionFrontierArrayParameter(
  parameters: Record<string, unknown>,
  key: string,
): Array<{
  conversationId: string;
  originNodeId: string;
  maxContiguousOriginSequence: number;
}> {
  const value = parameters[key];
  if (!Array.isArray(value) || value.length > 128) throw new Error('invalid_sync_frontiers');
  let previous: { conversationId: string; originNodeId: string } | undefined;
  return value.map(item => {
    const frontier = objectParameter(item);
    assertOnlyParameterKeys(frontier, [
      'conversationId',
      'originNodeId',
      'maxContiguousOriginSequence',
    ]);
    const conversationId = stringParameter(frontier, 'conversationId');
    const originNodeId = stringParameter(frontier, 'originNodeId');
    const maxContiguousOriginSequence = positiveIntegerParameter(
      frontier,
      'maxContiguousOriginSequence',
    );
    const cursor = { conversationId, originNodeId };
    if (previous && compareFrontierIdentity(cursor, previous) <= 0) {
      throw new Error('invalid_sync_frontier_order');
    }
    previous = cursor;
    return { ...cursor, maxContiguousOriginSequence };
  });
}

export function versionFrontierCursorParameter(
  parameters: Record<string, unknown>,
  key: string,
): { conversationId: string; originNodeId: string } | undefined {
  if (parameters[key] === undefined) return undefined;
  const cursor = objectParameter(parameters[key]);
  assertOnlyParameterKeys(cursor, ['conversationId', 'originNodeId']);
  return {
    conversationId: stringParameter(cursor, 'conversationId'),
    originNodeId: stringParameter(cursor, 'originNodeId'),
  };
}

export function assertValidStoredFrontierPage(
  value: unknown,
  previous: { conversationId: string; originNodeId: string } | undefined,
  expectedPage: boolean,
): void {
  const page = objectParameter(value);
  assertOnlyParameterKeys(page, ['items', 'nextCursor']);
  if (
    !Array.isArray(page.items) || page.items.length > 128 ||
    !expectedPage && (page.items.length > 0 || page.nextCursor !== undefined)
  ) {
    throw new Error('invalid_stored_frontier_page');
  }
  let last = previous;
  for (const item of page.items) {
    const frontier = objectParameter(item);
    assertOnlyParameterKeys(frontier, [
      'conversationId',
      'originNodeId',
      'maxContiguousOriginSequence',
    ]);
    const current = {
      conversationId: stringParameter(frontier, 'conversationId'),
      originNodeId: stringParameter(frontier, 'originNodeId'),
    };
    positiveIntegerParameter(frontier, 'maxContiguousOriginSequence');
    if (last && compareFrontierIdentity(current, last) <= 0) {
      throw new Error('invalid_stored_frontier_order');
    }
    last = current;
  }
  if (page.nextCursor === undefined) return;
  const cursor = versionFrontierCursorParameter(page, 'nextCursor');
  if (
    !cursor || !last || compareFrontierIdentity(cursor, last) !== 0 ||
    previous && compareFrontierIdentity(cursor, previous) <= 0
  ) {
    throw new Error('storage_frontier_cursor_did_not_advance');
  }
}

function compareFrontierIdentity(
  left: { conversationId: string; originNodeId: string },
  right: { conversationId: string; originNodeId: string },
): number {
  return compareUtf8Bytes(left.conversationId, right.conversationId) ||
    compareUtf8Bytes(left.originNodeId, right.originNodeId);
}

export function booleanParameter(parameters: Record<string, unknown>, key: string): boolean {
  const value = parameters[key];
  if (typeof value !== 'boolean') throw new Error('invalid_sync_params');
  return value;
}

export function versionRangeArrayParameter(
  parameters: Record<string, unknown>,
  key: string,
): VersionRange[] {
  const value = parameters[key];
  if (!Array.isArray(value) || value.length > 256) throw new Error('invalid_sync_ranges');
  return value.map(item => {
    const range = objectParameter(item);
    assertOnlyParameterKeys(range, [
      'conversationId',
      'originNodeId',
      'fromExclusive',
      'toInclusive',
    ]);
    const conversationId = range.conversationId;
    const originNodeId = range.originNodeId;
    const fromExclusive = range.fromExclusive;
    const toInclusive = range.toInclusive;
    if (
      !isSyncIdentifier(conversationId) ||
      !isSyncIdentifier(originNodeId) ||
      typeof fromExclusive !== 'number' || !Number.isSafeInteger(fromExclusive) || fromExclusive < 0 ||
      typeof toInclusive !== 'number' || !Number.isSafeInteger(toInclusive) || toInclusive < fromExclusive
    ) throw new Error('invalid_sync_range');
    return { conversationId, originNodeId, fromExclusive, toInclusive };
  });
}

export function eventCursorParameter(
  parameters: Record<string, unknown>,
  key: string,
): ConversationEventCursor | undefined {
  if (parameters[key] === undefined) return undefined;
  const cursor = objectParameter(parameters[key]);
  assertOnlyParameterKeys(cursor, ['originNodeId', 'originSequence', 'eventId']);
  const originSequence = cursor.originSequence;
  if (
    typeof originSequence !== 'number' || !Number.isSafeInteger(originSequence) ||
    originSequence <= 0
  ) throw new Error('invalid_sync_cursor');
  return {
    originNodeId: stringParameter(cursor, 'originNodeId'),
    originSequence,
    eventId: stringParameter(cursor, 'eventId'),
  };
}

function storedEventCursor(event: ConversationEvent): ConversationEventCursor {
  return {
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    eventId: event.eventId,
  };
}

function compareEventCursor(
  left: ConversationEventCursor,
  right: ConversationEventCursor,
): number {
  return compareUtf8Bytes(left.originNodeId, right.originNodeId) ||
    left.originSequence - right.originSequence ||
    compareUtf8Bytes(left.eventId, right.eventId);
}

function sameEventCursor(
  cursor: ConversationEventCursor,
  previous: ConversationEventCursor | undefined,
): boolean {
  return previous !== undefined && compareEventCursor(cursor, previous) <= 0;
}

export function boundedEventSyncPage(
  page: ConversationEventPage,
  ranges: VersionRange[],
  previousCursor: ConversationEventCursor | undefined,
): { items: ConversationEvent[]; nextCursor?: ConversationEventCursor } {
  if (!Array.isArray(page.items) || page.items.length > 128) {
    throw new Error('invalid_stored_event_page');
  }
  const items: ConversationEvent[] = [];
  let itemBytes = 2;
  let lastScannedCursor = previousCursor;
  let stoppedForBytes = false;
  for (const event of page.items) {
    try {
      assertCanonicalConversationEvents([event]);
    } catch {
      throw new Error('invalid_stored_conversation_event');
    }
    const cursor = storedEventCursor(event);
    const matches = ranges.some(range =>
      event.conversationId === range.conversationId &&
      event.originNodeId === range.originNodeId &&
      event.originSequence > range.fromExclusive &&
      event.originSequence <= range.toInclusive
    );
    if (matches) {
      const eventBytes = canonicalConversationEventBytes(event).byteLength + (items.length > 0 ? 1 : 0);
      if (itemBytes + eventBytes > SYNC_MESSAGE_PAGE_MAX_BYTES) {
        if (items.length === 0) throw new Error('sync_event_too_large');
        stoppedForBytes = true;
        break;
      }
      items.push(event);
      itemBytes += eventBytes;
    }
    lastScannedCursor = cursor;
  }

  const hasMore = stoppedForBytes || page.hasMoreAfter;
  if (!hasMore) return { items };
  if (!lastScannedCursor || sameEventCursor(lastScannedCursor, previousCursor)) {
    throw new Error('storage_event_cursor_did_not_advance');
  }
  return { items, nextCursor: lastScannedCursor };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8Bytes(left: string, right: string): number {
  if (left === right) return 0;
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function conversationIdsParameter(parameters: unknown): ReadonlySet<string> | undefined {
  const value = objectParameter(parameters).conversationIds;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new Error('invalid_sync_conversation_ids');
  const ids = new Set<string>();
  for (const item of value) {
    if (!isSyncIdentifier(item)) {
      throw new Error('invalid_sync_conversation_id');
    }
    ids.add(item);
  }
  return ids;
}

export function conversationIdsForGrant(
  grant: DeviceConnectionGrant | undefined,
  requested: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (!grant) return requested;
  const scope = grant.conversationScope;
  if (scope.mode === 'none') {
    throw new Error('device_grant_conversation_scope_required');
  }
  if (scope.mode === 'all') return requested;
  const allowed = new Set(scope.ids);
  if (requested === undefined) return allowed;
  for (const conversationId of requested) {
    if (!allowed.has(conversationId)) {
      throw new Error('device_grant_conversation_scope_violation');
    }
  }
  return requested;
}

export function requestedConversationIdsForGrant(
  grant: DeviceConnectionGrant | undefined,
  requested: readonly string[] | undefined,
): string[] | undefined {
  const requestedSet = requested === undefined ? undefined : new Set(requested);
  const scoped = conversationIdsForGrant(grant, requestedSet);
  return scoped === undefined ? undefined : [...scoped].sort(compareCodeUnits);
}

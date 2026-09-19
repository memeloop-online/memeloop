import { decodeBase64, encodeBase64 } from '../encoding/base64.js';
import { canonicalJsonString } from '../encoding/canonicalJson.js';

/** One wire version for every bounded conversation projection cursor. */
export const CONVERSATION_PROJECTION_CURSOR_VERSION = 1 as const;

export const CONVERSATION_PROJECTION_CURSOR_LIMITS = Object.freeze(
  {
    encodedCharacters: 2_048,
    decodedBytes: 1_536,
    identifierCharacters: 512,
    revisionCharacters: 512,
    queryDigestCharacters: 128,
    timelineCursorCharacters: 2_048,
  } as const,
);

export interface ConversationListProjectionCursor {
  version: typeof CONVERSATION_PROJECTION_CURSOR_VERSION;
  kind: 'conversation-list';
  revision: string;
  queryDigest: string;
  timestamp: number;
  conversationId: string;
}

export interface TurnListProjectionCursor {
  version: typeof CONVERSATION_PROJECTION_CURSOR_VERSION;
  kind: 'turn-list';
  conversationId: string;
  revision: string;
  timelineCursor: string;
}

export interface TurnDetailProjectionCursor {
  version: typeof CONVERSATION_PROJECTION_CURSOR_VERSION;
  kind: 'turn-detail';
  conversationId: string;
  turnId: string;
  timestamp: number;
  lamportClock: number;
  originNodeId: string;
  messageId: string;
}

export type ConversationProjectionCursor =
  | ConversationListProjectionCursor
  | TurnListProjectionCursor
  | TurnDetailProjectionCursor;

export type ConversationProjectionCursorExpectation =
  | { kind: 'conversation-list'; revision: string; queryDigest: string }
  | { kind: 'turn-list'; conversationId: string; revision?: string }
  | { kind: 'turn-detail'; conversationId: string; turnId: string };

/** Stable fail-closed error shared by all projection hosts. */
export class ConversationProjectionCursorError extends Error {
  public constructor(message = 'conversation_projection_cursor_invalid') {
    super(message);
    this.name = 'ConversationProjectionCursorError';
  }
}

/** Encode canonical JSON inside strict, unpadded RFC 4648 base64url. */
export function encodeConversationProjectionCursor(
  value: ConversationProjectionCursor,
): string {
  assertCursor(value);
  let canonical: string;
  try {
    canonical = canonicalJsonString(value, {
      maxDepth: 8,
      maxNodes: 32,
      maxStringCodeUnits: CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters,
      maxStringBytes: CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters * 4,
      maxBytes: CONVERSATION_PROJECTION_CURSOR_LIMITS.decodedBytes,
    });
  } catch {
    throw new ConversationProjectionCursorError('conversation_projection_cursor_too_large');
  }
  const encoded = encodeBase64(new TextEncoder().encode(canonical), 'url');
  if (encoded.length > CONVERSATION_PROJECTION_CURSOR_LIMITS.encodedCharacters) {
    throw new ConversationProjectionCursorError('conversation_projection_cursor_too_large');
  }
  return encoded;
}

/** Decode and scope-fence a cursor; malformed or non-canonical values are rejected. */
export function decodeConversationProjectionCursor(
  serialized: string,
  expected: ConversationProjectionCursorExpectation,
): ConversationProjectionCursor {
  validateExpectation(expected);
  if (
    typeof serialized !== 'string' ||
    serialized.length < 1 ||
    serialized.length > CONVERSATION_PROJECTION_CURSOR_LIMITS.encodedCharacters ||
    !/^[A-Za-z0-9_-]+$/u.test(serialized)
  ) throw new ConversationProjectionCursorError();

  let decoded: string;
  try {
    const bytes = decodeBase64(serialized, {
      variant: 'url',
      padding: 'optional',
      allowEmpty: false,
      maxBytes: CONVERSATION_PROJECTION_CURSOR_LIMITS.decodedBytes,
    });
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConversationProjectionCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new ConversationProjectionCursorError();
  }
  assertCursor(parsed);
  let canonical: string;
  try {
    canonical = canonicalJsonString(parsed, {
      maxDepth: 8,
      maxNodes: 32,
      maxStringCodeUnits: CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters,
      maxStringBytes: CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters * 4,
      maxBytes: CONVERSATION_PROJECTION_CURSOR_LIMITS.decodedBytes,
    });
  } catch {
    throw new ConversationProjectionCursorError();
  }
  if (canonical !== decoded) throw new ConversationProjectionCursorError();
  assertExpectation(parsed, expected);
  return parsed;
}

function assertCursor(value: unknown): asserts value is ConversationProjectionCursor {
  const cursor = asRecord(value);
  if (cursor.version !== CONVERSATION_PROJECTION_CURSOR_VERSION) {
    throw new ConversationProjectionCursorError();
  }
  if (cursor.kind === 'conversation-list') {
    assertOnlyKeys(cursor, ['version', 'kind', 'revision', 'queryDigest', 'timestamp', 'conversationId']);
    assertBoundedString(cursor.revision, 'revision', CONVERSATION_PROJECTION_CURSOR_LIMITS.revisionCharacters);
    assertBoundedString(cursor.queryDigest, 'queryDigest', CONVERSATION_PROJECTION_CURSOR_LIMITS.queryDigestCharacters);
    assertNonNegativeInteger(cursor.timestamp);
    assertIdentifier(cursor.conversationId);
    return;
  }
  if (cursor.kind === 'turn-list') {
    assertOnlyKeys(cursor, ['version', 'kind', 'conversationId', 'revision', 'timelineCursor']);
    assertIdentifier(cursor.conversationId);
    assertBoundedString(cursor.revision, 'revision', CONVERSATION_PROJECTION_CURSOR_LIMITS.revisionCharacters);
    assertBoundedString(cursor.timelineCursor, 'timelineCursor', CONVERSATION_PROJECTION_CURSOR_LIMITS.timelineCursorCharacters);
    return;
  }
  if (cursor.kind === 'turn-detail') {
    assertOnlyKeys(cursor, ['version', 'kind', 'conversationId', 'turnId', 'timestamp', 'lamportClock', 'originNodeId', 'messageId']);
    assertIdentifier(cursor.conversationId);
    assertIdentifier(cursor.turnId);
    assertNonNegativeInteger(cursor.timestamp);
    assertNonNegativeInteger(cursor.lamportClock);
    assertIdentifier(cursor.originNodeId);
    assertIdentifier(cursor.messageId);
    return;
  }
  throw new ConversationProjectionCursorError();
}

function assertExpectation(
  cursor: ConversationProjectionCursor,
  expected: ConversationProjectionCursorExpectation,
): void {
  if (expected.kind === 'conversation-list') {
    if (
      cursor.kind !== 'conversation-list' ||
      cursor.revision !== expected.revision ||
      cursor.queryDigest !== expected.queryDigest
    ) throw new ConversationProjectionCursorError('conversation_projection_cursor_stale');
    return;
  }
  if (expected.kind === 'turn-list') {
    if (
      cursor.kind !== 'turn-list' ||
      cursor.conversationId !== expected.conversationId ||
      expected.revision !== undefined && cursor.revision !== expected.revision
    ) throw new ConversationProjectionCursorError('conversation_projection_cursor_stale');
    return;
  }
  if (
    cursor.kind !== 'turn-detail' ||
    cursor.conversationId !== expected.conversationId ||
    cursor.turnId !== expected.turnId
  ) throw new ConversationProjectionCursorError('conversation_projection_cursor_stale');
}

function validateExpectation(expected: ConversationProjectionCursorExpectation): void {
  if (expected.kind === 'conversation-list') {
    assertBoundedString(expected.revision, 'revision', CONVERSATION_PROJECTION_CURSOR_LIMITS.revisionCharacters);
    assertBoundedString(expected.queryDigest, 'queryDigest', CONVERSATION_PROJECTION_CURSOR_LIMITS.queryDigestCharacters);
    return;
  }
  assertIdentifier(expected.conversationId);
  if (expected.kind === 'turn-list') {
    if (expected.revision !== undefined) {
      assertBoundedString(expected.revision, 'revision', CONVERSATION_PROJECTION_CURSOR_LIMITS.revisionCharacters);
    }
    return;
  }
  assertIdentifier(expected.turnId);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationProjectionCursorError();
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    throw new ConversationProjectionCursorError();
  }
}

function assertIdentifier(value: unknown): asserts value is string {
  assertBoundedString(value, 'identifier', CONVERSATION_PROJECTION_CURSOR_LIMITS.identifierCharacters);
}

function assertBoundedString(value: unknown, _field: string, maxCharacters: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxCharacters) {
    throw new ConversationProjectionCursorError();
  }
}

function assertNonNegativeInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConversationProjectionCursorError();
  }
}

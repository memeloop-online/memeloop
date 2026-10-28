import type { ScheduledTaskState } from '../agent-management/types.js';
import { decodeBase64, encodeBase64 } from '../encoding/base64.js';
import { canonicalJsonString } from '../encoding/canonicalJson.js';

/** The only wire version emitted by the host-neutral scheduled-task pager. */
export const SCHEDULED_TASK_AGGREGATE_CURSOR_VERSION = 1 as const;

/** Bounds shared by every host that aggregates scheduled-task sources. */
export const SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS = Object.freeze(
  {
    cursorCharacters: 2_048,
    decodedBytes: 1_536,
    agentInstanceIdCharacters: 512,
    scopeCharacters: 1_024,
    maxStates: 5,
    maxSources: 64,
    sourceCursorCharacters: 2_048,
    revisionCharacters: 512,
    positionIdCharacters: 512,
    timestampCharacters: 64,
  } as const,
);

const DEFAULT_STATES: readonly ScheduledTaskState[] = ['active', 'paused'];
const ALLOWED_STATES: ReadonlySet<string> = new Set([
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type ScheduledTaskAggregateCursorPosition =
  | { kind: 'local'; updatedAt: string; id: string }
  | { kind: 'cache'; observedAt: number; id: string };

/** State retained for one source while a host page is in flight. */
export interface ScheduledTaskAggregateCursorSource {
  executionNodeId: string;
  done: boolean;
  /** Opaque source cursor, normally the Core RPC cursor. */
  cursor?: string;
  /** Host-local keyset position when the source is a durable projection. */
  position?: ScheduledTaskAggregateCursorPosition;
  /** Source revision used for optimistic pagination reads. */
  revision?: string;
}

/** Versioned, strict, portable envelope for every host aggregate page. */
export interface ScheduledTaskAggregateCursor {
  version: typeof SCHEDULED_TASK_AGGREGATE_CURSOR_VERSION;
  agentInstanceId: string;
  /** Directory/configuration signature that fences a cursor to one source set. */
  scope: string;
  states: ScheduledTaskState[];
  /** Zero-based source offset. A value equal to sourceCount means exhausted. */
  sourceIndex: number;
  sourceCount: number;
  sources: ScheduledTaskAggregateCursorSource[];
}

export interface ScheduledTaskAggregateCursorExpectation {
  agentInstanceId: string;
  scope: string;
  states: readonly ScheduledTaskState[];
  sourceCount: number;
}

export interface ScheduledTaskAggregatePageController {
  readonly agentInstanceId: string;
  readonly scope: string;
  readonly states: ScheduledTaskState[];
  readonly sourceCount: number;
  initial(): ScheduledTaskAggregateCursor;
  decode(value: string): ScheduledTaskAggregateCursor;
  encodePage(input: {
    sourceIndex: number;
    sources: readonly ScheduledTaskAggregateCursorSource[];
  }): string;
}

/** Stable error used by all host adapters for malformed or stale cursors. */
export class ScheduledTaskAggregateCursorError extends Error {
  public constructor(message = 'scheduled_task_invalid_cursor') {
    super(message);
    this.name = 'ScheduledTaskAggregateCursorError';
  }
}

/** Normalize one state filter and reject duplicates rather than silently changing scope. */
export function normalizeScheduledTaskAggregateStates(
  states: readonly ScheduledTaskState[] | undefined,
): ScheduledTaskState[] {
  const values = states === undefined ? [...DEFAULT_STATES] : [...states];
  if (values.length === 0 || values.length > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.maxStates) {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_states_required');
  }
  const seen = new Set<string>();
  for (const state of values) {
    if (typeof state !== 'string' || !ALLOWED_STATES.has(state) || seen.has(state)) {
      throw new ScheduledTaskAggregateCursorError('scheduled_task_invalid_states');
    }
    seen.add(state);
  }
  return values.sort();
}

/** Create a host page controller with one scope/state policy. */
export function createScheduledTaskAggregatePageController(
  options: ScheduledTaskAggregateCursorExpectation,
): ScheduledTaskAggregatePageController {
  assertIdentifier(options.agentInstanceId, 'agentInstanceId');
  assertBoundedString(options.scope, 'scope', SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.scopeCharacters);
  if (
    !Number.isSafeInteger(options.sourceCount) ||
    options.sourceCount < 1 ||
    options.sourceCount > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.maxSources
  ) {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_invalid_source_count');
  }
  const states = normalizeScheduledTaskAggregateStates(options.states);
  const expected = Object.freeze({
    agentInstanceId: options.agentInstanceId,
    scope: options.scope,
    states,
    sourceCount: options.sourceCount,
  });
  return {
    agentInstanceId: expected.agentInstanceId,
    scope: expected.scope,
    states: [...expected.states],
    sourceCount: expected.sourceCount,
    initial: () => ({
      version: SCHEDULED_TASK_AGGREGATE_CURSOR_VERSION,
      agentInstanceId: expected.agentInstanceId,
      scope: expected.scope,
      states: [...expected.states],
      sourceIndex: 0,
      sourceCount: expected.sourceCount,
      sources: [],
    }),
    decode: value => decodeScheduledTaskAggregateCursor(value, expected),
    encodePage: input =>
      encodeScheduledTaskAggregateCursor({
        version: SCHEDULED_TASK_AGGREGATE_CURSOR_VERSION,
        agentInstanceId: expected.agentInstanceId,
        scope: expected.scope,
        states: [...expected.states],
        sourceIndex: input.sourceIndex,
        sourceCount: expected.sourceCount,
        sources: [...input.sources],
      }),
  };
}

/** Encode a strict cursor as canonical JSON inside unpadded RFC 4648 base64url. */
export function encodeScheduledTaskAggregateCursor(
  value: ScheduledTaskAggregateCursor,
): string {
  assertCursor(value);
  let canonical: string;
  try {
    canonical = canonicalJsonString(value, {
      maxDepth: 8,
      maxNodes: 8_000,
      maxStringCodeUnits: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.sourceCursorCharacters,
      maxStringBytes: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.sourceCursorCharacters * 4,
      maxBytes: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.decodedBytes,
    });
  } catch {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_cursor_too_large');
  }
  const encoded = encodeBase64(new TextEncoder().encode(canonical), 'url');
  if (encoded.length > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.cursorCharacters) {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_cursor_too_large');
  }
  return encoded;
}

/** Decode, canonicalize, validate scope and reject all non-canonical envelopes. */
export function decodeScheduledTaskAggregateCursor(
  serialized: string,
  expected: ScheduledTaskAggregateCursorExpectation,
): ScheduledTaskAggregateCursor {
  assertIdentifier(expected.agentInstanceId, 'agentInstanceId');
  assertBoundedString(expected.scope, 'scope', SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.scopeCharacters);
  if (
    !Number.isSafeInteger(expected.sourceCount) ||
    expected.sourceCount < 1 ||
    expected.sourceCount > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.maxSources
  ) {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_invalid_source_count');
  }
  const states = normalizeScheduledTaskAggregateStates(expected.states);
  if (
    typeof serialized !== 'string' ||
    serialized.length < 1 ||
    serialized.length > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.cursorCharacters ||
    !BASE64URL_PATTERN.test(serialized)
  ) {
    throw new ScheduledTaskAggregateCursorError();
  }
  let decoded: string;
  try {
    const bytes = decodeBase64(serialized, {
      variant: 'url',
      padding: 'optional',
      allowEmpty: false,
      maxBytes: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.decodedBytes,
    });
    decoded = new TextDecoder().decode(bytes);
  } catch {
    throw new ScheduledTaskAggregateCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new ScheduledTaskAggregateCursorError();
  }
  try {
    assertCursor(parsed);
    const canonical = canonicalJsonString(parsed, {
      maxDepth: 8,
      maxNodes: 8_000,
      maxStringCodeUnits: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.sourceCursorCharacters,
      maxStringBytes: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.sourceCursorCharacters * 4,
      maxBytes: SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.decodedBytes,
    });
    if (canonical !== decoded) throw new ScheduledTaskAggregateCursorError();
    const cursor = parsed;
    if (
      cursor.agentInstanceId !== expected.agentInstanceId ||
      cursor.scope !== expected.scope ||
      cursor.sourceCount !== expected.sourceCount ||
      cursor.states.length !== states.length ||
      cursor.states.some((state, index) => state !== states[index])
    ) throw new ScheduledTaskAggregateCursorError('scheduled_task_cursor_stale');
    return cursor;
  } catch (error) {
    if (error instanceof ScheduledTaskAggregateCursorError) throw error;
    throw new ScheduledTaskAggregateCursorError();
  }
}

function assertCursor(value: unknown): asserts value is ScheduledTaskAggregateCursor {
  const cursor = asRecord(value);
  assertOnlyKeys(cursor, [
    'version',
    'agentInstanceId',
    'scope',
    'states',
    'sourceIndex',
    'sourceCount',
    'sources',
  ]);
  if (cursor.version !== SCHEDULED_TASK_AGGREGATE_CURSOR_VERSION) {
    throw new ScheduledTaskAggregateCursorError();
  }
  assertIdentifier(cursor.agentInstanceId, 'agentInstanceId');
  assertBoundedString(cursor.scope, 'scope', SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.scopeCharacters);
  const states = cursor.states;
  if (!Array.isArray(states)) throw new ScheduledTaskAggregateCursorError();
  const normalized = normalizeScheduledTaskAggregateStates(states as ScheduledTaskState[]);
  if (normalized.some((state, index) => state !== states[index])) {
    throw new ScheduledTaskAggregateCursorError('scheduled_task_invalid_states');
  }
  const sourceCount = cursor.sourceCount;
  const sourceIndex = cursor.sourceIndex;
  if (
    typeof sourceCount !== 'number' ||
    !Number.isSafeInteger(sourceCount) ||
    sourceCount < 1 ||
    sourceCount > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.maxSources ||
    typeof sourceIndex !== 'number' ||
    !Number.isSafeInteger(sourceIndex) ||
    sourceIndex < 0 ||
    sourceIndex > sourceCount
  ) throw new ScheduledTaskAggregateCursorError();
  const sources = cursor.sources;
  if (!Array.isArray(sources) || sources.length > sourceCount) {
    throw new ScheduledTaskAggregateCursorError();
  }
  const sourceIds = new Set<string>();
  for (const source of sources) {
    assertSource(source);
    if (sourceIds.has(source.executionNodeId)) throw new ScheduledTaskAggregateCursorError();
    sourceIds.add(source.executionNodeId);
  }
}

function assertSource(value: unknown): asserts value is ScheduledTaskAggregateCursorSource {
  const source = asRecord(value);
  assertKnownKeys(source, ['executionNodeId', 'done', 'cursor', 'position', 'revision']);
  assertIdentifier(source.executionNodeId, 'source.executionNodeId');
  if (typeof source.done !== 'boolean') throw new ScheduledTaskAggregateCursorError();
  optionalBoundedString(
    source.cursor,
    'source.cursor',
    SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.sourceCursorCharacters,
  );
  optionalBoundedString(
    source.revision,
    'source.revision',
    SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.revisionCharacters,
  );
  if (source.position !== undefined) assertPosition(source.position);
}

function assertPosition(value: unknown): asserts value is ScheduledTaskAggregateCursorPosition {
  const position = asRecord(value);
  if (position.kind === 'local') {
    assertOnlyKeys(position, ['kind', 'updatedAt', 'id']);
    assertCanonicalDate(position.updatedAt, 'source.position.updatedAt');
    assertBoundedString(position.id, 'source.position.id', SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.positionIdCharacters);
    return;
  }
  if (position.kind === 'cache') {
    assertOnlyKeys(position, ['kind', 'observedAt', 'id']);
    const observedAt = position.observedAt;
    if (typeof observedAt !== 'number' || !Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new ScheduledTaskAggregateCursorError();
    }
    assertBoundedString(position.id, 'source.position.id', SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.positionIdCharacters);
    return;
  }
  throw new ScheduledTaskAggregateCursorError();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledTaskAggregateCursorError();
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    throw new ScheduledTaskAggregateCursorError();
  }
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).some(key => !expected.has(key))) {
    throw new ScheduledTaskAggregateCursorError();
  }
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  assertBoundedString(value, field, SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.agentInstanceIdCharacters);
}

function assertBoundedString(value: unknown, _field: string, maxCharacters: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxCharacters) {
    throw new ScheduledTaskAggregateCursorError();
  }
}

function optionalBoundedString(value: unknown, field: string, maxCharacters: number): void {
  if (value !== undefined) assertBoundedString(value, field, maxCharacters);
}

function assertCanonicalDate(value: unknown, _field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > SCHEDULED_TASK_AGGREGATE_CURSOR_LIMITS.timestampCharacters) {
    throw new ScheduledTaskAggregateCursorError();
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new ScheduledTaskAggregateCursorError();
  }
  if (canonical !== value) throw new ScheduledTaskAggregateCursorError();
}

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';

import {
  assertAtomicAgentRetryResult,
  assertAtomicAgentRetrySourceMessage,
  assertCanonicalConversationEventDraft,
  assertCanonicalConversationEventDrafts,
  boundConversationTimelineTurnEntry,
  canonicalConversationEventBytes,
  CanonicalJsonError,
  canonicalJsonString,
  conversationEventToMessage,
  createAtomicAgentRetryEventDrafts,
  createAtomicAgentRetryReplacementPayload,
  digestAtomicAgentRetryPayload,
  MAX_CONVERSATION_EVENT_BYTES,
  messageCursor,
  messageToConversationEvent,
  normalizeAgentRunError,
  normalizeCanonicalConversationEvent,
  normalizeCanonicalConversationEvents,
  OrchestrationError,
  PERMISSIONS_TABLE_DDL,
  projectConversationMessageForList,
} from 'memeloop';
import type {
  AgentDefinition,
  AgentDeviceRpcGetTurnDetailRequest,
  AgentDeviceRpcGetTurnDetailResponse,
  AgentDeviceRpcListConversationsRequest,
  AgentDeviceRpcListConversationsResponse,
  AgentDeviceRpcListTurnsRequest,
  AgentDeviceRpcListTurnsResponse,
  AgentInstanceMeta,
  AgentRunRecord,
  AgentRunState,
  AgentRuntimeRpcCollectionQueryContext,
  AgentRuntimeRpcProjectionStore,
  AgentRuntimeRpcReadContext,
  AtomicAgentRetryInput,
  AtomicAgentRetryResult,
  AtomicAgentRetryStore,
  AttachmentReference,
  ChatMessage,
  CompactionCandidatePage,
  ConversationEvent,
  ConversationEventDraft,
  ConversationEventPage,
  ConversationListPage,
  ConversationListPageCallOptions,
  ConversationMessageCursor,
  ConversationMessageDetailRange,
  ConversationMessageIdentity,
  ConversationMessagePage,
  ConversationMessageWindowResult,
  ConversationMessageWindowSuccess,
  ConversationMeta,
  ConversationReadCallOptions,
  ConversationTimelineEntry,
  ConversationTimelinePage,
  ConversationTimelinePageCallOptions,
  ConversationTimelineParticipantPreview,
  GetCompactionCandidatePageOptions,
  GetConversationEventPageOptions,
  GetConversationListPageOptions,
  GetConversationMessageWindowAroundOptions,
  GetConversationTimelinePageOptions,
  GetMessagePageOptions,
  GetMessagesOptions,
  GetRetainedCompactionControlsOptions,
  IAgentStorage,
  IMChannelBinding,
  MessageVersionFrontier,
  RetainedCompactionControlPage,
  ScheduledAgentTaskStore,
  ScheduledTask,
  ScheduledTaskExecutionIdentity,
  ScheduledTaskExecutionPatch,
  ScheduledTaskExecutionStore,
  ScheduledTaskRpcCreateInput,
  ScheduledTaskRpcDeleteRequest,
  ScheduledTaskRpcGetRequest,
  ScheduledTaskRpcListRequest,
  ScheduledTaskRpcListResponse,
  ScheduledTaskRpcStoreContext,
  ScheduledTaskRpcUpdateRequest,
} from 'memeloop';
import { AgentRunRequestConflictError } from 'memeloop';

interface ConversationRow {
  conversationId: string;
  title: string;
  lastMessagePreview: string;
  lastMessageTimestamp: number;
  messageCount: number;
  originNodeId: string;
  originSequence: number;
  originClock: number;
  definitionId: string;
  instanceDeltaJson: string | null;
  isUserInitiated: number;
  sourceChannelJson: string | null;
}

interface MessageRow {
  messageId: string;
  conversationId: string;
  originNodeId: string;
  originSequence: number;
  turnId: string;
  timestamp: number;
  lamportClock: number;
  role: string;
  content: string;
  partsJson: string | null;
  toolCallsJson: string | null;
  attachmentsJson: string | null;
  detailRefJson: string | null;
  reasoningContent: string | null;
  contentType: string | null;
  hidden: number | null;
  duration: number | null;
  metadataJson: string | null;
  canonicalBytes: number;
  canonicalJson: string | null;
}

interface TimelineEntryRow {
  entryId: string;
  cursor: string;
  conversationId: string;
  timestamp: number;
  lamportClock: number;
  originNodeId: string;
  kind: 'turn' | 'compaction';
  turnId: string;
  userPreview: string | null;
  participantPreviewsJson: string;
  responseCount: number;
  entryOrdinal: number;
  turnOrdinal: number;
  summaryPreview: string | null;
  compactedMessageCount: number | null;
  compactedTurnCount: number | null;
}

const REBUILD_TIMELINE_ORDINALS_V2_SQL = `
  WITH ranked AS (
    SELECT entryId,
      ROW_NUMBER() OVER (
        PARTITION BY conversationId
        ORDER BY timestamp, lamportClock, originNodeId, entryId
      ) - 1 AS entryOrdinal,
      COALESCE(SUM(CASE WHEN kind = 'turn' THEN 1 ELSE 0 END) OVER (
        PARTITION BY conversationId
        ORDER BY timestamp, lamportClock, originNodeId, entryId
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0) AS turnOrdinal
    FROM conversation_timeline_entries_v2
    WHERE ? IS NULL OR conversationId = ?
  )
  UPDATE conversation_timeline_entries_v2 AS entry
  SET entryOrdinal = ranked.entryOrdinal,
      turnOrdinal = ranked.turnOrdinal
  FROM ranked
  WHERE entry.entryId = ranked.entryId
`;

interface AttachmentRow {
  contentHash: string;
  filename: string;
  mimeType: string;
  size: number;
  data: Buffer;
}

interface AgentRunRow {
  runId: string;
  conversationId: string;
  definitionId: string;
  turnId: string;
  requestPeerId: string;
  requestId: string;
  payloadDigest: string;
  retrySourceTurnId: string | null;
  state: AgentRunState;
  acceptedAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequestedAt: number | null;
  error: string | null;
}

interface ScheduledTaskRow {
  taskId: string;
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  scheduleJson: string;
  payloadJson: string | null;
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
  enabled: number;
  createdBy: string | null;
  state: ScheduledTask['state'];
  executionNodeId: string;
  executionNodeLabel: string | null;
  originNodeId: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledTask['lastRunStatus'] | null;
  lastError: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  runCount: number;
  maxRuns: number | null;
  deleteAfterRun: number;
  executionRevision: number;
  occurrenceId: string | null;
  occurrenceScheduledFor: string | null;
  occurrenceAttempt: number;
}

function canonicalJson(value: unknown): string {
  try {
    return canonicalJsonString(value, {
      maxDepth: 64,
      maxNodes: 200_000,
      maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
      maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
      maxBytes: MAX_CONVERSATION_EVENT_BYTES,
    });
  } catch (error) {
    if (!(error instanceof CanonicalJsonError)) throw error;
    throw new OrchestrationError({
      code: 'INVALID',
      message: `invalid canonical conversation JSON: ${error.code}`,
      retryable: false,
    });
  }
}

function canonicalMessageJson(message: ChatMessage): string {
  const event = normalizeCanonicalConversationEvent(messageToConversationEvent(message));
  if (event.kind !== 'message') throw new Error('canonical message normalized to non-message event');
  return canonicalJson(conversationEventToMessage(event));
}

function serializedCanonicalConversationEvent(value: unknown): string {
  try {
    return Buffer.from(canonicalConversationEventBytes(value)).toString('utf8');
  } catch (error) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'invalid canonical conversation event',
      retryable: false,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function parseStoredConversationEvent(serialized: string): ConversationEvent {
  let value: unknown;
  try {
    value = normalizeCanonicalConversationEvent(JSON.parse(serialized));
  } catch (error) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'stored conversation event failed canonical validation',
      retryable: false,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  return value as ConversationEvent;
}

interface ConversationListCursorPayload {
  v: 1;
  revision: string;
  queryDigest: string;
  timestamp: number;
  conversationId: string;
}

function conversationListQueryDigest(query: GetConversationListPageOptions['query']): string {
  return createHash('sha256').update(canonicalJson(query ?? {}), 'utf8').digest('base64url');
}

function encodeConversationListCursor(payload: ConversationListCursorPayload): string {
  return Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
}

function decodeConversationListCursor(
  encoded: string,
  expectedRevision: string,
  expectedQueryDigest: string,
): ConversationListCursorPayload | undefined {
  if (encoded.length === 0 || encoded.length > 2_048) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ConversationListCursorPayload> & Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !== 'conversationId,queryDigest,revision,timestamp,v' ||
      value.v !== 1 ||
      value.revision !== expectedRevision ||
      value.queryDigest !== expectedQueryDigest ||
      typeof value.conversationId !== 'string' ||
      value.conversationId.length === 0 ||
      Buffer.byteLength(value.conversationId, 'utf8') > 512 ||
      !Number.isSafeInteger(value.timestamp) ||
      value.timestamp! < 0 ||
      encodeConversationListCursor(value as ConversationListCursorPayload) !== encoded
    ) return undefined;
    return value as ConversationListCursorPayload;
  } catch {
    return undefined;
  }
}

import { acquireWriterLease, type WriterLease } from './writerLease.js';

const MAX_CONVERSATION_MESSAGE_PAGE_SIZE = 80;
const MAX_CONVERSATION_MESSAGE_PAGE_BYTES = 4 * 1024 * 1024;

export interface SQLiteAgentStorageOptions {
  /**
   * SQLite 文件路径，默认使用内存数据库（测试友好）。
   */
  filename?: string;
  /**
   * Injected single-writer lease (tests/control plane). When omitted, a file-
   * backed database acquires its own lease from the process registry.
   */
  lease?: WriterLease;
  /**
   * Absolute path to the host-provided better-sqlite3 N-API addon.
   * Electron embedders should set this to the binary copied into Resources.
   */
  nativeBinding?: string;
}

export class SQLiteAgentStorage implements IAgentStorage, AtomicAgentRetryStore, ScheduledTaskExecutionStore {
  private db: Database.Database;
  private lease?: WriterLease;
  private readonly ownsLease: boolean;
  private readonly nativeBinding?: string;
  private readonly upsertConversationForAppend: Database.Statement;
  private readonly insertMessage: Database.Statement;
  private readonly insertTimelineTurnV2: Database.Statement;
  private readonly upsertTimelineMessageStateV2: Database.Statement;
  private readonly refreshTimelineResponsesV2: Database.Statement;
  private rebuildTimelineOrdinalsV2?: Database.Statement;
  private readonly bumpConversationListRevisionStatement: Database.Statement;
  private readonly refreshConversationProjectionV2Statement: Database.Statement;
  private readonly insertConversationEvent: Database.Statement;
  private readonly conversationEventById: Database.Statement;
  private readonly conversationEventBySequence: Database.Statement;
  private readonly eventSequenceState: Database.Statement;
  private readonly recoverEventSequence: Database.Statement;
  private readonly advanceEventFrontier: Database.Statement;
  private readonly maxEventLamportClock: Database.Statement;
  private readonly insertTurnTombstone: Database.Statement;
  private readonly turnIsTombstoned: Database.Statement;
  private readonly tombstonedTurnCounts: Database.Statement;
  private readonly conversationById: Database.Statement;
  private readonly ensureConversationForEvent: Database.Statement;
  private readonly refreshConversationAfterTombstone: Database.Statement;
  private readonly insertConversationAttachmentReference: Database.Statement;

  constructor(options: SQLiteAgentStorageOptions = {}) {
    const filename = options.filename ?? ':memory:';
    this.nativeBinding = options.nativeBinding;
    this.db = new Database(filename, { nativeBinding: this.nativeBinding });
    if (options.lease) {
      this.lease = options.lease;
      this.ownsLease = false;
    } else if (filename !== ':memory:') {
      // Fenced single writer: a second opener for the same file gets CONFLICT.
      this.lease = acquireWriterLease(filename, this.nativeBinding);
      this.ownsLease = true;
    } else {
      this.ownsLease = false;
    }
    this.db.function('memeloop_writer_token', { deterministic: true }, () => this.lease?.token ?? 0);
    this.db.function('memeloop_raise_stale_epoch', () => {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `writer lease for this database was lost (fencing token ${this.lease?.token ?? 0})`,
        retryable: false,
      });
    });
    this.db.function('memeloop_timeline_preview', { deterministic: true }, (content: unknown) => this.timelinePreview(content));
    this.db.function(
      'memeloop_timeline_cursor',
      { deterministic: true },
      (originNodeId: unknown, originSequence: unknown, eventId: unknown) => {
        if (
          typeof originNodeId !== 'string' ||
          typeof eventId !== 'string' ||
          typeof originSequence !== 'number' ||
          !Number.isSafeInteger(originSequence) || originSequence <= 0
        ) throw new Error('invalid_timeline_cursor_components');
        return this.timelineCursor(originNodeId, originSequence, eventId);
      },
    );
    this.migrate();
    this.rebuildTimelineOrdinalsV2 = this.db.prepare(REBUILD_TIMELINE_ORDINALS_V2_SQL);
    if (this.lease) this.installFencingTriggers();
    // Prepare the two statements on the append hot path once. better-sqlite3
    // statements remain valid for the lifetime of their owning connection.
    this.upsertConversationForAppend = this.db.prepare(
      `
      INSERT INTO conversations (
        conversationId, title, lastMessagePreview, lastMessageTimestamp, messageCount,
        originNodeId, originClock, definitionId, instanceDeltaJson, isUserInitiated, sourceChannelJson
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversationId) DO UPDATE SET
        lastMessagePreview = excluded.lastMessagePreview,
        lastMessageTimestamp = excluded.lastMessageTimestamp,
        messageCount = conversations.messageCount + 1,
        originNodeId = excluded.originNodeId,
        originClock = excluded.originClock;
    `,
    );
    this.insertMessage = this.db.prepare(
      `
      INSERT INTO messages (
        messageId, conversationId, originNodeId, originSequence, turnId, timestamp, lamportClock,
        role, content, partsJson, toolCallsJson, attachmentsJson, detailRefJson,
        reasoningContent, contentType, hidden, duration, metadataJson, canonicalBytes, canonicalJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    );
    this.insertTimelineTurnV2 = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_timeline_entries_v2 (
        entryId, cursor, conversationId, timestamp, lamportClock, originNodeId,
        kind, turnId, userPreview
      ) VALUES (?, ?, ?, ?, ?, ?, 'turn', ?, ?)
    `);
    this.upsertTimelineMessageStateV2 = this.db.prepare(`
      INSERT INTO conversation_timeline_state_v2 (
        conversationId, revision, totalMessages, totalTurns, totalEntries
      ) VALUES (?, 1, 1, ?, ?)
      ON CONFLICT(conversationId) DO UPDATE SET
        revision = revision + 1,
        totalMessages = totalMessages + 1,
        totalTurns = totalTurns + excluded.totalTurns,
        totalEntries = totalEntries + excluded.totalEntries
    `);
    this.refreshTimelineResponsesV2 = this.db.prepare(`
      UPDATE conversation_timeline_entries_v2
      SET responseCount = (
        SELECT COUNT(*)
        FROM messages AS candidate
        JOIN conversation_events AS source
          ON source.conversationId = candidate.conversationId
         AND source.eventId = candidate.messageId AND source.kind = 'message'
        WHERE candidate.conversationId = conversation_timeline_entries_v2.conversationId
          AND candidate.turnId = conversation_timeline_entries_v2.turnId
          AND candidate.role IN ('assistant', 'agent')
          AND (candidate.hidden IS NULL OR candidate.hidden = 0)
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS tombstone
            WHERE tombstone.conversationId = candidate.conversationId
              AND tombstone.turnId = candidate.turnId
          )
      ), participantPreviewsJson = COALESCE((
        WITH ranked AS (
          SELECT candidate.*,
            ROW_NUMBER() OVER (
              ORDER BY candidate.timestamp, candidate.lamportClock,
                       candidate.originNodeId, candidate.messageId
            ) AS responseRank,
            COUNT(*) OVER () AS responseTotal
          FROM messages AS candidate
          JOIN conversation_events AS source
            ON source.conversationId = candidate.conversationId
           AND source.eventId = candidate.messageId AND source.kind = 'message'
          WHERE candidate.conversationId = conversation_timeline_entries_v2.conversationId
            AND candidate.turnId = conversation_timeline_entries_v2.turnId
            AND candidate.role IN ('assistant', 'agent')
            AND (candidate.hidden IS NULL OR candidate.hidden = 0)
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = candidate.conversationId
                AND tombstone.turnId = candidate.turnId
            )
        )
        SELECT json_group_array(json(previewJson))
        FROM (
          SELECT json_object(
            'actorId', COALESCE(
              NULLIF(json_extract(metadataJson, '$.actorId'), ''),
              NULLIF(json_extract(metadataJson, '$.agentId'), ''), originNodeId
            ),
            'actorLabel', COALESCE(
              NULLIF(json_extract(metadataJson, '$.actorLabel'), ''),
              NULLIF(json_extract(metadataJson, '$.agentName'), ''),
              NULLIF(json_extract(metadataJson, '$.actorId'), ''),
              NULLIF(json_extract(metadataJson, '$.agentId'), ''), originNodeId
            ),
            'role', role,
            'preview', memeloop_timeline_preview(content)
          ) AS previewJson
          FROM ranked
          WHERE responseRank <= 2 OR responseRank > responseTotal - 2
          ORDER BY responseRank
        )
      ), '[]')
      WHERE conversationId = ? AND (? IS NULL OR turnId = ?) AND kind = 'turn'
    `);
    this.bumpConversationListRevisionStatement = this.db.prepare(`
      UPDATE conversation_list_state_v2 SET revision = revision + 1 WHERE id = 1
    `);
    this.refreshConversationProjectionV2Statement = this.db.prepare(`
      UPDATE conversations SET
        messageCount = (
          SELECT COUNT(*) FROM messages AS message
          JOIN conversation_events AS source
            ON source.conversationId = message.conversationId
           AND source.eventId = message.messageId AND source.kind = 'message'
          WHERE message.conversationId = conversations.conversationId
            AND (message.hidden IS NULL OR message.hidden = 0)
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = message.conversationId
                AND tombstone.turnId = message.turnId
            )
        ),
        lastMessagePreview = COALESCE((
          SELECT substr(message.content, 1, 200) FROM messages AS message
          JOIN conversation_events AS source
            ON source.conversationId = message.conversationId
           AND source.eventId = message.messageId AND source.kind = 'message'
          WHERE message.conversationId = conversations.conversationId
            AND (message.hidden IS NULL OR message.hidden = 0)
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = message.conversationId
                AND tombstone.turnId = message.turnId
            )
          ORDER BY message.timestamp DESC, message.lamportClock DESC,
                   message.originNodeId DESC, message.messageId DESC LIMIT 1
        ), ''),
        lastMessageTimestamp = COALESCE((
          SELECT message.timestamp FROM messages AS message
          JOIN conversation_events AS source
            ON source.conversationId = message.conversationId
           AND source.eventId = message.messageId AND source.kind = 'message'
          WHERE message.conversationId = conversations.conversationId
            AND (message.hidden IS NULL OR message.hidden = 0)
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = message.conversationId
                AND tombstone.turnId = message.turnId
            )
          ORDER BY message.timestamp DESC, message.lamportClock DESC,
                   message.originNodeId DESC, message.messageId DESC LIMIT 1
        ), 0),
        originClock = MAX(originClock, COALESCE((
          SELECT MAX(event.lamportClock) FROM conversation_events AS event
          WHERE event.conversationId = conversations.conversationId
        ), 0))
      WHERE conversationId = ?
    `);
    this.insertConversationEvent = this.db.prepare(`
      INSERT INTO conversation_events (
        eventId, conversationId, originNodeId, originSequence, lamportClock,
        timestamp, kind, turnId, eventJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(eventId) DO NOTHING
    `);
    this.conversationEventById = this.db.prepare(`
      SELECT eventJson FROM conversation_events WHERE eventId = ?
    `);
    this.conversationEventBySequence = this.db.prepare(`
      SELECT eventId FROM conversation_events
      WHERE conversationId = ? AND originNodeId = ? AND originSequence = ?
    `);
    this.eventSequenceState = this.db.prepare(`
      SELECT lastSequence, contiguousFrontier
      FROM conversation_event_sequences
      WHERE conversationId = ? AND originNodeId = ?
    `);
    this.recoverEventSequence = this.db.prepare(`
      INSERT INTO conversation_event_sequences (
        conversationId, originNodeId, lastSequence, contiguousFrontier
      ) VALUES (?, ?, ?, 0)
      ON CONFLICT(conversationId, originNodeId) DO UPDATE SET
        lastSequence = MAX(lastSequence, excluded.lastSequence)
    `);
    this.advanceEventFrontier = this.db.prepare(`
      UPDATE conversation_event_sequences AS state
      SET contiguousFrontier = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM conversation_events AS first
          WHERE first.conversationId = state.conversationId
            AND first.originNodeId = state.originNodeId
            AND first.originSequence = state.contiguousFrontier + 1
        ) THEN state.contiguousFrontier
        ELSE COALESCE((
          SELECT MIN(candidate.originSequence)
          FROM conversation_events AS candidate
          WHERE candidate.conversationId = state.conversationId
            AND candidate.originNodeId = state.originNodeId
            AND candidate.originSequence > state.contiguousFrontier
            AND NOT EXISTS (
              SELECT 1 FROM conversation_events AS successor
              WHERE successor.conversationId = candidate.conversationId
                AND successor.originNodeId = candidate.originNodeId
                AND successor.originSequence = candidate.originSequence + 1
            )
        ), state.contiguousFrontier)
      END
      WHERE conversationId = ? AND originNodeId = ?
    `);
    this.maxEventLamportClock = this.db.prepare(`
      SELECT COALESCE(MAX(lamportClock), 0) AS maximum
      FROM conversation_events WHERE conversationId = ?
    `);
    this.insertTurnTombstone = this.db.prepare(`
      INSERT INTO conversation_turn_tombstones (
        eventId, conversationId, turnId, originNodeId, originSequence,
        lamportClock, timestamp, reason, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversationId, turnId) DO NOTHING
    `);
    this.turnIsTombstoned = this.db.prepare(`
      SELECT 1 FROM conversation_turn_tombstones
      WHERE conversationId = ? AND turnId = ? LIMIT 1
    `);
    this.tombstonedTurnCounts = this.db.prepare(`
      SELECT COUNT(*) AS messageCount
      FROM messages AS message
      JOIN conversation_events AS source
        ON source.conversationId = message.conversationId
       AND source.eventId = message.messageId
       AND source.kind = 'message'
      WHERE message.conversationId = ? AND message.turnId = ?
        AND (message.hidden IS NULL OR message.hidden = 0)
    `);
    this.conversationById = this.db.prepare(`
      SELECT definitionId FROM conversations WHERE conversationId = ?
    `);
    this.ensureConversationForEvent = this.db.prepare(`
      INSERT INTO conversations (
        conversationId, title, lastMessagePreview, lastMessageTimestamp, messageCount,
        originNodeId, originClock, definitionId, instanceDeltaJson, isUserInitiated,
        sourceChannelJson
      ) VALUES (?, ?, '', ?, 0, ?, ?, ?, NULL, 1, NULL)
      ON CONFLICT(conversationId) DO UPDATE SET
        originClock = MAX(conversations.originClock, excluded.originClock)
    `);
    this.refreshConversationAfterTombstone = this.db.prepare(`
      UPDATE conversations SET
        messageCount = MAX(0, messageCount - ?),
        lastMessagePreview = COALESCE((
          SELECT substr(message.content, 1, 200) FROM messages AS message
          WHERE message.conversationId = conversations.conversationId
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = message.conversationId
                AND tombstone.turnId = message.turnId
            )
          ORDER BY message.timestamp DESC, message.lamportClock DESC,
                   message.originNodeId DESC, message.messageId DESC LIMIT 1
        ), ''),
        lastMessageTimestamp = COALESCE((
          SELECT message.timestamp FROM messages AS message
          WHERE message.conversationId = conversations.conversationId
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = message.conversationId
                AND tombstone.turnId = message.turnId
            )
          ORDER BY message.timestamp DESC, message.lamportClock DESC,
                   message.originNodeId DESC, message.messageId DESC LIMIT 1
        ), 0)
      WHERE conversationId = ?
    `);
    this.insertConversationAttachmentReference = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_attachment_references (
        conversationId, contentHash, messageId
      ) VALUES (?, ?, ?)
    `);
  }

  /** Fail closed when this writer has lost its fencing lease. */
  private assertWriter(): void {
    if (this.lease && !this.lease.held()) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `writer lease for this database was lost (fencing token ${this.lease.token})`,
        retryable: false,
      });
    }
  }

  /** Online backup snapshot via SQLite's backup API (readers/writer undisturbed). */
  async createSnapshot(targetPath: string): Promise<void> {
    this.assertWriter();
    await this.db.backup(targetPath);
    const snapshot = new Database(targetPath, { nativeBinding: this.nativeBinding });
    // The writer lease row is copied by SQLite backup, but it represents this
    // live process rather than portable database state. Clear only the copied
    // row so restoring/opening the snapshot must acquire a fresh fenced lease.
    try {
      snapshot.prepare('UPDATE memeloop_writer_lease SET held = 0 WHERE singleton = 1').run();
    } finally {
      snapshot.close();
    }
  }

  /** Release the writer lease (when owned) and close the database. */
  close(): void {
    if (this.ownsLease) {
      this.lease?.release();
    }
    this.db.close();
  }

  private migrate() {
    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS conversations (
          conversationId TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          lastMessagePreview TEXT NOT NULL,
          lastMessageTimestamp INTEGER NOT NULL,
          messageCount INTEGER NOT NULL,
          originNodeId TEXT NOT NULL,
          originClock INTEGER NOT NULL,
          definitionId TEXT NOT NULL,
          instanceDeltaJson TEXT,
          isUserInitiated INTEGER NOT NULL,
          sourceChannelJson TEXT
        );
      `,
      )
      .run();

    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS messages (
          messageId TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          originNodeId TEXT NOT NULL,
          originSequence INTEGER NOT NULL,
          turnId TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          lamportClock INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          partsJson TEXT,
          toolCallsJson TEXT,
          attachmentsJson TEXT,
          detailRefJson TEXT,
          reasoningContent TEXT,
          contentType TEXT,
          hidden INTEGER,
          duration INTEGER,
          metadataJson TEXT,
          canonicalBytes INTEGER NOT NULL,
          canonicalJson TEXT
        );
      `,
      )
      .run();

    this.ensureMessagesColumns();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        eventId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        originNodeId TEXT NOT NULL,
        originSequence INTEGER NOT NULL,
        lamportClock INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        kind TEXT NOT NULL,
        turnId TEXT,
        eventJson TEXT NOT NULL
      )
    `).run();
    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_origin_sequence
      ON conversation_events(conversationId, originNodeId, originSequence)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_conversation_events_sync_cursor
      ON conversation_events(conversationId, originNodeId, originSequence, eventId)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_conversation_events_kind_turn
      ON conversation_events(
        conversationId, kind, turnId, originNodeId, originSequence, eventId
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_event_sequences (
        conversationId TEXT NOT NULL,
        originNodeId TEXT NOT NULL,
        lastSequence INTEGER NOT NULL,
        contiguousFrontier INTEGER NOT NULL,
        PRIMARY KEY (conversationId, originNodeId)
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_turn_tombstones (
        eventId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        turnId TEXT NOT NULL,
        originNodeId TEXT NOT NULL,
        originSequence INTEGER NOT NULL,
        lamportClock INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT,
        digest TEXT,
        UNIQUE(conversationId, turnId)
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_metadata_fields (
        conversationId TEXT NOT NULL,
        field TEXT NOT NULL,
        valueJson TEXT NOT NULL,
        lamportClock INTEGER NOT NULL,
        originNodeId TEXT NOT NULL,
        eventId TEXT NOT NULL,
        PRIMARY KEY (conversationId, field)
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        runId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        definitionId TEXT NOT NULL,
        turnId TEXT NOT NULL,
        requestPeerId TEXT NOT NULL,
        requestId TEXT NOT NULL,
        payloadDigest TEXT NOT NULL,
        retrySourceTurnId TEXT,
        state TEXT NOT NULL,
        acceptedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        startedAt INTEGER,
        finishedAt INTEGER,
        cancelRequestedAt INTEGER,
        error TEXT,
        UNIQUE(requestPeerId, requestId)
      )
    `).run();
    this.ensureAgentRunColumns();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_active
      ON agent_runs(state, updatedAt)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_turn_peer
      ON agent_runs(conversationId, turnId, requestPeerId, updatedAt)
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS scheduled_agent_tasks (
        taskId TEXT PRIMARY KEY,
        agentInstanceId TEXT NOT NULL,
        agentDefinitionId TEXT NOT NULL,
        name TEXT NOT NULL,
        scheduleJson TEXT NOT NULL,
        payloadJson TEXT,
        activeHoursStart TEXT,
        activeHoursEnd TEXT,
        enabled INTEGER NOT NULL,
        createdBy TEXT,
        state TEXT NOT NULL,
        executionNodeId TEXT NOT NULL,
        executionNodeLabel TEXT,
        originNodeId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        nextRunAt TEXT,
        lastRunAt TEXT,
        lastRunStatus TEXT,
        lastError TEXT,
        lastFailureAt TEXT,
        consecutiveFailures INTEGER NOT NULL DEFAULT 0,
        nextRetryAt TEXT,
        runCount INTEGER NOT NULL DEFAULT 0,
        maxRuns INTEGER,
        deleteAfterRun INTEGER NOT NULL DEFAULT 0,
        executionRevision INTEGER NOT NULL DEFAULT 0,
        occurrenceId TEXT,
        occurrenceScheduledFor TEXT,
        occurrenceAttempt INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_agent_tasks_rpc_page
      ON scheduled_agent_tasks(agentInstanceId, executionNodeId, state, updatedAt DESC, taskId DESC)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_agent_tasks_restore
      ON scheduled_agent_tasks(executionNodeId, state, enabled, taskId)
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_timeline_state_v2 (
        conversationId TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        totalMessages INTEGER NOT NULL DEFAULT 0,
        totalTurns INTEGER NOT NULL DEFAULT 0,
        totalEntries INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_timeline_entries_v2 (
        entryId TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        lamportClock INTEGER NOT NULL,
        originNodeId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('turn', 'compaction')),
        turnId TEXT NOT NULL,
        userPreview TEXT,
        participantPreviewsJson TEXT NOT NULL DEFAULT '[]',
        responseCount INTEGER NOT NULL DEFAULT 0,
        entryOrdinal INTEGER NOT NULL DEFAULT 0,
        turnOrdinal INTEGER NOT NULL DEFAULT 0,
        summaryPreview TEXT,
        compactedMessageCount INTEGER,
        compactedTurnCount INTEGER,
        coveredVersionJson TEXT
      )
    `).run();
    this.ensureTimelineEntryColumnsV2();
    this.rebuildAllTimelineOrdinalsV2();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_timeline_entries_v2_cursor
      ON conversation_timeline_entries_v2(
        conversationId, timestamp, lamportClock, originNodeId, entryId
      )
    `).run();
    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_entries_v2_stable_cursor
      ON conversation_timeline_entries_v2(conversationId, cursor)
    `).run();
    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_entries_v2_turn
      ON conversation_timeline_entries_v2(conversationId, turnId)
      WHERE kind = 'turn'
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_timeline_entries_v2_ordinal
      ON conversation_timeline_entries_v2(conversationId, entryOrdinal)
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_list_state_v2 (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_list_state_v2 (id, revision) VALUES (1, 0)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_conversations_list_cursor
      ON conversations(lastMessageTimestamp, conversationId)
    `).run();

    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS attachments (
          contentHash TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          mimeType TEXT NOT NULL,
          size INTEGER NOT NULL,
          data BLOB NOT NULL
        );
      `,
      )
      .run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS attachment_sync_staging (
        contentHash TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        nextOffset INTEGER NOT NULL
      )
    `).run();
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS attachment_sync_chunks (
        contentHash TEXT NOT NULL,
        offset INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (contentHash, offset),
        FOREIGN KEY (contentHash) REFERENCES attachment_sync_staging(contentHash) ON DELETE CASCADE
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS conversation_attachment_references (
        conversationId TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        messageId TEXT NOT NULL,
        PRIMARY KEY (conversationId, contentHash, messageId)
      )
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_conversation_attachment_lookup
      ON conversation_attachment_references(conversationId, contentHash)
    `).run();

    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS agent_instances (
          instanceId TEXT PRIMARY KEY,
          definitionId TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          conversationId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          definitionDeltaJson TEXT
        );
      `,
      )
      .run();

    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS agent_definitions (
          definitionId TEXT PRIMARY KEY,
          definitionJson TEXT NOT NULL,
          updatedAt INTEGER NOT NULL
        );
      `,
      )
      .run();

    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS im_bindings (
          channelId TEXT NOT NULL,
          imUserId TEXT NOT NULL,
          activeConversationId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          defaultDefinitionId TEXT,
          updatedAt INTEGER NOT NULL,
          PRIMARY KEY (channelId, imUserId)
        );
      `,
      )
      .run();

    this.ensureImBindingsColumns();

    this.db.exec(PERMISSIONS_TABLE_DDL);
  }

  private installFencingTriggers(): void {
    const tables = [
      'conversations',
      'messages',
      'conversation_events',
      'conversation_event_sequences',
      'conversation_turn_tombstones',
      'conversation_metadata_fields',
      'agent_runs',
      'conversation_timeline_state_v2',
      'conversation_timeline_entries_v2',
      'conversation_list_state_v2',
      'attachments',
      'conversation_attachment_references',
      'agent_instances',
      'agent_definitions',
      'im_bindings',
      'permissions',
    ];
    for (const table of tables) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = `memeloop_fence_${table}_${operation.toLowerCase()}`;
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          BEFORE ${operation} ON ${table}
          WHEN NOT EXISTS (
            SELECT 1 FROM memeloop_writer_lease
            WHERE singleton = 1 AND held = 1 AND token = memeloop_writer_token()
          )
          BEGIN
            SELECT memeloop_raise_stale_epoch();
          END;
        `);
      }
    }
  }

  /** Keep append-only message metadata needed by paging and repeated compaction. */
  private ensureMessagesColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'partsJson')) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN partsJson TEXT`).run();
    }
    if (!cols.some((c) => c.name === 'detailRefJson')) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN detailRefJson TEXT`).run();
    }
    if (!cols.some((c) => c.name === 'metadataJson')) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN metadataJson TEXT`).run();
    }
    if (!cols.some(c => c.name === 'canonicalJson')) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN canonicalJson TEXT`).run();
    }
    for (
      const [column, type] of [
        ['reasoningContent', 'TEXT'],
        ['contentType', 'TEXT'],
        ['hidden', 'INTEGER'],
        ['duration', 'INTEGER'],
      ] as const
    ) {
      if (!cols.some(c => c.name === column)) {
        this.db.prepare(`ALTER TABLE messages ADD COLUMN ${column} ${type}`).run();
      }
    }
    if (!cols.some((c) => c.name === 'originSequence')) {
      throw new Error('incompatible messages schema: originSequence is required');
    }
    if (!cols.some(c => c.name === 'turnId')) {
      throw new Error('incompatible messages schema: turnId is required');
    }
    if (!cols.some(c => c.name === 'canonicalBytes')) {
      throw new Error('incompatible messages schema: canonicalBytes is required');
    }
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_cursor
      ON messages(conversationId, timestamp, lamportClock, originNodeId, messageId)
    `).run();
    this.db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_origin_sequence
      ON messages(conversationId, originNodeId, originSequence)
    `).run();
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_turn_cursor
      ON messages(conversationId, turnId, timestamp, lamportClock, originNodeId, messageId)
    `).run();
  }

  private ensureTimelineEntryColumnsV2(): void {
    const columns = this.db.prepare(`PRAGMA table_info(conversation_timeline_entries_v2)`)
      .all() as Array<{ name: string }>;
    const missing = (name: string) => !columns.some(column => column.name === name);
    if (missing('participantPreviewsJson')) {
      this.db.prepare(`ALTER TABLE conversation_timeline_entries_v2 ADD COLUMN participantPreviewsJson TEXT NOT NULL DEFAULT '[]'`).run();
    }
    if (missing('responseCount')) {
      this.db.prepare(`ALTER TABLE conversation_timeline_entries_v2 ADD COLUMN responseCount INTEGER NOT NULL DEFAULT 0`).run();
    }
    if (missing('entryOrdinal')) {
      this.db.prepare(`ALTER TABLE conversation_timeline_entries_v2 ADD COLUMN entryOrdinal INTEGER NOT NULL DEFAULT 0`).run();
    }
    if (missing('turnOrdinal')) {
      this.db.prepare(`ALTER TABLE conversation_timeline_entries_v2 ADD COLUMN turnOrdinal INTEGER NOT NULL DEFAULT 0`).run();
    }
  }

  private rebuildAllTimelineOrdinalsV2(conversationId?: string): void {
    const statement = this.rebuildTimelineOrdinalsV2 ??
      this.db.prepare(REBUILD_TIMELINE_ORDINALS_V2_SQL);
    statement.run(conversationId ?? null, conversationId ?? null);
  }

  private ensureImBindingsColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(im_bindings)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'createdAt')) {
      this.db.prepare(`ALTER TABLE im_bindings ADD COLUMN createdAt INTEGER`).run();
      this.db.prepare(`UPDATE im_bindings SET createdAt = updatedAt WHERE createdAt IS NULL`).run();
    }
    if (!cols.some((c) => c.name === 'pendingQuestionId')) {
      this.db.prepare(`ALTER TABLE im_bindings ADD COLUMN pendingQuestionId TEXT`).run();
    }
  }

  private ensureAgentRunColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(agent_runs)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some(column => column.name === 'retrySourceTurnId')) {
      this.db.prepare(`ALTER TABLE agent_runs ADD COLUMN retrySourceTurnId TEXT`).run();
    }
  }

  private conversationMetaFromRow(row: ConversationRow): ConversationMeta {
    return {
      conversationId: row.conversationId,
      title: row.title,
      lastMessagePreview: row.lastMessagePreview,
      lastMessageTimestamp: row.lastMessageTimestamp,
      messageCount: row.messageCount,
      originNodeId: row.originNodeId,
      originClock: row.originClock,
      definitionId: row.definitionId,
      isUserInitiated: Boolean(row.isUserInitiated),
      ...(row.instanceDeltaJson
        ? { instanceDelta: JSON.parse(row.instanceDeltaJson) as Record<string, unknown> }
        : {}),
      ...(row.sourceChannelJson
        ? { sourceChannel: JSON.parse(row.sourceChannelJson) as ConversationMeta['sourceChannel'] }
        : {}),
    };
  }

  private bumpConversationListRevision(): void {
    this.bumpConversationListRevisionStatement.run();
  }

  private refreshConversationProjectionV2(conversationId: string): void {
    this.refreshConversationProjectionV2Statement.run(conversationId);
  }

  async listConversationsPage(
    options: GetConversationListPageOptions,
    callOptions: ConversationListPageCallOptions = {},
  ): Promise<ConversationListPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('invalid_conversation_list_page_limit');
    }
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 1024 * 1024
    ) throw new Error('invalid_conversation_list_page_byte_budget');
    if (options.beforeCursor !== undefined && options.afterCursor !== undefined) {
      throw new Error('conversation_list_page_cursor_conflict');
    }
    if (
      (options.beforeCursor !== undefined || options.afterCursor !== undefined) &&
      options.expectedRevision === undefined
    ) throw new Error('conversation_list_cursor_requires_revision');
    const query = options.query ?? {};
    if (
      query.definitionId !== undefined && (
          query.definitionId.length === 0 || Buffer.byteLength(query.definitionId, 'utf8') > 512
        ) ||
      query.sourceChannelId !== undefined && (
          query.sourceChannelId.length === 0 || Buffer.byteLength(query.sourceChannelId, 'utf8') > 512
        ) ||
      query.isUserInitiated !== undefined && typeof query.isUserInitiated !== 'boolean'
    ) throw new Error('invalid_conversation_list_query');

    callOptions.signal?.throwIfAborted();
    const transaction = this.db.transaction((): ConversationListPage => {
      const state = this.db.prepare(`
        SELECT revision FROM conversation_list_state_v2 WHERE id = 1
      `).get() as { revision: number } | undefined;
      const revision = String(state?.revision ?? 0);
      const reset = (): ConversationListPage => {
        const page = { reset: true as const, revision };
        if (Buffer.byteLength(canonicalJson(page), 'utf8') > options.maxBytes) {
          throw new Error('conversation_list_page_exceeds_byte_budget');
        }
        return page;
      };
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return reset();
      }
      const queryDigest = conversationListQueryDigest(query);
      const encodedCursor = options.beforeCursor ?? options.afterCursor;
      const cursor = encodedCursor === undefined
        ? undefined
        : decodeConversationListCursor(encodedCursor, revision, queryDigest);
      if (encodedCursor !== undefined && cursor === undefined) return reset();

      const filters: string[] = [];
      const filterParameters: Array<string | number> = [];
      if (query.definitionId !== undefined) {
        filters.push('definitionId = ?');
        filterParameters.push(query.definitionId);
      }
      if (query.sourceChannelId !== undefined) {
        filters.push("json_extract(sourceChannelJson, '$.channelId') = ?");
        filterParameters.push(query.sourceChannelId);
      }
      if (query.isUserInitiated !== undefined) {
        filters.push('isUserInitiated = ?');
        filterParameters.push(query.isUserInitiated ? 1 : 0);
      }
      const total = (this.db.prepare(`
        SELECT COUNT(*) AS count FROM conversations
        ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
      `).get(...filterParameters) as { count: number }).count;

      const conditions = [...filters];
      const parameters = [...filterParameters];
      const readingNewer = options.afterCursor !== undefined;
      if (cursor) {
        conditions.push(
          `(lastMessageTimestamp, conversationId) ${readingNewer ? '>' : '<'} (?, ?)`,
        );
        parameters.push(cursor.timestamp, cursor.conversationId);
      }
      const direction = readingNewer ? 'ASC' : 'DESC';
      let rows = this.db.prepare(`
        SELECT * FROM conversations
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY lastMessageTimestamp ${direction}, conversationId ${direction}
        LIMIT ?
      `).all(...parameters, options.limit + 1) as ConversationRow[];
      const hasExtra = rows.length > options.limit;
      if (hasExtra) rows = rows.slice(0, options.limit);
      if (readingNewer) rows.reverse();
      let items = rows.map(row => this.conversationMetaFromRow(row));
      let byteTrimmed = false;
      const cursorFor = (row: ConversationRow) =>
        encodeConversationListCursor({
          v: 1,
          revision,
          queryDigest,
          timestamp: row.lastMessageTimestamp,
          conversationId: row.conversationId,
        });
      const buildPage = (): ConversationListPage => {
        const first = rows[0];
        const last = rows.at(-1);
        return {
          reset: false,
          items,
          revision,
          total,
          hasMoreBefore: readingNewer || hasExtra || (!readingNewer && byteTrimmed),
          hasMoreAfter: readingNewer
            ? hasExtra || byteTrimmed
            : options.beforeCursor !== undefined,
          ...(first ? { startCursor: cursorFor(first) } : {}),
          ...(last ? { endCursor: cursorFor(last) } : {}),
        };
      };
      for (;;) {
        const page = buildPage();
        if (Buffer.byteLength(canonicalJson(page), 'utf8') <= options.maxBytes) return page;
        if (items.length === 0) throw new Error('conversation_list_page_exceeds_byte_budget');
        if (items.length === 1) throw new Error('conversation_list_item_exceeds_byte_budget');
        byteTrimmed = true;
        if (readingNewer) {
          rows = rows.slice(1);
          items = items.slice(1);
        } else {
          rows = rows.slice(0, -1);
          items = items.slice(0, -1);
        }
      }
    });
    const page = transaction();
    callOptions.signal?.throwIfAborted();
    return page;
  }

  private messageFromRow(row: MessageRow): ChatMessage {
    return {
      messageId: row.messageId,
      turnId: row.turnId,
      conversationId: row.conversationId,
      originNodeId: row.originNodeId,
      originSequence: row.originSequence,
      timestamp: row.timestamp,
      lamportClock: row.lamportClock,
      role: row.role as ChatMessage['role'],
      content: row.content,
      ...(row.partsJson ? { parts: JSON.parse(row.partsJson) as ChatMessage['parts'] } : {}),
      ...(row.toolCallsJson
        ? { toolCalls: JSON.parse(row.toolCallsJson) as ChatMessage['toolCalls'] }
        : {}),
      ...(row.attachmentsJson
        ? { attachments: JSON.parse(row.attachmentsJson) as ChatMessage['attachments'] }
        : {}),
      ...(row.detailRefJson
        ? { detailRef: JSON.parse(row.detailRefJson) as ChatMessage['detailRef'] }
        : {}),
      ...(row.reasoningContent === null ? {} : { reasoning_content: row.reasoningContent }),
      ...(row.contentType === null ? {} : { contentType: row.contentType }),
      ...(row.hidden === null ? {} : { hidden: Boolean(row.hidden) }),
      ...(row.duration === null ? {} : { duration: row.duration }),
      ...(row.metadataJson
        ? { metadata: JSON.parse(row.metadataJson) as ChatMessage['metadata'] }
        : {}),
    };
  }

  private validateCanonicalMessage(message: ChatMessage): void {
    if (!Number.isSafeInteger(message.originSequence) || message.originSequence <= 0) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'originSequence must be a positive safe integer',
        retryable: false,
      });
    }
    if (!Number.isSafeInteger(message.lamportClock) || message.lamportClock <= 0) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'lamportClock must be a positive safe integer',
        retryable: false,
      });
    }
  }

  private messageValues(message: ChatMessage): unknown[] {
    const serialized = canonicalMessageJson(message);
    return [
      message.messageId,
      message.conversationId,
      message.originNodeId,
      message.originSequence,
      message.turnId,
      message.timestamp,
      message.lamportClock,
      message.role,
      message.content,
      message.parts ? JSON.stringify(message.parts) : null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.detailRef ? JSON.stringify(message.detailRef) : null,
      message.reasoning_content ?? null,
      message.contentType ?? null,
      message.hidden === undefined ? null : message.hidden ? 1 : 0,
      message.duration ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      Buffer.byteLength(serialized, 'utf8'),
      serialized,
    ];
  }

  private timelinePreview(content: unknown): string {
    if (typeof content !== 'string') {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'timeline preview content must be a string',
        retryable: false,
      });
    }
    let lineStart = 0;
    while (lineStart <= content.length) {
      const newline = content.indexOf('\n', lineStart);
      const lineEnd = newline < 0 ? content.length : newline;
      let start = lineStart;
      while (start < lineEnd && content[start].trim().length === 0) start += 1;
      let end = lineEnd;
      while (end > start && content[end - 1].trim().length === 0) end -= 1;
      if (end > start) return this.truncateUtf16(content.slice(start, end), 241);
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    return '';
  }

  private timelineCursor(
    originNodeId: string,
    originSequence: number,
    eventId: string,
  ): string {
    return `timeline-v2:${encodeURIComponent(originNodeId)}:${originSequence}:${encodeURIComponent(eventId)}`;
  }

  private truncateUtf16(value: string, maximumCodeUnits: number): string {
    if (value.length <= maximumCodeUnits) return value;
    let truncated = value.slice(0, maximumCodeUnits);
    const last = truncated.charCodeAt(truncated.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) truncated = truncated.slice(0, -1);
    return truncated;
  }

  private boundedTimelinePreview(value: string | null, maximumCodeUnits: number): string {
    const visible = this.timelinePreview(value ?? '');
    if (visible.length <= maximumCodeUnits) return visible;
    if (maximumCodeUnits === 1) return '…';
    return `${this.truncateUtf16(visible, maximumCodeUnits - 1)}…`;
  }

  private timelineParticipantPreviews(
    serialized: string,
    previewLength: number,
  ): ConversationTimelineParticipantPreview[] {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error('invalid_stored_timeline_participant_previews');
    }
    if (!Array.isArray(value) || value.length > 4) {
      throw new Error('invalid_stored_timeline_participant_previews');
    }
    return value.map((item): ConversationTimelineParticipantPreview => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('invalid_stored_timeline_participant_preview');
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.actorId !== 'string' || record.actorId.length === 0 ||
        typeof record.actorLabel !== 'string' || record.actorLabel.length === 0 ||
        (record.role !== 'assistant' && record.role !== 'agent') ||
        typeof record.preview !== 'string'
      ) throw new Error('invalid_stored_timeline_participant_preview');
      return {
        actorId: this.boundedTimelinePreview(record.actorId, 160),
        actorLabel: this.boundedTimelinePreview(record.actorLabel, 160),
        role: record.role,
        preview: this.boundedTimelinePreview(record.preview, Math.min(previewLength, 160)),
      };
    });
  }

  /** Bounded response projection; persisted ordinals are rebuilt once per write transaction. */
  private projectTimelineMessageV2(message: ChatMessage): void {
    if (message.hidden === true || this.turnIsTombstoned.get(message.conversationId, message.turnId)) {
      return;
    }
    const isTurn = message.role === 'user' && message.messageId === message.turnId;
    const insertedTurn = isTurn
      ? this.insertTimelineTurnV2.run(
        message.messageId,
        this.timelineCursor(message.originNodeId, message.originSequence, message.messageId),
        message.conversationId,
        message.timestamp,
        message.lamportClock,
        message.originNodeId,
        message.turnId,
        this.timelinePreview(message.content),
      ).changes
      : 0;
    this.upsertTimelineMessageStateV2.run(
      message.conversationId,
      insertedTurn,
      insertedTurn,
    );
    if (isTurn || message.role === 'assistant' || message.role === 'agent') {
      this.refreshTimelineResponsesV2.run(
        message.conversationId,
        message.turnId,
        message.turnId,
      );
    }
  }

  private projectTimelineCompactionV2(
    event: Extract<ConversationEvent, { kind: 'compaction'; mode: 'summary' }>,
  ): void {
    if (this.turnIsTombstoned.get(event.conversationId, event.summary.turnId)) return;
    const summaryPreview = this.timelinePreview(event.summary.content);
    if (summaryPreview.length === 0) return;
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_timeline_entries_v2 (
        entryId, cursor, conversationId, timestamp, lamportClock, originNodeId,
        kind, turnId, summaryPreview, compactedMessageCount,
        compactedTurnCount, coveredVersionJson
      ) VALUES (?, ?, ?, ?, ?, ?, 'compaction', ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      this.timelineCursor(event.originNodeId, event.originSequence, event.eventId),
      event.conversationId,
      event.timestamp,
      event.lamportClock,
      event.originNodeId,
      event.summary.turnId,
      summaryPreview,
      event.boundary.droppedMessageCount,
      event.boundary.droppedTurnCount,
      canonicalJson(event.boundary.coveredVersion),
    ).changes;
    if (inserted === 0) return;
    this.db.prepare(`
      INSERT INTO conversation_timeline_state_v2 (
        conversationId, revision, totalMessages, totalTurns, totalEntries
      ) VALUES (?, 1, 0, 0, 1)
      ON CONFLICT(conversationId) DO UPDATE SET
        revision = revision + 1,
        totalEntries = totalEntries + 1
    `).run(event.conversationId);
  }

  private projectTimelineTombstoneV2(
    event: Extract<ConversationEvent, { kind: 'tombstone' }>,
  ): void {
    const visible = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages AS message
      JOIN conversation_events AS source
        ON source.conversationId = message.conversationId
       AND source.eventId = message.messageId
       AND source.kind = 'message'
      WHERE message.conversationId = ? AND message.turnId = ?
        AND (message.hidden IS NULL OR message.hidden = 0)
    `).get(event.conversationId, event.targetTurnId) as { count: number };
    const removed = this.db.prepare(`
      DELETE FROM conversation_timeline_entries_v2
      WHERE conversationId = ? AND turnId = ?
      RETURNING kind
    `).all(
      event.conversationId,
      event.targetTurnId,
    ) as Array<{ kind: 'turn' | 'compaction' }>;
    const removedTurns = removed.filter(row => row.kind === 'turn').length;
    if (visible.count === 0 && removed.length === 0) return;
    this.db.prepare(`
      INSERT INTO conversation_timeline_state_v2 (
        conversationId, revision, totalMessages, totalTurns, totalEntries
      ) VALUES (?, 1, 0, 0, 0)
      ON CONFLICT(conversationId) DO UPDATE SET
        revision = revision + 1,
        totalMessages = MAX(0, totalMessages - ?),
        totalTurns = MAX(0, totalTurns - ?),
        totalEntries = MAX(0, totalEntries - ?)
    `).run(
      event.conversationId,
      visible.count,
      removedTurns,
      removed.length,
    );
  }

  private projectTombstone(
    event: Extract<ConversationEvent, { kind: 'tombstone' }>,
    projectTimeline: boolean,
  ): void {
    const info = this.insertTurnTombstone.run(
      event.eventId,
      event.conversationId,
      event.targetTurnId,
      event.originNodeId,
      event.originSequence,
      event.lamportClock,
      event.timestamp,
      event.reason ?? null,
      event.digest ?? null,
    );
    if (info.changes === 0) return;
    if (projectTimeline) this.projectTimelineTombstoneV2(event);
    const counts = this.tombstonedTurnCounts.get(
      event.conversationId,
      event.targetTurnId,
    ) as { messageCount: number };
    this.refreshConversationAfterTombstone.run(counts.messageCount, event.conversationId);
  }

  /** Rebuild one conversation in a fixed number of set-based statements. */
  private rebuildTimelineProjectionV2(conversationId: string): void {
    this.db.prepare(`
      DELETE FROM conversation_timeline_entries_v2 WHERE conversationId = ?
    `).run(conversationId);
    this.db.prepare(`
      INSERT INTO conversation_timeline_entries_v2 (
        entryId, cursor, conversationId, timestamp, lamportClock, originNodeId,
        kind, turnId, userPreview
      )
      SELECT user.messageId,
             memeloop_timeline_cursor(user.originNodeId, user.originSequence, user.messageId),
             user.conversationId, user.timestamp, user.lamportClock,
             user.originNodeId, 'turn', user.turnId,
             memeloop_timeline_preview(user.content)
      FROM messages AS user
      JOIN conversation_events AS source
        ON source.conversationId = user.conversationId
       AND source.eventId = user.messageId
       AND source.kind = 'message'
      WHERE user.conversationId = ?
        AND user.role = 'user' AND user.messageId = user.turnId
        AND (user.hidden IS NULL OR user.hidden = 0)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = user.conversationId
            AND tombstone.turnId = user.turnId
        )
    `).run(conversationId);
    this.db.prepare(`
      INSERT INTO conversation_timeline_entries_v2 (
        entryId, cursor, conversationId, timestamp, lamportClock, originNodeId,
        kind, turnId, summaryPreview, compactedMessageCount,
        compactedTurnCount, coveredVersionJson
      )
      SELECT event.eventId,
             memeloop_timeline_cursor(event.originNodeId, event.originSequence, event.eventId),
             event.conversationId, event.timestamp, event.lamportClock,
             event.originNodeId, 'compaction',
             json_extract(event.eventJson, '$.summary.turnId'),
             memeloop_timeline_preview(json_extract(event.eventJson, '$.summary.content')),
             CAST(json_extract(event.eventJson, '$.boundary.droppedMessageCount') AS INTEGER),
             CAST(json_extract(event.eventJson, '$.boundary.droppedTurnCount') AS INTEGER),
             json_extract(event.eventJson, '$.boundary.coveredVersion')
      FROM conversation_events AS event
      WHERE event.conversationId = ? AND event.kind = 'compaction'
        AND json_extract(event.eventJson, '$.mode') = 'summary'
        AND length(memeloop_timeline_preview(
          json_extract(event.eventJson, '$.summary.content')
        )) > 0
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = event.conversationId
            AND tombstone.turnId = json_extract(event.eventJson, '$.summary.turnId')
        )
    `).run(conversationId);
    this.refreshTimelineResponsesV2.run(conversationId, null, null);
    this.rebuildAllTimelineOrdinalsV2(conversationId);
    this.db.prepare(`
      INSERT INTO conversation_timeline_state_v2 (
        conversationId, revision, totalMessages, totalTurns, totalEntries
      ) SELECT ?, 1,
          (SELECT COUNT(*)
           FROM messages AS message
           JOIN conversation_events AS source
             ON source.conversationId = message.conversationId
            AND source.eventId = message.messageId
            AND source.kind = 'message'
           WHERE message.conversationId = ?
             AND (message.hidden IS NULL OR message.hidden = 0)
             AND NOT EXISTS (
               SELECT 1 FROM conversation_turn_tombstones AS tombstone
               WHERE tombstone.conversationId = message.conversationId
                 AND tombstone.turnId = message.turnId
             )),
          (SELECT COUNT(*) FROM conversation_timeline_entries_v2
           WHERE conversationId = ? AND kind = 'turn'),
          (SELECT COUNT(*) FROM conversation_timeline_entries_v2
           WHERE conversationId = ?)
      ON CONFLICT(conversationId) DO UPDATE SET
        revision = conversation_timeline_state_v2.revision + 1,
        totalMessages = excluded.totalMessages,
        totalTurns = excluded.totalTurns,
        totalEntries = excluded.totalEntries
    `).run(conversationId, conversationId, conversationId, conversationId);
  }

  private projectMetadataPatch(
    event: Extract<ConversationEvent, { kind: 'metadataPatch' }>,
  ): void {
    if (
      Object.prototype.hasOwnProperty.call(event.patch, 'definitionId') &&
      (typeof event.patch.definitionId !== 'string' ||
        event.patch.definitionId.length === 0 ||
        Buffer.byteLength(event.patch.definitionId, 'utf8') > 512)
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'metadataPatch definitionId must be a non-empty string of at most 512 UTF-8 bytes',
        retryable: false,
      });
    }
    const serializedPatch = canonicalJson(event.patch);
    if (Buffer.byteLength(serializedPatch, 'utf8') > 64 * 1024) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'metadataPatch exceeds 64 KiB',
        retryable: false,
      });
    }
    const winner = this.db.prepare(`
      INSERT INTO conversation_metadata_fields (
        conversationId, field, valueJson, lamportClock, originNodeId, eventId
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversationId, field) DO UPDATE SET
        valueJson = excluded.valueJson,
        lamportClock = excluded.lamportClock,
        originNodeId = excluded.originNodeId,
        eventId = excluded.eventId
      WHERE (excluded.lamportClock, excluded.originNodeId, excluded.eventId) >
            (conversation_metadata_fields.lamportClock,
             conversation_metadata_fields.originNodeId,
             conversation_metadata_fields.eventId)
    `);
    for (const [field, value] of Object.entries(event.patch)) {
      if (field === '__proto__' || field === 'prototype' || field === 'constructor') {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `forbidden metadataPatch field ${field}`,
          retryable: false,
        });
      }
      const valueJson = canonicalJson(value);
      if (Buffer.byteLength(valueJson, 'utf8') > 48 * 1024) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `metadataPatch field ${field} exceeds 48 KiB`,
          retryable: false,
        });
      }
      const result = winner.run(
        event.conversationId,
        field,
        valueJson,
        event.lamportClock,
        event.originNodeId,
        event.eventId,
      );
      if (result.changes === 0) continue;
      switch (field) {
        case 'title':
          this.db.prepare(`UPDATE conversations SET title = ? WHERE conversationId = ?`)
            .run(value, event.conversationId);
          break;
        case 'definitionId':
          this.db.prepare(`UPDATE conversations SET definitionId = ? WHERE conversationId = ?`)
            .run(value, event.conversationId);
          break;
        case 'instanceDelta':
          this.db.prepare(`UPDATE conversations SET instanceDeltaJson = ? WHERE conversationId = ?`)
            .run(valueJson, event.conversationId);
          break;
        case 'isUserInitiated':
          this.db.prepare(`UPDATE conversations SET isUserInitiated = ? WHERE conversationId = ?`)
            .run(value ? 1 : 0, event.conversationId);
          break;
        case 'sourceChannel':
          this.db.prepare(`UPDATE conversations SET sourceChannelJson = ? WHERE conversationId = ?`)
            .run(value === null ? null : valueJson, event.conversationId);
          break;
      }
    }
  }

  async getMessages(
    conversationId: string,
    _options: GetMessagesOptions = {},
  ): Promise<ChatMessage[]> {
    const rows = this.db
      .prepare(
        `
        SELECT messages.*
        FROM messages
        WHERE conversationId = ?
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS tombstone
            WHERE tombstone.conversationId = messages.conversationId
              AND tombstone.turnId = messages.turnId
          )
        ORDER BY timestamp ASC, lamportClock ASC, originNodeId ASC, messageId ASC;
      `,
      )
      .all(conversationId) as MessageRow[];

    return rows.map((row) => this.messageFromRow(row));
  }

  async getMessageById(conversationId: string, messageId: string): Promise<ChatMessage | null> {
    const row = this.db.prepare(`
      SELECT messages.* FROM messages
      WHERE conversationId = ? AND messageId = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = messages.conversationId
            AND tombstone.turnId = messages.turnId
        )
    `).get(conversationId, messageId) as MessageRow | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  async getMessageIdentity(
    conversationId: string,
    messageId: string,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<ConversationMessageIdentity | null> {
    callOptions.signal?.throwIfAborted();
    const row = this.db.prepare(`
      SELECT messageId, timestamp, lamportClock, originNodeId
      FROM messages
      WHERE conversationId = ? AND messageId = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = messages.conversationId
            AND tombstone.turnId = messages.turnId
        )
    `).get(conversationId, messageId) as ConversationMessageIdentity | undefined;
    callOptions.signal?.throwIfAborted();
    return row ?? null;
  }

  async readMessageDetailRange(
    conversationId: string,
    messageId: string,
    offset: number,
    maxBytes: number,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<ConversationMessageDetailRange> {
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024
    ) {
      throw new Error('invalid_message_detail_range');
    }
    callOptions.signal?.throwIfAborted();
    const row = this.db.prepare(`
      SELECT canonicalBytes AS totalBytes,
             substr(CAST(canonicalJson AS BLOB), ? + 1, ?) AS bytes
      FROM messages
      WHERE conversationId = ? AND messageId = ? AND canonicalJson IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = messages.conversationId
            AND tombstone.turnId = messages.turnId
        )
    `).get(offset, maxBytes, conversationId, messageId) as {
      totalBytes: number;
      bytes: Buffer;
    } | undefined;
    callOptions.signal?.throwIfAborted();
    if (!row) return { found: false };
    if (offset > row.totalBytes) throw new Error('invalid_message_detail_range_offset');
    return {
      found: true,
      offset,
      totalBytes: row.totalBytes,
      bytes: new Uint8Array(row.bytes),
    };
  }

  async getMessagesAfterCoveredVersion(
    conversationId: string,
    coveredVersion: Readonly<Record<string, number>>,
  ): Promise<ChatMessage[]> {
    const rows = this.db.prepare(`
      SELECT messages.*
      FROM messages
      WHERE conversationId = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = messages.conversationId
            AND tombstone.turnId = messages.turnId
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS covered
          WHERE covered.key = messages.originNodeId
            AND messages.originSequence <= CAST(covered.value AS INTEGER)
        )
      ORDER BY timestamp, lamportClock, originNodeId, messageId
    `).all(conversationId, JSON.stringify(coveredVersion)) as MessageRow[];
    return rows.map(row => this.messageFromRow(row));
  }

  async getEventVersionFrontierPage(options: {
    limit: number;
    after?: { conversationId: string; originNodeId: string };
    conversationIds?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{
    items: MessageVersionFrontier[];
    nextCursor?: { conversationId: string; originNodeId: string };
  }> {
    options.signal?.throwIfAborted();
    const limit = Math.max(1, Math.min(Number.isSafeInteger(options.limit) ? options.limit : 256, 256));
    const scopedIds = options.conversationIds
      ? [...new Set(options.conversationIds)]
      : undefined;
    if (scopedIds?.length === 0) return { items: [] };
    const conditions = ['contiguousFrontier > 0'];
    const parameters: Array<string | number> = [];
    if (scopedIds) {
      conditions.push(`conversationId IN (${scopedIds.map(() => '?').join(', ')})`);
      parameters.push(...scopedIds);
    }
    if (options.after) {
      conditions.push('(conversationId, originNodeId) > (?, ?)');
      parameters.push(options.after.conversationId, options.after.originNodeId);
    }
    const rows = this.db.prepare(`
      SELECT conversationId, originNodeId,
             contiguousFrontier AS maxContiguousOriginSequence
      FROM conversation_event_sequences
      WHERE ${conditions.join(' AND ')}
      ORDER BY conversationId, originNodeId
      LIMIT ?
    `).all(...parameters, limit + 1) as MessageVersionFrontier[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows,
      ...(hasMore && last
        ? {
          nextCursor: {
            conversationId: last.conversationId,
            originNodeId: last.originNodeId,
          },
        }
        : {}),
    };
  }

  async getEventVersionFrontiersForKeys(
    keys: readonly { conversationId: string; originNodeId: string }[],
    options?: { signal?: AbortSignal },
  ): Promise<MessageVersionFrontier[]> {
    options?.signal?.throwIfAborted();
    const unique = [...new Map(keys.map(key => [
      JSON.stringify([key.conversationId, key.originNodeId]),
      key,
    ])).values()];
    if (unique.length === 0) return [];
    if (unique.length > 256) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'frontier point lookup accepts at most 256 keys',
        retryable: false,
      });
    }
    const parameters = unique.flatMap(key => [key.conversationId, key.originNodeId]);
    return this.db.prepare(`
      SELECT conversationId, originNodeId,
             contiguousFrontier AS maxContiguousOriginSequence
      FROM conversation_event_sequences
      WHERE contiguousFrontier > 0 AND (${unique.map(() => '(conversationId = ? AND originNodeId = ?)').join(' OR ')})
      ORDER BY conversationId, originNodeId
    `).all(...parameters) as MessageVersionFrontier[];
  }

  async getCompactionCandidatePage(
    conversationId: string,
    options: GetCompactionCandidatePageOptions,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<CompactionCandidatePage> {
    callOptions.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(options.maxMessages) ||
      options.maxMessages < 1 ||
      options.maxMessages > 80 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > MAX_CONVERSATION_EVENT_BYTES
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid compaction candidate page bounds',
        retryable: false,
      });
    }
    for (const [originNodeId, sequence] of Object.entries(options.afterCoveredVersion)) {
      if (!originNodeId || !Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'afterCoveredVersion must contain positive safe integer frontiers',
          retryable: false,
        });
      }
    }
    const coveredJson = canonicalJson(options.afterCoveredVersion);
    const cutoff = options.beforeDisplayCursor;
    const cutoffPredicate = cutoff
      ? `AND NOT EXISTS (
           SELECT 1
           FROM conversation_events AS blocking
           LEFT JOIN conversation_turn_tombstones AS blocking_tombstone
             ON blocking_tombstone.conversationId = blocking.conversationId
            AND blocking_tombstone.turnId = blocking.turnId
           WHERE blocking.conversationId = event.conversationId
             AND blocking.originNodeId = event.originNodeId
             AND blocking.originSequence > COALESCE(CAST(covered.value AS INTEGER), 0)
             AND blocking.originSequence <= event.originSequence
             AND blocking.kind = 'message'
             AND blocking_tombstone.eventId IS NULL
             AND (blocking.timestamp, blocking.lamportClock,
                  blocking.originNodeId, blocking.eventId) >= (?, ?, ?, ?)
         )`
      : '';
    const parameters: Array<string | number> = [coveredJson, conversationId];
    if (cutoff) {
      parameters.push(
        cutoff.timestamp,
        cutoff.lamportClock,
        cutoff.originNodeId,
        cutoff.messageId,
      );
    }
    const maximumScannedEvents = 256;
    parameters.push(maximumScannedEvents + 1);
    const rows = this.db.prepare(`
      SELECT event.eventJson, event.originNodeId, event.originSequence,
             CASE WHEN tombstone.eventId IS NULL THEN 0 ELSE 1 END AS tombstoned
      FROM conversation_events AS event
      JOIN conversation_event_sequences AS frontier
        ON frontier.conversationId = event.conversationId
       AND frontier.originNodeId = event.originNodeId
      LEFT JOIN json_each(?) AS covered ON covered.key = event.originNodeId
      LEFT JOIN conversation_turn_tombstones AS tombstone
        ON tombstone.conversationId = event.conversationId
       AND tombstone.turnId = event.turnId
      WHERE event.conversationId = ?
        AND event.originSequence > COALESCE(CAST(covered.value AS INTEGER), 0)
        AND event.originSequence <= frontier.contiguousFrontier
        ${cutoffPredicate}
      ORDER BY event.originNodeId, event.originSequence, event.eventId
      LIMIT ?
    `).all(...parameters) as Array<{
      eventJson: string;
      originNodeId: string;
      originSequence: number;
      tombstoned: number;
    }>;
    const messages: ChatMessage[] = [];
    const nextCoveredVersion = { ...options.afterCoveredVersion };
    const newlyCoveredMessageCountByOrigin: Record<string, number> = {};
    const newlyCoveredUserTurnCountByOrigin: Record<string, number> = {};
    let bytes = 0;
    let stopped = false;
    for (const row of rows.slice(0, maximumScannedEvents)) {
      const event = parseStoredConversationEvent(row.eventJson);
      if (event.kind === 'message' && row.tombstoned === 0) {
        const message = conversationEventToMessage(event);
        const messageBytes = Buffer.byteLength(canonicalMessageJson(message), 'utf8');
        if (messageBytes > options.maxBytes && messages.length === 0) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: `compaction candidate message ${message.messageId} exceeds maxBytes`,
            retryable: false,
            reason: 'compaction_candidate_message_oversize',
          });
        }
        if (
          messages.length >= options.maxMessages ||
          bytes + messageBytes > options.maxBytes
        ) {
          stopped = true;
          break;
        }
        messages.push(message);
        bytes += messageBytes;
        newlyCoveredMessageCountByOrigin[row.originNodeId] = (newlyCoveredMessageCountByOrigin[row.originNodeId] ?? 0) + 1;
        if (message.role === 'user') {
          newlyCoveredUserTurnCountByOrigin[row.originNodeId] = (newlyCoveredUserTurnCountByOrigin[row.originNodeId] ?? 0) + 1;
        }
      }
      nextCoveredVersion[row.originNodeId] = row.originSequence;
    }
    const page = {
      messages,
      nextCoveredVersion,
      newlyCoveredMessageCountByOrigin,
      newlyCoveredUserTurnCountByOrigin,
      hasMore: stopped || rows.length > maximumScannedEvents,
    };
    callOptions.signal?.throwIfAborted();
    return page;
  }

  async getRetainedCompactionControls(
    conversationId: string,
    options: GetRetainedCompactionControlsOptions,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<RetainedCompactionControlPage> {
    callOptions.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 32 ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 ||
      options.maxBytes > MAX_CONVERSATION_EVENT_BYTES
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid retained compaction control page bounds',
        retryable: false,
      });
    }
    const cursorPredicate = options.after
      ? 'AND (candidate.originNodeId, candidate.originSequence, candidate.eventId) > (?, ?, ?)'
      : '';
    const parameters: Array<string | number> = [conversationId];
    if (options.after) {
      parameters.push(
        options.after.originNodeId,
        options.after.originSequence,
        options.after.eventId,
      );
    }
    parameters.push(options.limit + 1);
    const rows = this.db.prepare(`
      WITH summary_candidates AS (
        SELECT candidate.*,
          EXISTS (
            SELECT 1
            FROM conversation_events AS tombstone
            JOIN conversation_events AS target
              ON target.conversationId = tombstone.conversationId
             AND target.turnId = tombstone.turnId
             AND target.kind = 'message'
            JOIN json_each(candidate.eventJson, '$.boundary.coveredVersion') AS target_coverage
              ON target_coverage.key = target.originNodeId
             AND CAST(target_coverage.value AS INTEGER) >= target.originSequence
            LEFT JOIN json_each(candidate.eventJson, '$.boundary.coveredVersion') AS tombstone_coverage
              ON tombstone_coverage.key = tombstone.originNodeId
            WHERE tombstone.conversationId = candidate.conversationId
              AND tombstone.kind = 'tombstone'
              AND COALESCE(CAST(tombstone_coverage.value AS INTEGER), 0) < tombstone.originSequence
          ) AS polluted
        FROM conversation_events AS candidate
        WHERE candidate.conversationId = ?
          AND candidate.kind = 'compaction'
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS summary_tombstone
            WHERE summary_tombstone.conversationId = candidate.conversationId
              AND json_extract(candidate.eventJson, '$.mode') = 'summary'
              AND summary_tombstone.turnId = json_extract(candidate.eventJson, '$.summary.turnId')
          )
      ), valid_controls AS (
        SELECT * FROM summary_candidates WHERE polluted = 0
      ), dominance AS (
        SELECT candidate.eventId AS candidateEventId,
               MAX(CASE
                 WHEN json_extract(other.eventJson, '$.mode') = 'summary' THEN 1
                 ELSE 0
               END) AS hasSummaryDominator
        FROM valid_controls AS candidate
        JOIN valid_controls AS other
          ON other.conversationId = candidate.conversationId
         AND other.eventId <> candidate.eventId
         /* other covers every candidate component */
         AND NOT EXISTS (
           SELECT 1
           FROM json_each(candidate.eventJson, '$.boundary.coveredVersion') AS covered
           WHERE NOT EXISTS (
             SELECT 1
             FROM json_each(other.eventJson, '$.boundary.coveredVersion') AS other_covered
             WHERE other_covered.key = covered.key
               AND CAST(other_covered.value AS INTEGER) >= CAST(covered.value AS INTEGER)
           )
         )
         AND (
           /* strict dominance, including an origin absent from candidate */
           EXISTS (
             SELECT 1
             FROM json_each(other.eventJson, '$.boundary.coveredVersion') AS other_covered
             WHERE NOT EXISTS (
               SELECT 1
               FROM json_each(candidate.eventJson, '$.boundary.coveredVersion') AS covered
               WHERE covered.key = other_covered.key
                 AND CAST(covered.value AS INTEGER) >= CAST(other_covered.value AS INTEGER)
             )
           )
           /* equivalent coverage keeps the deterministic later control */
           OR (other.lamportClock, other.originNodeId, other.originSequence, other.eventId) >
              (candidate.lamportClock, candidate.originNodeId,
               candidate.originSequence, candidate.eventId)
         )
        GROUP BY candidate.eventId
      ), page_rows AS (
        SELECT candidate.eventJson,
               candidate.originNodeId,
               candidate.originSequence,
               candidate.eventId
        FROM valid_controls AS candidate
        LEFT JOIN dominance
          ON dominance.candidateEventId = candidate.eventId
        WHERE 1 = 1
          ${cursorPredicate}
          AND (
            dominance.candidateEventId IS NULL
            OR (
              json_extract(candidate.eventJson, '$.mode') = 'summary'
              AND dominance.hasSummaryDominator = 0
            )
          )
        ORDER BY candidate.originNodeId, candidate.originSequence, candidate.eventId
        LIMIT ?
      )
      SELECT page_rows.eventJson,
             status.invalidated
      FROM (
        SELECT COALESCE(MAX(polluted), 0) AS invalidated
        FROM summary_candidates
      ) AS status
      LEFT JOIN page_rows ON 1 = 1
      ORDER BY page_rows.originNodeId, page_rows.originSequence, page_rows.eventId
    `).all(...parameters) as Array<{ eventJson: string | null; invalidated: number }>;
    const items: RetainedCompactionControlPage['items'] = [];
    let bytes = 0;
    let byteStopped = false;
    for (const row of rows.slice(0, options.limit)) {
      if (row.eventJson === null) continue;
      const eventBytes = Buffer.byteLength(row.eventJson, 'utf8');
      if (eventBytes > options.maxBytes && items.length === 0) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: 'retained compaction control exceeds maxBytes',
          retryable: false,
          reason: 'retained_compaction_control_oversize',
        });
      }
      if (bytes + eventBytes > options.maxBytes) {
        byteStopped = true;
        break;
      }
      const event = parseStoredConversationEvent(row.eventJson);
      if (event.kind !== 'compaction') {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'retained compaction query returned a non-compaction event',
          retryable: false,
        });
      }
      items.push(event);
      bytes += eventBytes;
    }
    const last = items.at(-1);
    const page = {
      items,
      invalidated: rows.some(row => row.invalidated === 1),
      hasMore: byteStopped || rows.length > options.limit,
      ...(last
        ? {
          nextCursor: {
            originNodeId: last.originNodeId,
            originSequence: last.originSequence,
            eventId: last.eventId,
          },
        }
        : {}),
    };
    callOptions.signal?.throwIfAborted();
    return page;
  }

  async getConversationEventPage(
    conversationId: string,
    options: GetConversationEventPageOptions,
  ): Promise<ConversationEventPage> {
    const limit = Math.max(1, Math.min(Number.isSafeInteger(options.limit) ? options.limit : 80, 80));
    if (options.ranges?.length === 0) {
      return { items: [], hasMoreBefore: false, hasMoreAfter: false };
    }
    if ((options.ranges?.length ?? 0) > 256) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'event page supports at most 256 origin ranges',
        retryable: false,
      });
    }
    const forward = options.direction !== 'backward';
    const relation = forward ? '>' : '<';
    const direction = forward ? 'ASC' : 'DESC';
    const conditions = ['conversationId = ?'];
    const parameters: Array<string | number> = [conversationId];
    if (options.ranges) {
      conditions.push(`(${options.ranges.map(() => '(originNodeId = ? AND originSequence > ? AND originSequence <= ?)').join(' OR ')})`);
      for (const range of options.ranges) {
        parameters.push(range.originNodeId, range.fromExclusive, range.toInclusive);
      }
    }
    if (options.after) {
      conditions.push(`(originNodeId, originSequence, eventId) ${relation} (?, ?, ?)`);
      parameters.push(
        options.after.originNodeId,
        options.after.originSequence,
        options.after.eventId,
      );
    }
    const rows = this.db.prepare(`
      SELECT eventJson FROM conversation_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY originNodeId ${direction}, originSequence ${direction}, eventId ${direction}
      LIMIT ?
    `).all(...parameters, limit + 1) as Array<{ eventJson: string }>;
    const hasExtra = rows.length > limit;
    if (hasExtra) rows.pop();
    const ordered = forward ? rows : rows.reverse();
    const items = ordered.map(row => parseStoredConversationEvent(row.eventJson));
    const cursor = (event: ConversationEvent) => ({
      originNodeId: event.originNodeId,
      originSequence: event.originSequence,
      eventId: event.eventId,
    });
    return {
      items,
      hasMoreBefore: forward ? options.after !== undefined : hasExtra,
      hasMoreAfter: forward ? hasExtra : options.after !== undefined,
      ...(items[0] ? { startCursor: cursor(items[0]) } : {}),
      ...(items.at(-1) ? { endCursor: cursor(items.at(-1)!) } : {}),
    };
  }

  private cursorPredicate(relation: '<' | '>'): string {
    return `(timestamp, lamportClock, originNodeId, messageId) ${relation} (?, ?, ?, ?)`;
  }

  private cursorValues(cursor: ConversationMessageCursor): [number, number, string, string] {
    return [cursor.timestamp, cursor.lamportClock, cursor.originNodeId, cursor.messageId];
  }

  private messageExistsBeyond(
    conversationId: string,
    cursor: ConversationMessageCursor,
    relation: '<' | '>',
    afterCoveredVersion?: Readonly<Record<string, number>>,
  ): boolean {
    const coveragePredicate = afterCoveredVersion
      ? `AND NOT EXISTS (
           SELECT 1 FROM json_each(?) AS covered
           WHERE covered.key = messages.originNodeId
             AND messages.originSequence <= CAST(covered.value AS INTEGER)
         )
         AND NOT COALESCE((
           json_type(messages.metadataJson, '$.contextCompaction') = 'object'
           AND json_type(messages.metadataJson, '$.contextCompaction.version') = 'integer'
           AND json_extract(messages.metadataJson, '$.contextCompaction.version') = 2
         ), 0)`
      : '';
    const parameters: Array<number | string> = [conversationId, ...this.cursorValues(cursor)];
    if (afterCoveredVersion) parameters.push(canonicalJson(afterCoveredVersion));
    return this.db.prepare(
      `SELECT 1 FROM messages
       WHERE conversationId = ? AND ${this.cursorPredicate(relation)}
         AND (messages.hidden IS NULL OR messages.hidden = 0)
         AND NOT EXISTS (
           SELECT 1 FROM conversation_turn_tombstones AS tombstone
           WHERE tombstone.conversationId = messages.conversationId
             AND tombstone.turnId = messages.turnId
         )
         ${coveragePredicate}
       LIMIT 1`,
    ).get(...parameters) !== undefined;
  }

  async getMessagePage(
    conversationId: string,
    options: GetMessagePageOptions,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<ConversationMessagePage> {
    if (
      !Number.isSafeInteger(options.limit) || options.limit < 1 ||
      options.limit > MAX_CONVERSATION_MESSAGE_PAGE_SIZE
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'message page limit must be an integer from 1 through 80',
        retryable: false,
      });
    }
    const limit = options.limit;
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > MAX_CONVERSATION_MESSAGE_PAGE_BYTES
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'message page maxBytes must be a positive bounded integer',
        retryable: false,
      });
    }
    if (options.before !== undefined && options.after !== undefined) {
      throw new Error('conversation_message_page_cursor_conflict');
    }
    if (
      (options.before !== undefined || options.after !== undefined) &&
      options.expectedRevision === undefined
    ) throw new Error('conversation_message_cursor_requires_revision');
    callOptions.signal?.throwIfAborted();
    const transaction = this.db.transaction((): ConversationMessagePage => {
      const state = this.db.prepare(`
        SELECT revision FROM conversation_timeline_state_v2 WHERE conversationId = ?
      `).get(conversationId) as { revision: number } | undefined;
      const revision = String(state?.revision ?? 0);
      const reset = (): ConversationMessagePage => {
        const page = { reset: true as const, conversationId, revision };
        if (Buffer.byteLength(canonicalJson(page), 'utf8') > options.maxBytes) {
          throw new Error('conversation_message_page_exceeds_byte_budget');
        }
        return page;
      };
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return reset();
      }
      const suppliedCursor = options.before ?? options.after;
      if (suppliedCursor) {
        const exists = this.db.prepare(`
          SELECT 1 FROM messages
          WHERE conversationId = ? AND timestamp = ? AND lamportClock = ?
            AND originNodeId = ? AND messageId = ?
            AND (messages.hidden IS NULL OR messages.hidden = 0)
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_tombstones AS tombstone
              WHERE tombstone.conversationId = messages.conversationId
                AND tombstone.turnId = messages.turnId
            )
          LIMIT 1
        `).get(conversationId, ...this.cursorValues(suppliedCursor));
        if (!exists) return reset();
      }

      const conditions = [
        'messages.conversationId = ?',
        '(messages.hidden IS NULL OR messages.hidden = 0)',
        `NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = messages.conversationId
            AND tombstone.turnId = messages.turnId
        )`,
      ];
      const parameters: Array<number | string> = [conversationId];
      if (options.before) {
        conditions.push(this.cursorPredicate('<'));
        parameters.push(...this.cursorValues(options.before));
      }
      if (options.after) {
        conditions.push(this.cursorPredicate('>'));
        parameters.push(...this.cursorValues(options.after));
      }
      if (options.afterCoveredVersion) {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM json_each(?) AS covered
          WHERE covered.key = messages.originNodeId
            AND messages.originSequence <= CAST(covered.value AS INTEGER)
        )`);
        parameters.push(canonicalJson(options.afterCoveredVersion));
        conditions.push(`NOT COALESCE((
          json_type(messages.metadataJson, '$.contextCompaction') = 'object'
          AND json_type(messages.metadataJson, '$.contextCompaction.version') = 'integer'
          AND json_extract(messages.metadataJson, '$.contextCompaction.version') = 2
        ), 0)`);
      }
      const readingForward = options.direction === 'forward';
      const direction = readingForward ? 'ASC' : 'DESC';
      const indexRows = this.db.prepare(`
        SELECT messages.messageId, messages.canonicalBytes FROM messages
        WHERE ${conditions.join(' AND ')}
        ORDER BY messages.timestamp ${direction}, messages.lamportClock ${direction},
                 messages.originNodeId ${direction}, messages.messageId ${direction}
        LIMIT ?
      `).all(...parameters, limit) as Array<{ messageId: string; canonicalBytes: number }>;
      const selectedIds: string[] = [];
      let selectedBytes = 0;
      let byteStopped = false;
      const projectsOnDemand = options.mode === 'on-demand' || options.mode === 'metadata-only';
      for (const row of indexRows) {
        const projectedBytes = projectsOnDemand
          ? Math.min(row.canonicalBytes, options.maxBytes)
          : row.canonicalBytes;
        if (projectedBytes > options.maxBytes && selectedIds.length === 0) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: `message ${row.messageId} (${row.canonicalBytes} bytes) exceeds page maxBytes ${options.maxBytes}`,
            retryable: false,
            reason: 'message_page_item_oversize',
          });
        }
        if (selectedBytes + projectedBytes > options.maxBytes) {
          byteStopped = true;
          break;
        }
        selectedIds.push(row.messageId);
        selectedBytes += projectedBytes;
      }
      const rows = selectedIds.length === 0
        ? []
        : this.db.prepare(`
            SELECT * FROM messages WHERE conversationId = ?
              AND messageId IN (${selectedIds.map(() => '?').join(', ')})
            ORDER BY timestamp, lamportClock, originNodeId, messageId
          `).all(conversationId, ...selectedIds) as MessageRow[];
      let items = rows.map(row => {
        const message = this.messageFromRow(row);
        return projectsOnDemand
          ? projectConversationMessageForList(message, options.maxBytes)
          : message;
      });
      const buildPage = (): ConversationMessagePage => {
        const startCursor = items[0] ? messageCursor(items[0]) : undefined;
        const endCursor = items.at(-1) ? messageCursor(items.at(-1)!) : undefined;
        return {
          reset: false,
          conversationId,
          revision,
          items,
          hasMoreBefore: (!readingForward && byteStopped) || (startCursor
            ? this.messageExistsBeyond(
              conversationId,
              startCursor,
              '<',
              options.afterCoveredVersion,
            )
            : options.after !== undefined),
          hasMoreAfter: (readingForward && byteStopped) || (endCursor
            ? this.messageExistsBeyond(
              conversationId,
              endCursor,
              '>',
              options.afterCoveredVersion,
            )
            : options.before !== undefined),
          ...(startCursor ? { startCursor } : {}),
          ...(endCursor ? { endCursor } : {}),
        };
      };
      for (;;) {
        const page = buildPage();
        let fits = false;
        try {
          fits = Buffer.byteLength(canonicalJson(page), 'utf8') <= options.maxBytes;
        } catch {
          fits = false;
        }
        if (fits) return page;
        if (items.length <= 1) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: `message ${items[0]?.messageId ?? ''} exceeds page maxBytes`,
            retryable: false,
            reason: 'message_page_item_oversize',
          });
        }
        byteStopped = true;
        items = readingForward ? items.slice(0, -1) : items.slice(1);
      }
    });
    const page = transaction();
    callOptions.signal?.throwIfAborted();
    return page;
  }

  async getMessageWindowAround(
    conversationId: string,
    options: GetConversationMessageWindowAroundOptions,
    callOptions: ConversationReadCallOptions = {},
  ): Promise<ConversationMessageWindowResult> {
    if (
      !Number.isSafeInteger(options.maxMessages) ||
      options.maxMessages < 1 ||
      options.maxMessages > 80
    ) throw new Error('invalid_conversation_message_window_limit');
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > MAX_CONVERSATION_MESSAGE_PAGE_BYTES
    ) throw new Error('invalid_conversation_message_window_byte_budget');
    if (
      typeof options.expectedRevision !== 'string' ||
      options.expectedRevision.length === 0 ||
      options.expectedRevision.length > 2_048
    ) throw new Error('invalid_conversation_message_window_expected_revision');
    if (
      !options.focus ||
      (options.focus.kind === 'turn'
        ? options.focus.turnId.length === 0 ||
          options.focus.cursor !== undefined && options.focus.cursor.length === 0
        : options.focus.kind !== 'timeline-entry' ||
          options.focus.entryId.length === 0 || options.focus.cursor.length === 0)
    ) throw new Error('invalid_conversation_message_window_focus');
    callOptions.signal?.throwIfAborted();

    const transaction = this.db.transaction((): ConversationMessageWindowResult => {
      const state = this.db.prepare(`
        SELECT revision, totalMessages FROM conversation_timeline_state_v2
        WHERE conversationId = ?
      `).get(conversationId) as { revision: number; totalMessages: number } | undefined;
      const revision = String(state?.revision ?? 0);
      const reset = (): ConversationMessageWindowResult => {
        const result = { reset: true as const, conversationId, revision };
        if (Buffer.byteLength(canonicalJson(result), 'utf8') > options.maxBytes) {
          throw new Error('conversation_message_window_exceeds_byte_budget');
        }
        return result;
      };
      if (revision !== options.expectedRevision) return reset();

      type RankedFocusRow = TimelineEntryRow;
      const focusConditions = options.focus.kind === 'turn'
        ? `entry.kind = 'turn' AND entry.turnId = ?
           ${options.focus.cursor === undefined ? '' : 'AND entry.cursor = ?'}`
        : 'entry.entryId = ? AND entry.cursor = ?';
      const focusParameters = options.focus.kind === 'turn'
        ? [conversationId, options.focus.turnId, ...(options.focus.cursor ? [options.focus.cursor] : [])]
        : [conversationId, options.focus.entryId, options.focus.cursor];
      const focus = this.db.prepare(`
        SELECT entry.*
        FROM conversation_timeline_entries_v2 AS entry
        WHERE entry.conversationId = ? AND ${focusConditions}
        LIMIT 1
      `).get(...focusParameters) as RankedFocusRow | undefined;
      if (!focus) return reset();

      let anchorTurnId: string | undefined;
      let resolvedFocus: ConversationMessageWindowSuccess['focus'];
      if (focus.kind === 'turn') {
        anchorTurnId = focus.turnId;
        resolvedFocus = {
          kind: 'turn',
          turnId: focus.turnId,
          ...(options.focus.kind === 'timeline-entry'
            ? { entryId: focus.entryId, cursor: focus.cursor }
            : options.focus.cursor === undefined
            ? {}
            : { cursor: focus.cursor }),
        };
      } else {
        const nearest = this.db.prepare(`
          SELECT * FROM (
            SELECT entry.turnId, entry.entryOrdinal AS entryIndex,
              'before' AS position
            FROM conversation_timeline_entries_v2 AS entry
            WHERE entry.conversationId = ? AND entry.kind = 'turn'
              AND (entry.timestamp, entry.lamportClock, entry.originNodeId, entry.entryId) < (?, ?, ?, ?)
            ORDER BY entry.timestamp DESC, entry.lamportClock DESC,
                     entry.originNodeId DESC, entry.entryId DESC LIMIT 1
          )
          UNION ALL
          SELECT * FROM (
            SELECT entry.turnId, entry.entryOrdinal AS entryIndex,
              'after' AS position
            FROM conversation_timeline_entries_v2 AS entry
            WHERE entry.conversationId = ? AND entry.kind = 'turn'
              AND (entry.timestamp, entry.lamportClock, entry.originNodeId, entry.entryId) > (?, ?, ?, ?)
            ORDER BY entry.timestamp, entry.lamportClock, entry.originNodeId, entry.entryId LIMIT 1
          )
        `).all(
          conversationId,
          focus.timestamp,
          focus.lamportClock,
          focus.originNodeId,
          focus.entryId,
          conversationId,
          focus.timestamp,
          focus.lamportClock,
          focus.originNodeId,
          focus.entryId,
        ) as Array<{ turnId: string; entryIndex: number; position: 'before' | 'after' }>;
        const before = nearest.find(item => item.position === 'before');
        const after = nearest.find(item => item.position === 'after');
        const selected = !before
          ? after
          : !after
          ? before
          : after.entryIndex - focus.entryOrdinal <= focus.entryOrdinal - before.entryIndex
          ? after
          : before;
        anchorTurnId = selected?.turnId;
        const compactionEntry = {
          kind: 'compaction' as const,
          entryId: focus.entryId,
          conversationId,
          timestamp: focus.timestamp,
          lamportClock: focus.lamportClock,
          originNodeId: focus.originNodeId,
          cursor: focus.cursor,
          entryIndex: focus.entryOrdinal,
          turnIndex: focus.turnOrdinal,
          summaryPreview: this.boundedTimelinePreview(focus.summaryPreview, 96),
          compactedMessageCount: focus.compactedMessageCount ?? 0,
          compactedTurnCount: focus.compactedTurnCount ?? 0,
        };
        resolvedFocus = selected
          ? {
            kind: 'compaction',
            entry: compactionEntry,
            nearestPosition: selected.position,
            nearestTurnId: selected.turnId,
          }
          : { kind: 'compaction', entry: compactionEntry, nearestPosition: 'none' };
      }

      if (anchorTurnId === undefined) {
        return {
          reset: false,
          conversationId,
          revision,
          focus: resolvedFocus,
          items: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
        };
      }
      const anchor = this.db.prepare(`
        SELECT message.*
        FROM messages AS message
        JOIN conversation_events AS source
          ON source.conversationId = message.conversationId
         AND source.eventId = message.messageId AND source.kind = 'message'
        WHERE message.conversationId = ? AND message.turnId = ?
          AND (message.hidden IS NULL OR message.hidden = 0)
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS tombstone
            WHERE tombstone.conversationId = message.conversationId
              AND tombstone.turnId = message.turnId
          )
        ORDER BY message.timestamp, message.lamportClock,
                 message.originNodeId, message.messageId LIMIT 1
      `).get(conversationId, anchorTurnId) as MessageRow | undefined;
      if (!anchor) return reset();

      const beforeRows = this.db.prepare(`
        SELECT message.*
        FROM messages AS message
        JOIN conversation_events AS source
          ON source.conversationId = message.conversationId
         AND source.eventId = message.messageId AND source.kind = 'message'
        WHERE message.conversationId = ?
          AND (message.hidden IS NULL OR message.hidden = 0)
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS tombstone
            WHERE tombstone.conversationId = message.conversationId
              AND tombstone.turnId = message.turnId
          )
          AND (message.timestamp, message.lamportClock, message.originNodeId, message.messageId)
              <= (?, ?, ?, ?)
        ORDER BY message.timestamp DESC, message.lamportClock DESC,
                 message.originNodeId DESC, message.messageId DESC
        LIMIT ?
      `).all(
        conversationId,
        anchor.timestamp,
        anchor.lamportClock,
        anchor.originNodeId,
        anchor.messageId,
        options.maxMessages,
      ) as MessageRow[];
      const afterRows = this.db.prepare(`
        SELECT message.*
        FROM messages AS message
        JOIN conversation_events AS source
          ON source.conversationId = message.conversationId
         AND source.eventId = message.messageId AND source.kind = 'message'
        WHERE message.conversationId = ?
          AND (message.hidden IS NULL OR message.hidden = 0)
          AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_tombstones AS tombstone
            WHERE tombstone.conversationId = message.conversationId
              AND tombstone.turnId = message.turnId
          )
          AND (message.timestamp, message.lamportClock, message.originNodeId, message.messageId)
              > (?, ?, ?, ?)
        ORDER BY message.timestamp, message.lamportClock,
                 message.originNodeId, message.messageId
        LIMIT ?
      `).all(
        conversationId,
        anchor.timestamp,
        anchor.lamportClock,
        anchor.originNodeId,
        anchor.messageId,
        options.maxMessages,
      ) as MessageRow[];
      const surroundingRows = [...beforeRows.reverse(), ...afterRows];
      const surroundingAnchorIndex = beforeRows.length - 1;
      let selectedStart = Math.max(
        0,
        Math.min(
          surroundingAnchorIndex - Math.floor(options.maxMessages / 2),
          Math.max(0, surroundingRows.length - options.maxMessages),
        ),
      );
      let selectedRows = surroundingRows.slice(selectedStart, selectedStart + options.maxMessages);
      let anchorIndex = surroundingAnchorIndex - selectedStart;
      let selectedBytes = selectedRows.reduce((sum, row) => sum + row.canonicalBytes, 0);
      while (selectedBytes > options.maxBytes && selectedRows.length > 1) {
        const distanceBefore = anchorIndex;
        const distanceAfter = selectedRows.length - 1 - anchorIndex;
        if (distanceAfter > distanceBefore) {
          selectedBytes -= selectedRows.at(-1)!.canonicalBytes;
          selectedRows = selectedRows.slice(0, -1);
        } else {
          selectedBytes -= selectedRows[0].canonicalBytes;
          selectedRows = selectedRows.slice(1);
          selectedStart += 1;
          anchorIndex -= 1;
        }
      }
      let items = selectedRows.map(row => projectConversationMessageForList(this.messageFromRow(row), options.maxBytes));
      const buildResult = (): ConversationMessageWindowResult => {
        const first = items[0];
        const last = items.at(-1);
        return {
          reset: false,
          conversationId,
          revision,
          focus: resolvedFocus,
          items,
          hasMoreBefore: first
            ? this.messageExistsBeyond(conversationId, messageCursor(first), '<')
            : false,
          hasMoreAfter: last
            ? this.messageExistsBeyond(conversationId, messageCursor(last), '>')
            : false,
          ...(first ? { startCursor: messageCursor(first) } : {}),
          ...(last ? { endCursor: messageCursor(last) } : {}),
        };
      };
      for (;;) {
        const result = buildResult();
        let fits = false;
        try {
          fits = Buffer.byteLength(canonicalJson(result), 'utf8') <= options.maxBytes;
        } catch {
          fits = false;
        }
        if (fits) return result;
        if (items.length <= 1) {
          throw new Error('conversation_message_window_focus_exceeds_byte_budget');
        }
        const distanceBefore = anchorIndex;
        const distanceAfter = items.length - 1 - anchorIndex;
        if (distanceAfter > distanceBefore) items = items.slice(0, -1);
        else {
          items = items.slice(1);
          anchorIndex -= 1;
        }
      }
    });
    const result = transaction();
    callOptions.signal?.throwIfAborted();
    return result;
  }

  async getConversationTimelinePage(
    conversationId: string,
    options: GetConversationTimelinePageOptions,
    callOptions: ConversationTimelinePageCallOptions = {},
  ): Promise<ConversationTimelinePage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 64) {
      throw new Error('invalid_conversation_timeline_page_limit');
    }
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 1024 * 1024
    ) throw new Error('invalid_conversation_timeline_page_byte_budget');
    if (
      options.previewLength !== undefined && (
        !Number.isSafeInteger(options.previewLength) ||
        options.previewLength < 1 ||
        options.previewLength > 240
      )
    ) throw new Error('invalid_conversation_timeline_preview_length');
    const selectors = [
      options.beforeCursor,
      options.afterCursor,
      options.aroundEntryIndex,
    ].filter(value => value !== undefined);
    if (selectors.length > 1) throw new Error('conversation_timeline_page_cursor_conflict');
    if (
      (options.beforeCursor !== undefined || options.afterCursor !== undefined) &&
      options.expectedRevision === undefined
    ) throw new Error('conversation_timeline_cursor_requires_revision');
    if (
      options.aroundEntryIndex !== undefined && (
        !Number.isSafeInteger(options.aroundEntryIndex) || options.aroundEntryIndex < 0
      )
    ) throw new Error('invalid_conversation_timeline_page_cursor');
    if (
      options.expectedRevision !== undefined && (
        options.expectedRevision.length === 0 || options.expectedRevision.length > 2_048
      )
    ) throw new Error('invalid_conversation_timeline_expected_revision');
    callOptions.signal?.throwIfAborted();

    const transaction = this.db.transaction((): ConversationTimelinePage => {
      const state = this.db.prepare(`
        SELECT revision, totalMessages, totalTurns, totalEntries
        FROM conversation_timeline_state_v2 WHERE conversationId = ?
      `).get(conversationId) as {
        revision: number;
        totalMessages: number;
        totalTurns: number;
        totalEntries: number;
      } | undefined;
      const revision = String(state?.revision ?? 0);
      const reset = (): ConversationTimelinePage => {
        const page = { reset: true as const, revision };
        if (Buffer.byteLength(canonicalJson(page), 'utf8') > options.maxBytes) {
          throw new Error('conversation_timeline_page_exceeds_byte_budget');
        }
        return page;
      };
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return reset();
      }
      const totalMessages = state?.totalMessages ?? 0;
      const totalTurns = state?.totalTurns ?? 0;
      const totalEntries = state?.totalEntries ?? 0;
      const cursor = options.beforeCursor ?? options.afterCursor;
      const cursorRow = cursor === undefined
        ? undefined
        : this.db.prepare(`
            SELECT * FROM conversation_timeline_entries_v2
            WHERE conversationId = ? AND cursor = ?
          `).get(conversationId, cursor) as TimelineEntryRow | undefined;
      if (cursor !== undefined && cursorRow === undefined) return reset();

      const cursorEntryIndex = cursorRow?.entryOrdinal;
      const start = options.beforeCursor !== undefined
        ? Math.max(0, (cursorEntryIndex ?? 0) - options.limit)
        : options.afterCursor !== undefined
        ? Math.min(totalEntries, (cursorEntryIndex ?? totalEntries) + 1)
        : options.aroundEntryIndex !== undefined
        ? Math.max(
          0,
          Math.min(
            options.aroundEntryIndex - Math.floor(options.limit / 2),
            Math.max(0, totalEntries - options.limit),
          ),
        )
        : Math.max(0, totalEntries - options.limit);
      // Persisted ordinals make absolute and cursor seeks O(log N + page size):
      // the covering index finds the first rank and no read uses OFFSET/COUNT.
      const rows = this.db.prepare(`
        SELECT * FROM conversation_timeline_entries_v2
        WHERE conversationId = ? AND entryOrdinal >= ?
        ORDER BY entryOrdinal
        LIMIT ?
      `).all(conversationId, start, options.limit) as TimelineEntryRow[];
      const previewLength = options.previewLength ?? 96;
      let items = rows.map((row): ConversationTimelineEntry => {
        const base = {
          entryId: row.entryId,
          conversationId,
          timestamp: row.timestamp,
          lamportClock: row.lamportClock,
          originNodeId: row.originNodeId,
          cursor: row.cursor,
          entryIndex: row.entryOrdinal,
          turnIndex: row.turnOrdinal,
        };
        return row.kind === 'turn'
          ? boundConversationTimelineTurnEntry({
            ...base,
            kind: 'turn',
            messageId: row.entryId,
            turnId: row.turnId,
            userPreview: this.boundedTimelinePreview(row.userPreview, previewLength),
            participantPreviews: this.timelineParticipantPreviews(
              row.participantPreviewsJson,
              previewLength,
            ),
            responseCount: row.responseCount,
          })
          : {
            ...base,
            kind: 'compaction',
            summaryPreview: this.boundedTimelinePreview(row.summaryPreview, previewLength),
            compactedMessageCount: row.compactedMessageCount ?? 0,
            compactedTurnCount: row.compactedTurnCount ?? 0,
          };
      });
      const buildPage = (): ConversationTimelinePage => {
        const first = items[0];
        const last = items.at(-1);
        return {
          reset: false,
          items,
          revision,
          totalMessages,
          totalTurns,
          totalEntries,
          hasMoreBefore: first
            ? first.entryIndex > 0
            : options.afterCursor !== undefined && totalEntries > 0,
          hasMoreAfter: last
            ? last.entryIndex + 1 < totalEntries
            : options.beforeCursor !== undefined && totalEntries > 0,
          ...(first
            ? { startEntryIndex: first.entryIndex, startCursor: first.cursor }
            : {}),
          ...(last
            ? { endEntryIndex: last.entryIndex, endCursor: last.cursor }
            : {}),
        };
      };
      for (;;) {
        const page = buildPage();
        if (Buffer.byteLength(canonicalJson(page), 'utf8') <= options.maxBytes) return page;
        if (items.length === 0) throw new Error('conversation_timeline_page_exceeds_byte_budget');
        if (items.length === 1) throw new Error('conversation_timeline_entry_exceeds_byte_budget');
        if (options.afterCursor !== undefined) items = items.slice(0, -1);
        else if (options.aroundEntryIndex !== undefined) {
          const firstDistance = Math.abs(items[0].entryIndex - options.aroundEntryIndex);
          const lastDistance = Math.abs(items.at(-1)!.entryIndex - options.aroundEntryIndex);
          items = firstDistance > lastDistance ? items.slice(1) : items.slice(0, -1);
        } else items = items.slice(1);
      }
    });
    const page = transaction();
    callOptions.signal?.throwIfAborted();
    return page;
  }

  private appendCanonicalMessage(message: ChatMessage): void {
    this.validateCanonicalMessage(message);
    const conversation = this.conversationById.get(message.conversationId) as {
      definitionId: string;
    } | undefined;
    if (!conversation) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `conversation metadata must arrive before messages for ${message.conversationId}`,
        retryable: false,
      });
    }
    const isTombstoned = this.turnIsTombstoned.get(
      message.conversationId,
      message.turnId,
    ) !== undefined;
    const definitionId = conversation.definitionId;

    const preview = message.content.slice(0, 200);

    const isAuxiliaryConversation = message.conversationId.startsWith('terminal:') ||
      message.conversationId.startsWith('spawn:') ||
      message.conversationId.startsWith('remote:');
    const isUserInitiated = isAuxiliaryConversation ? 0 : 1;

    if (isTombstoned) {
      this.ensureConversationForEvent.run(
        message.conversationId,
        definitionId,
        message.timestamp,
        message.originNodeId,
        message.lamportClock,
        definitionId,
      );
    } else {
      this.upsertConversationForAppend.run(
        message.conversationId,
        definitionId,
        preview,
        message.timestamp,
        1,
        message.originNodeId,
        message.lamportClock,
        definitionId,
        null,
        isUserInitiated,
        null,
      );
    }
    this.insertMessage.run(...this.messageValues(message));
    const attachmentHashes = new Set(message.attachments?.map(item => item.contentHash) ?? []);
    for (const part of message.parts ?? []) {
      if (part.type === 'attachment') attachmentHashes.add(part.attachment.contentHash);
    }
    for (const contentHash of attachmentHashes) {
      this.insertConversationAttachmentReference.run(
        message.conversationId,
        contentHash,
        message.messageId,
      );
    }
  }

  private eventTurnId(event: ConversationEvent): string | null {
    if (event.kind === 'message') return event.message.turnId;
    if (event.kind === 'tombstone') return event.targetTurnId;
    if (event.kind === 'compaction') return event.summary?.turnId ?? null;
    return null;
  }

  private projectConversationEvent(event: ConversationEvent, projectTimeline: boolean): void {
    const existing = this.conversationById.get(event.conversationId) as {
      definitionId: string;
    } | undefined;
    const explicitDefinitionId = event.kind === 'metadataPatch'
      ? event.patch.definitionId
      : undefined;
    if (
      !existing && (
        typeof explicitDefinitionId !== 'string' ||
        explicitDefinitionId.length === 0 ||
        Buffer.byteLength(explicitDefinitionId, 'utf8') > 512
      )
    ) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `conversation metadata with explicit definitionId must arrive before events for ${event.conversationId}`,
        retryable: false,
      });
    }
    const definitionId = existing?.definitionId ?? explicitDefinitionId as string;
    this.ensureConversationForEvent.run(
      event.conversationId,
      definitionId,
      event.timestamp,
      event.originNodeId,
      event.lamportClock,
      definitionId,
    );
    if (event.kind === 'message') {
      const message = conversationEventToMessage(event);
      this.appendCanonicalMessage(message);
      if (projectTimeline) this.projectTimelineMessageV2(message);
      return;
    }
    if (event.kind === 'tombstone') {
      this.projectTombstone(event, projectTimeline);
    } else if (event.kind === 'compaction' && event.mode === 'summary') {
      this.appendCanonicalMessage({
        messageId: event.eventId,
        turnId: event.summary.turnId,
        conversationId: event.conversationId,
        originNodeId: event.originNodeId,
        originSequence: event.originSequence,
        timestamp: event.timestamp,
        lamportClock: event.lamportClock,
        role: 'assistant',
        content: event.summary.content,
        parts: event.summary.parts,
        metadata: { contextCompaction: event.boundary, compacted: true },
      });
      if (projectTimeline) this.projectTimelineCompactionV2(event);
    } else if (event.kind === 'metadataPatch') {
      this.projectMetadataPatch(event);
    }
  }

  /** Insert raw canonical event and all derived projections in the caller transaction. */
  private insertAndProjectConversationEvent(
    event: ConversationEvent,
    options: { projectTimeline?: boolean; updateSequence?: boolean } = {},
  ): boolean {
    const occupied = this.conversationEventBySequence.get(
      event.conversationId,
      event.originNodeId,
      event.originSequence,
    ) as { eventId: string } | undefined;
    if (occupied && occupied.eventId !== event.eventId) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `origin sequence ${event.conversationId}/${event.originNodeId}/${event.originSequence} is already occupied`,
        retryable: false,
      });
    }
    const serialized = serializedCanonicalConversationEvent(event);
    const info = this.insertConversationEvent.run(
      event.eventId,
      event.conversationId,
      event.originNodeId,
      event.originSequence,
      event.lamportClock,
      event.timestamp,
      event.kind,
      this.eventTurnId(event),
      serialized,
    );
    if (info.changes === 0) {
      const existing = this.conversationEventById.get(event.eventId) as {
        eventJson: string;
      } | undefined;
      if (!existing || existing.eventJson !== serialized) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `eventId ${event.eventId} already exists with a different payload`,
          retryable: false,
        });
      }
      return false;
    }
    if (options.updateSequence !== false) {
      this.recoverEventSequence.run(
        event.conversationId,
        event.originNodeId,
        event.originSequence,
      );
      this.advanceEventFrontier.run(event.conversationId, event.originNodeId);
    }
    this.projectConversationEvent(event, options.projectTimeline !== false);
    return true;
  }

  private prepareLocalEventsInTransaction(
    drafts: readonly ConversationEventDraft[],
  ): ConversationEvent[] {
    const stagedByEventId = new Map<string, ConversationEvent>();
    const nextSequenceByOrigin = new Map<string, number>();
    const nextLamportByConversation = new Map<string, number>();
    const prepared: ConversationEvent[] = [];
    for (const draft of drafts) {
      const staged = stagedByEventId.get(draft.eventId);
      const existingRow = this.conversationEventById.get(draft.eventId) as {
        eventJson: string;
      } | undefined;
      const existing = staged ?? (existingRow
        ? parseStoredConversationEvent(existingRow.eventJson)
        : undefined);
      if (existing) {
        const candidate = normalizeCanonicalConversationEvent({
          ...draft,
          originSequence: existing.originSequence,
          lamportClock: existing.lamportClock,
        });
        const candidateJson = serializedCanonicalConversationEvent(candidate);
        const existingJson = serializedCanonicalConversationEvent(existing);
        if (candidateJson !== existingJson) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `local eventId ${draft.eventId} already exists with a different payload`,
            retryable: false,
          });
        }
        prepared.push(existing);
        continue;
      }
      const originKey = JSON.stringify([draft.conversationId, draft.originNodeId]);
      let sequence = nextSequenceByOrigin.get(originKey);
      if (sequence === undefined) {
        const state = this.eventSequenceState.get(
          draft.conversationId,
          draft.originNodeId,
        ) as { lastSequence: number; contiguousFrontier: number } | undefined;
        if (state && state.lastSequence !== state.contiguousFrontier) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `cannot append local event while ${draft.originNodeId} has a sequence gap`,
            retryable: false,
          });
        }
        sequence = (state?.lastSequence ?? 0) + 1;
      }
      let lamport = nextLamportByConversation.get(draft.conversationId);
      if (lamport === undefined) {
        const maximum = this.maxEventLamportClock.get(draft.conversationId) as {
          maximum: number;
        };
        lamport = maximum.maximum + 1;
      }
      const event = normalizeCanonicalConversationEvent({
        ...draft,
        originSequence: sequence,
        lamportClock: lamport,
      });
      serializedCanonicalConversationEvent(event);
      stagedByEventId.set(event.eventId, event);
      nextSequenceByOrigin.set(originKey, sequence + 1);
      nextLamportByConversation.set(draft.conversationId, lamport + 1);
      prepared.push(event);
    }
    return prepared;
  }

  async appendLocalEvent(draft: ConversationEventDraft): Promise<ConversationEvent> {
    this.assertWriter();
    try {
      assertCanonicalConversationEventDraft(draft);
    } catch (error) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid canonical conversation event draft',
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    return this.db.transaction(() => {
      const [event] = this.prepareLocalEventsInTransaction([draft]);
      if (!event) throw new Error('local event preparation returned no event');
      if (this.insertAndProjectConversationEvent(event)) {
        this.refreshConversationProjectionV2(event.conversationId);
        this.rebuildAllTimelineOrdinalsV2(event.conversationId);
        this.bumpConversationListRevision();
      }
      return event;
    })();
  }

  async appendLocalEventsAtomic(
    drafts: readonly ConversationEventDraft[],
  ): Promise<ConversationEvent[]> {
    this.assertWriter();
    try {
      assertCanonicalConversationEventDrafts(drafts);
    } catch (error) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid canonical conversation event draft batch',
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    return this.db.transaction(() => {
      const events = this.prepareLocalEventsInTransaction(drafts);
      let changed = false;
      for (const event of events) {
        changed = this.insertAndProjectConversationEvent(event) || changed;
      }
      if (changed) {
        for (const conversationId of new Set(events.map(event => event.conversationId))) {
          this.refreshConversationProjectionV2(conversationId);
          this.rebuildAllTimelineOrdinalsV2(conversationId);
        }
        this.bumpConversationListRevision();
      }
      return events;
    })();
  }

  async insertEventsIfAbsent(events: readonly ConversationEvent[]): Promise<void> {
    this.assertWriter();
    let normalizedEvents: ConversationEvent[];
    try {
      normalizedEvents = normalizeCanonicalConversationEvents(events);
    } catch (error) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid canonical conversation event batch',
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    this.db.transaction(() => {
      const rebuildTimeline = normalizedEvents.length >= 256;
      // A sync page may be delivered in any order. Permit an explicit metadata
      // event in the same atomic page to establish the conversation identity,
      // while never guessing definitionId from an opaque conversationId.
      for (const event of normalizedEvents) {
        if (event.kind !== 'metadataPatch') continue;
        const definitionId = event.patch.definitionId;
        if (
          typeof definitionId !== 'string' || definitionId.length === 0 ||
          Buffer.byteLength(definitionId, 'utf8') > 512 ||
          this.conversationById.get(event.conversationId) !== undefined
        ) continue;
        this.ensureConversationForEvent.run(
          event.conversationId,
          definitionId,
          event.timestamp,
          event.originNodeId,
          event.lamportClock,
          definitionId,
        );
      }
      const maximumSequenceByOrigin = new Map<string, {
        conversationId: string;
        originNodeId: string;
        maximum: number;
      }>();
      const timelineConversations = new Set<string>();
      const changedConversations = new Set<string>();
      let changed = false;
      for (const event of normalizedEvents) {
        const inserted = this.insertAndProjectConversationEvent(event, {
          projectTimeline: !rebuildTimeline,
          updateSequence: false,
        });
        if (!inserted) continue;
        changed = true;
        changedConversations.add(event.conversationId);
        const key = JSON.stringify([event.conversationId, event.originNodeId]);
        const current = maximumSequenceByOrigin.get(key);
        if (!current || event.originSequence > current.maximum) {
          maximumSequenceByOrigin.set(key, {
            conversationId: event.conversationId,
            originNodeId: event.originNodeId,
            maximum: event.originSequence,
          });
        }
        if (
          event.kind === 'message' ||
          event.kind === 'tombstone' ||
          event.kind === 'compaction' && event.mode === 'summary'
        ) timelineConversations.add(event.conversationId);
      }
      for (const origin of maximumSequenceByOrigin.values()) {
        this.recoverEventSequence.run(
          origin.conversationId,
          origin.originNodeId,
          origin.maximum,
        );
        this.advanceEventFrontier.run(origin.conversationId, origin.originNodeId);
      }
      if (rebuildTimeline) {
        for (const conversationId of timelineConversations) {
          this.rebuildTimelineProjectionV2(conversationId);
        }
      }
      if (changed) {
        for (const conversationId of changedConversations) {
          this.refreshConversationProjectionV2(conversationId);
          this.rebuildAllTimelineOrdinalsV2(conversationId);
        }
        this.bumpConversationListRevision();
      }
    })();
  }

  async upsertConversationMetadata(meta: ConversationMeta): Promise<void> {
    this.assertWriter();
    if (
      typeof meta.definitionId !== 'string' || meta.definitionId.length === 0 ||
      Buffer.byteLength(meta.definitionId, 'utf8') > 512
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'conversation definitionId must be a non-empty string of at most 512 UTF-8 bytes',
        retryable: false,
      });
    }
    this.db.transaction(() => {
      this.db.prepare(
        `
        INSERT INTO conversations (
          conversationId, title, lastMessagePreview, lastMessageTimestamp, messageCount,
          originNodeId, originClock, definitionId, instanceDeltaJson, isUserInitiated, sourceChannelJson
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversationId) DO UPDATE SET
          title = excluded.title,
          lastMessagePreview = excluded.lastMessagePreview,
          lastMessageTimestamp = excluded.lastMessageTimestamp,
          messageCount = excluded.messageCount,
          originNodeId = excluded.originNodeId,
          originClock = excluded.originClock,
          definitionId = excluded.definitionId,
          instanceDeltaJson = excluded.instanceDeltaJson,
          isUserInitiated = excluded.isUserInitiated,
          sourceChannelJson = excluded.sourceChannelJson;
      `,
      ).run(
        meta.conversationId,
        meta.title,
        meta.lastMessagePreview,
        meta.lastMessageTimestamp,
        meta.messageCount,
        meta.originNodeId,
        meta.originClock,
        meta.definitionId,
        meta.instanceDelta ? JSON.stringify(meta.instanceDelta) : null,
        meta.isUserInitiated ? 1 : 0,
        meta.sourceChannel ? JSON.stringify(meta.sourceChannel) : null,
      );
      this.bumpConversationListRevision();
    })();
  }

  async conversationReferencesAttachment(
    conversationId: string,
    contentHash: string,
  ): Promise<boolean> {
    return this.db.prepare(`
      SELECT 1 FROM conversation_attachment_references
      WHERE conversationId = ? AND contentHash = ? LIMIT 1
    `).get(conversationId, contentHash) !== undefined;
  }

  async getAttachment(contentHash: string): Promise<AttachmentReference | null> {
    const row = this.db
      .prepare(
        `
        SELECT contentHash, filename, mimeType, size
        FROM attachments
        WHERE contentHash = ?;
      `,
      )
      .get(contentHash) as Partial<AttachmentRow> | undefined;

    if (!row) return null;

    const reference: AttachmentReference = {
      contentHash: row.contentHash!,
      filename: row.filename!,
      mimeType: row.mimeType!,
      size: row.size!,
    };
    return reference;
  }

  async saveAttachment(reference: AttachmentReference, data: Buffer | Uint8Array): Promise<void> {
    this.assertWriter();
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO attachments (contentHash, filename, mimeType, size, data)
        VALUES (?, ?, ?, ?, ?);
      `,
      )
      .run(reference.contentHash, reference.filename, reference.mimeType, reference.size, Buffer.from(data));
  }

  async readAttachmentData(contentHash: string): Promise<Uint8Array | null> {
    const row = this.db
      .prepare(`SELECT data FROM attachments WHERE contentHash = ?;`)
      .get(contentHash) as { data: Buffer } | undefined;
    if (!row?.data) return null;
    return new Uint8Array(row.data);
  }

  async readAttachmentRange(
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array | null> {
    options?.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 3 * 1024 * 1024
    ) {
      throw new Error('invalid_attachment_range');
    }
    const row = this.db.prepare(`
      SELECT substr(data, ?, ?) AS data
      FROM attachments WHERE contentHash = ?
    `).get(offset + 1, maxBytes, contentHash) as { data: Buffer } | undefined;
    return row ? new Uint8Array(row.data) : null;
  }

  async stageAttachmentChunk(
    reference: AttachmentReference,
    offset: number,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<number> {
    options?.signal?.throwIfAborted();
    this.assertWriter();
    if (
      !/^sha256:[\da-f]{64}$/iu.test(reference.contentHash) ||
      !Number.isSafeInteger(reference.size) || reference.size < 0 ||
      !Number.isSafeInteger(offset) || offset < 0 || data.byteLength > 3 * 1024 * 1024 ||
      offset + data.byteLength > reference.size ||
      (data.byteLength === 0 && reference.size !== 0)
    ) {
      throw new Error('invalid_attachment_chunk');
    }
    return this.db.transaction(() => {
      const published = this.db.prepare(`
        SELECT filename, mimeType, size FROM attachments WHERE contentHash = ?
      `).get(reference.contentHash) as Pick<AttachmentReference, 'filename' | 'mimeType' | 'size'> | undefined;
      if (published) {
        if (
          published.filename !== reference.filename || published.mimeType !== reference.mimeType ||
          published.size !== reference.size
        ) throw new Error('attachment_reference_conflict');
        return reference.size;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO attachment_sync_staging (
          contentHash, filename, mimeType, size, nextOffset
        ) VALUES (?, ?, ?, ?, 0)
      `).run(reference.contentHash, reference.filename, reference.mimeType, reference.size);
      const staging = this.db.prepare(`
        SELECT filename, mimeType, size, nextOffset
        FROM attachment_sync_staging WHERE contentHash = ?
      `).get(reference.contentHash) as Pick<AttachmentReference, 'filename' | 'mimeType' | 'size'> & {
        nextOffset: number;
      };
      if (
        staging.filename !== reference.filename || staging.mimeType !== reference.mimeType ||
        staging.size !== reference.size
      ) throw new Error('attachment_reference_conflict');
      if (offset < staging.nextOffset) {
        const prior = this.db.prepare(`
          SELECT data FROM attachment_sync_chunks WHERE contentHash = ? AND offset = ?
        `).get(reference.contentHash, offset) as { data: Buffer } | undefined;
        if (!prior || !Buffer.from(data).equals(prior.data)) {
          throw new Error('attachment_chunk_retry_conflict');
        }
        return staging.nextOffset;
      }
      if (offset !== staging.nextOffset) throw new Error('attachment_chunk_offset_mismatch');
      this.db.prepare(`
        INSERT INTO attachment_sync_chunks (contentHash, offset, data) VALUES (?, ?, ?)
      `).run(reference.contentHash, offset, Buffer.from(data));
      const nextOffset = offset + data.byteLength;
      this.db.prepare(`
        UPDATE attachment_sync_staging SET nextOffset = ? WHERE contentHash = ?
      `).run(nextOffset, reference.contentHash);
      return nextOffset;
    })();
  }

  async commitStagedAttachment(
    contentHash: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    this.assertWriter();
    const published = await this.getAttachment(contentHash);
    if (published) {
      if (!await this.verifyAttachment(contentHash)) throw new Error('attachment_hash_mismatch');
      return;
    }
    const staging = this.db.prepare(`
      SELECT contentHash, filename, mimeType, size, nextOffset
      FROM attachment_sync_staging WHERE contentHash = ?
    `).get(contentHash) as AttachmentReference & { nextOffset: number } | undefined;
    if (!staging || staging.nextOffset !== staging.size) throw new Error('attachment_incomplete');
    const chunks = this.db.prepare(`
      SELECT offset, data FROM attachment_sync_chunks
      WHERE contentHash = ? ORDER BY offset
    `).iterate(contentHash) as Iterable<{ offset: number; data: Buffer }>;
    const digest = createHash('sha256');
    let nextOffset = 0;
    for (const chunk of chunks) {
      options?.signal?.throwIfAborted();
      if (chunk.offset !== nextOffset) throw new Error('attachment_chunk_gap');
      digest.update(chunk.data);
      nextOffset += chunk.data.byteLength;
    }
    if (`sha256:${digest.digest('hex')}` !== contentHash.toLowerCase()) {
      throw new Error('attachment_hash_mismatch');
    }
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO attachments (contentHash, filename, mimeType, size, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(contentHash, staging.filename, staging.mimeType, staging.size, Buffer.alloc(0));
      const offsets = this.db.prepare(`
        SELECT offset FROM attachment_sync_chunks WHERE contentHash = ? ORDER BY offset
      `).all(contentHash) as Array<{ offset: number }>;
      const selectChunk = this.db.prepare(`
        SELECT data FROM attachment_sync_chunks WHERE contentHash = ? AND offset = ?
      `);
      const appendChunk = this.db.prepare(`
        UPDATE attachments SET data = CAST(data || ? AS BLOB) WHERE contentHash = ?
      `);
      for (const item of offsets) {
        options?.signal?.throwIfAborted();
        const chunk = selectChunk.get(contentHash, item.offset) as { data: Buffer };
        appendChunk.run(chunk.data, contentHash);
      }
      this.db.prepare('DELETE FROM attachment_sync_chunks WHERE contentHash = ?').run(contentHash);
      this.db.prepare('DELETE FROM attachment_sync_staging WHERE contentHash = ?').run(contentHash);
    })();
  }

  async verifyAttachment(
    contentHash: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    options?.signal?.throwIfAborted();
    if (!/^sha256:[\da-f]{64}$/iu.test(contentHash)) return false;
    const reference = await this.getAttachment(contentHash);
    if (!reference) return false;
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < reference.size) {
      options?.signal?.throwIfAborted();
      const chunk = await this.readAttachmentRange(
        contentHash,
        offset,
        3 * 1024 * 1024,
        options,
      );
      if (!chunk || chunk.byteLength === 0) return false;
      digest.update(chunk);
      offset += chunk.byteLength;
    }
    return offset === reference.size && `sha256:${digest.digest('hex')}` === contentHash.toLowerCase();
  }

  /**
   * 启动时由节点写入（builtin + YAML）；亦可单独持久化供仅 DB 可用的定义。
   */
  seedAgentDefinitions(definitions: AgentDefinition[]): void {
    this.assertWriter();
    const stmt = this.db.prepare(
      `
      INSERT OR REPLACE INTO agent_definitions (definitionId, definitionJson, updatedAt)
      VALUES (?, ?, ?);
    `,
    );
    const now = Date.now();
    for (const definition of definitions) {
      stmt.run(definition.id, JSON.stringify(definition), now);
    }
  }

  async getAgentDefinition(id: string): Promise<AgentDefinition | null> {
    const row = this.db
      .prepare(
        `
        SELECT definitionJson FROM agent_definitions WHERE definitionId = ? LIMIT 1;
      `,
      )
      .get(id) as { definitionJson: string } | undefined;
    if (!row?.definitionJson) return null;
    try {
      return JSON.parse(row.definitionJson) as AgentDefinition;
    } catch {
      return null;
    }
  }

  async getMaxLamportClockForConversation(conversationId: string): Promise<number> {
    const row = this.db
      .prepare(
        `
        SELECT COALESCE(MAX(lamportClock), 0) AS m
        FROM conversation_events
        WHERE conversationId = ?;
      `,
      )
      .get(conversationId) as { m: number } | undefined;
    return typeof row?.m === 'number' ? row.m : 0;
  }

  async saveAgentInstance(meta: AgentInstanceMeta): Promise<void> {
    this.assertWriter();
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO agent_instances (
          instanceId, definitionId, nodeId, conversationId,
          createdAt, updatedAt, definitionDeltaJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        meta.instanceId,
        meta.definitionId,
        meta.nodeId,
        meta.conversationId,
        meta.createdAt,
        meta.updatedAt,
        meta.definitionDelta ? JSON.stringify(meta.definitionDelta) : null,
      );
  }

  async getConversationMeta(conversationId: string): Promise<ConversationMeta | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM conversations
        WHERE conversationId = ?
        LIMIT 1;
      `,
      )
      .get(conversationId) as ConversationRow | undefined;

    if (!row) return null;

    return {
      conversationId: row.conversationId,
      title: row.title,
      lastMessagePreview: row.lastMessagePreview,
      lastMessageTimestamp: row.lastMessageTimestamp,
      messageCount: row.messageCount,
      originNodeId: row.originNodeId,
      originClock: row.originClock,
      definitionId: row.definitionId,
      instanceDelta: row.instanceDeltaJson ? JSON.parse(row.instanceDeltaJson) as Record<string, unknown> : undefined,
      isUserInitiated: Boolean(row.isUserInitiated),
      sourceChannel: row.sourceChannelJson
        ? JSON.parse(row.sourceChannelJson) as ConversationMeta['sourceChannel']
        : undefined,
    };
  }

  async getImBinding(channelId: string, imUserId: string): Promise<IMChannelBinding | null> {
    const row = this.db
      .prepare(
        `
        SELECT channelId, imUserId, activeConversationId, createdAt, defaultDefinitionId, pendingQuestionId, updatedAt
        FROM im_bindings WHERE channelId = ? AND imUserId = ? LIMIT 1
      `,
      )
      .get(channelId, imUserId) as
        | {
          channelId: string;
          imUserId: string;
          activeConversationId: string;
          createdAt: number;
          defaultDefinitionId: string | null;
          pendingQuestionId: string | null;
          updatedAt: number;
        }
        | undefined;
    if (!row) return null;
    return {
      channelId: row.channelId,
      imUserId: row.imUserId,
      activeConversationId: row.activeConversationId,
      createdAt: row.createdAt,
      defaultDefinitionId: row.defaultDefinitionId ?? undefined,
      pendingQuestionId: row.pendingQuestionId ?? undefined,
    };
  }

  async setImBinding(record: IMChannelBinding): Promise<void> {
    this.assertWriter();
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO im_bindings (channelId, imUserId, activeConversationId, createdAt, defaultDefinitionId, pendingQuestionId, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channelId, imUserId) DO UPDATE SET
          activeConversationId = excluded.activeConversationId,
          defaultDefinitionId = excluded.defaultDefinitionId,
          pendingQuestionId = excluded.pendingQuestionId,
          updatedAt = excluded.updatedAt
      `,
      )
      .run(
        record.channelId,
        record.imUserId,
        record.activeConversationId,
        record.createdAt ?? now,
        record.defaultDefinitionId ?? null,
        record.pendingQuestionId ?? null,
        now,
      );
  }

  createScheduledTaskStore(): ScheduledAgentTaskStore {
    return {
      list: (request, context) => this.listScheduledTasksRpc(request, context),
      get: (request, context) => this.getScheduledTaskRpc(request, context),
      create: (input, context) => this.createScheduledTaskRpc(input, context),
      update: (request, context) => this.updateScheduledTaskRpc(request, context),
      delete: (request, context) => this.deleteScheduledTaskRpc(request, context),
    };
  }

  createAgentRuntimeRpcProjectionStore(): AgentRuntimeRpcProjectionStore {
    return {
      listConversations: (request, context) => this.listRpcConversations(request, context),
      listTurns: (request, context) => this.listRpcTurns(request, context),
      getTurnDetail: (request, context) => this.getRpcTurnDetail(request, context),
    };
  }

  private rpcCursor(scope: string, values: Record<string, string | number>): string {
    return Buffer.from(canonicalJson({ v: 1, scope, ...values }), 'utf8').toString('base64url');
  }

  private parseRpcCursor(
    encoded: string | undefined,
    scope: string,
    fields: readonly string[],
  ): Record<string, string | number> | undefined {
    if (encoded === undefined) return undefined;
    if (encoded.length === 0 || encoded.length > 2_048) throw new Error('invalid_rpc_cursor');
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (parsed.v !== 1 || parsed.scope !== scope) throw new Error('invalid_rpc_cursor');
      const values: Record<string, string | number> = {};
      for (const field of fields) {
        const value = parsed[field];
        if (typeof value !== 'string' && (!Number.isSafeInteger(value) || (value as number) < 0)) {
          throw new Error('invalid_rpc_cursor');
        }
        values[field] = value as string | number;
      }
      if (
        Object.keys(parsed).sort().join(',') !== [...fields, 'scope', 'v'].sort().join(',') ||
        this.rpcCursor(scope, values) !== encoded
      ) throw new Error('invalid_rpc_cursor');
      return values;
    } catch {
      throw new Error('invalid_rpc_cursor');
    }
  }

  private async listRpcConversations(
    request: AgentDeviceRpcListConversationsRequest,
    context: AgentRuntimeRpcCollectionQueryContext,
  ): Promise<AgentDeviceRpcListConversationsResponse> {
    context.signal?.throwIfAborted();
    const conversationIds = context.allowedConversationIds;
    const definitionIds = context.allowedDefinitionIds;
    if (conversationIds?.length === 0 || definitionIds?.length === 0) {
      return { items: [], hasMoreBefore: false, hasMoreAfter: false };
    }
    const scope = createHash('sha256').update(canonicalJson({
      scopeKey: context.scopeKey,
      conversationIds: conversationIds ?? 'all',
      definitionIds: definitionIds ?? 'all',
    })).digest('base64url');
    const cursor = this.parseRpcCursor(request.cursor, scope, ['timestamp', 'conversationId']);
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (conversationIds !== undefined) {
      filters.push(`conversationId IN (${conversationIds.map(() => '?').join(', ')})`);
      parameters.push(...conversationIds);
    }
    if (definitionIds !== undefined) {
      filters.push(`definitionId IN (${definitionIds.map(() => '?').join(', ')})`);
      parameters.push(...definitionIds);
    }
    const forward = request.direction === 'forward';
    if (cursor) {
      filters.push(`(lastMessageTimestamp, conversationId) ${forward ? '>' : '<'} (?, ?)`);
      parameters.push(cursor.timestamp, cursor.conversationId);
    }
    const limit = request.limit ?? 100;
    let rows = this.db.prepare(`
      SELECT * FROM conversations
      ${filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`}
      ORDER BY lastMessageTimestamp ${forward ? 'ASC' : 'DESC'}, conversationId ${forward ? 'ASC' : 'DESC'}
      LIMIT ?
    `).all(...parameters, limit + 1) as ConversationRow[];
    const hasExtra = rows.length > limit;
    rows = rows.slice(0, limit);
    if (forward) rows.reverse();
    const first = rows[0];
    const last = rows.at(-1);
    const seenCursorFound = request.seenCursor === undefined
      ? undefined
      : (() => {
        try {
          const seen = this.parseRpcCursor(request.seenCursor, scope, ['timestamp', 'conversationId']);
          if (!seen) return false;
          const seenFilters = filters.slice(0, filters.length - (cursor ? 1 : 0));
          const seenParameters = parameters.slice(0, parameters.length - (cursor ? 2 : 0));
          return this.db.prepare(`
            SELECT 1 FROM conversations
            ${seenFilters.length === 0 ? 'WHERE' : `WHERE ${seenFilters.join(' AND ')} AND`}
              lastMessageTimestamp = ? AND conversationId = ? LIMIT 1
          `).get(...seenParameters, seen.timestamp, seen.conversationId) !== undefined;
        } catch {
          return false;
        }
      })();
    return {
      items: rows.map(row => this.conversationMetaFromRow(row)),
      ...(last && (forward ? true : hasExtra)
        ? {
          previousCursor: this.rpcCursor(scope, {
            timestamp: first.lastMessageTimestamp,
            conversationId: first.conversationId,
          }),
        }
        : {}),
      ...(last && (forward ? hasExtra : request.cursor !== undefined)
        ? {
          nextCursor: this.rpcCursor(scope, {
            timestamp: last.lastMessageTimestamp,
            conversationId: last.conversationId,
          }),
        }
        : {}),
      hasMoreBefore: forward ? request.cursor !== undefined : hasExtra,
      hasMoreAfter: forward ? hasExtra : request.cursor !== undefined,
      ...(seenCursorFound === undefined ? {} : { seenCursorFound }),
    };
  }

  private async listRpcTurns(
    request: AgentDeviceRpcListTurnsRequest,
    context: AgentRuntimeRpcReadContext,
  ): Promise<AgentDeviceRpcListTurnsResponse> {
    context.signal?.throwIfAborted();
    const limit = Math.min(request.limit ?? 80, 64);
    const timeline = await this.getConversationTimelinePage(request.conversationId, {
      limit,
      maxBytes: Math.min(request.byteBudget ?? 1024 * 1024, 1024 * 1024),
      previewLength: 160,
      ...(request.cursor === undefined
        ? {}
        : request.direction === 'forward'
        ? { afterCursor: request.cursor }
        : { beforeCursor: request.cursor }),
    }, context);
    if (timeline.reset) throw new Error('invalid_turn_list_cursor');
    let items = timeline.items.map((entry) =>
      entry.kind === 'turn'
        ? {
          turnId: entry.turnId,
          conversationId: entry.conversationId,
          cursor: entry.cursor,
          startedAt: entry.timestamp,
          updatedAt: entry.timestamp,
          userPreview: entry.userPreview,
          participantPreviews: entry.participantPreviews,
          responseCount: entry.responseCount,
          isCompaction: false,
          isTombstone: false,
          detailState: 'summary' as const,
        }
        : {
          turnId: entry.entryId,
          conversationId: entry.conversationId,
          cursor: entry.cursor,
          startedAt: entry.timestamp,
          updatedAt: entry.timestamp,
          userPreview: entry.summaryPreview,
          participantPreviews: [],
          responseCount: 0,
          isCompaction: true,
          compactedMessageCount: entry.compactedMessageCount,
          isTombstone: false,
          detailState: 'summary' as const,
        }
    );
    const byteBudget = request.byteBudget ?? 2 * 1024 * 1024;
    const renderBudget = request.renderLineBudget ?? 20_000;
    let truncated = false;
    const build = (): AgentDeviceRpcListTurnsResponse => {
      const first = items[0];
      const last = items.at(-1);
      const renderLines = items.reduce((total, item) =>
        total +
        item.userPreview.split('\n').length +
        item.participantPreviews.reduce((sum, participant) => sum + participant.preview.split('\n').length, 0), 0);
      const response: AgentDeviceRpcListTurnsResponse = {
        items,
        ...(timeline.hasMoreBefore && first ? { previousCursor: first.cursor } : {}),
        ...(timeline.hasMoreAfter && last ? { nextCursor: last.cursor } : {}),
        hasMoreBefore: timeline.hasMoreBefore,
        hasMoreAfter: timeline.hasMoreAfter || truncated,
        budget: { bytes: 0, renderLines, truncated },
      };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bytes = Buffer.byteLength(canonicalJson(response), 'utf8');
        if (response.budget.bytes === bytes) break;
        response.budget.bytes = bytes;
      }
      return response;
    };
    for (;;) {
      const response = build();
      if (response.budget.bytes <= byteBudget && response.budget.renderLines <= renderBudget) {
        if (request.seenCursor !== undefined) {
          const seen = await this.getConversationTimelinePage(request.conversationId, {
            limit: 1,
            maxBytes: 64 * 1024,
            previewLength: 16,
            beforeCursor: request.seenCursor,
          }, context);
          response.seenCursorFound = !seen.reset;
        }
        return response;
      }
      if (items.length === 0) throw new Error('turn_list_item_exceeds_budget');
      items = items.slice(0, -1);
      truncated = true;
    }
  }

  private async getRpcTurnDetail(
    request: AgentDeviceRpcGetTurnDetailRequest,
    context: AgentRuntimeRpcReadContext,
  ): Promise<AgentDeviceRpcGetTurnDetailResponse> {
    context.signal?.throwIfAborted();
    const scope = createHash('sha256').update(canonicalJson({
      conversationId: request.conversationId,
      turnId: request.turnId,
    })).digest('base64url');
    const cursor = this.parseRpcCursor(request.cursor, scope, [
      'timestamp',
      'lamportClock',
      'originNodeId',
      'messageId',
    ]);
    const forward = request.direction === 'forward';
    const limit = request.limit ?? 50;
    const tuple = cursor === undefined ? '' : `AND
      (message.timestamp, message.lamportClock, message.originNodeId, message.messageId)
        ${forward ? '>' : '<'} (?, ?, ?, ?)`;
    let rows = this.db.prepare(`
      SELECT message.* FROM messages AS message
      WHERE message.conversationId = ? AND message.turnId = ?
        AND (message.hidden IS NULL OR message.hidden = 0)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_tombstones AS tombstone
          WHERE tombstone.conversationId = message.conversationId AND tombstone.turnId = message.turnId
        )
        ${tuple}
      ORDER BY message.timestamp ${forward ? 'ASC' : 'DESC'},
        message.lamportClock ${forward ? 'ASC' : 'DESC'},
        message.originNodeId ${forward ? 'ASC' : 'DESC'}, message.messageId ${forward ? 'ASC' : 'DESC'}
      LIMIT ?
    `).all(
      request.conversationId,
      request.turnId,
      ...(cursor === undefined ? [] : [
        cursor.timestamp,
        cursor.lamportClock,
        cursor.originNodeId,
        cursor.messageId,
      ]),
      limit + 1,
    ) as MessageRow[];
    const hasExtra = rows.length > limit;
    rows = rows.slice(0, limit);
    if (!forward) rows.reverse();
    let items = rows.map(row =>
      projectConversationMessageForList(
        this.messageFromRow(row),
        128 * 1024,
      )
    );
    let byteTrimmed = false;
    const cursorFor = (row: MessageRow) =>
      this.rpcCursor(scope, {
        timestamp: row.timestamp,
        lamportClock: row.lamportClock,
        originNodeId: row.originNodeId,
        messageId: row.messageId,
      });
    for (;;) {
      const first = rows[0];
      const last = rows.at(-1);
      const response: AgentDeviceRpcGetTurnDetailResponse = {
        turnId: request.turnId,
        items,
        ...(first && (forward ? request.cursor !== undefined : hasExtra || byteTrimmed)
          ? { previousCursor: cursorFor(first) }
          : {}),
        ...(last && (forward ? hasExtra || byteTrimmed : request.cursor !== undefined)
          ? { nextCursor: cursorFor(last) }
          : {}),
        hasMoreBefore: forward ? request.cursor !== undefined : hasExtra || byteTrimmed,
        hasMoreAfter: forward ? hasExtra || byteTrimmed : request.cursor !== undefined,
      };
      if (Buffer.byteLength(canonicalJson(response), 'utf8') <= (request.maxBytes ?? 256 * 1024)) {
        if (request.seenCursor !== undefined) {
          try {
            const seen = this.parseRpcCursor(request.seenCursor, scope, [
              'timestamp',
              'lamportClock',
              'originNodeId',
              'messageId',
            ]);
            response.seenCursorFound = seen !== undefined && this.db.prepare(`
              SELECT 1 FROM messages WHERE conversationId = ? AND turnId = ?
                AND timestamp = ? AND lamportClock = ? AND originNodeId = ? AND messageId = ?
            `).get(
                  request.conversationId,
                  request.turnId,
                  seen?.timestamp,
                  seen?.lamportClock,
                  seen?.originNodeId,
                  seen?.messageId,
                ) !== undefined;
          } catch {
            response.seenCursorFound = false;
          }
        }
        return response;
      }
      if (items.length <= 1) throw new Error('turn_detail_item_exceeds_budget');
      byteTrimmed = true;
      if (forward) {
        rows = rows.slice(0, -1);
        items = items.slice(0, -1);
      } else {
        rows = rows.slice(1);
        items = items.slice(1);
      }
    }
  }

  private scheduledTaskFromRow(row: ScheduledTaskRow): ScheduledTask {
    return {
      id: row.taskId,
      agentInstanceId: row.agentInstanceId,
      agentDefinitionId: row.agentDefinitionId,
      name: row.name,
      schedule: JSON.parse(row.scheduleJson) as ScheduledTask['schedule'],
      ...(row.payloadJson === null
        ? {}
        : { payload: JSON.parse(row.payloadJson) as ScheduledTask['payload'] }),
      ...(row.activeHoursStart === null ? {} : { activeHoursStart: row.activeHoursStart }),
      ...(row.activeHoursEnd === null ? {} : { activeHoursEnd: row.activeHoursEnd }),
      enabled: Boolean(row.enabled),
      ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
      state: row.state,
      executionNodeId: row.executionNodeId,
      ...(row.executionNodeLabel === null ? {} : { executionNodeLabel: row.executionNodeLabel }),
      originNodeId: row.originNodeId,
      updatedAt: row.updatedAt,
      ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
      ...(row.lastRunAt === null ? {} : { lastRunAt: row.lastRunAt }),
      ...(row.lastRunStatus === null ? {} : { lastRunStatus: row.lastRunStatus }),
      ...(row.lastError === null ? {} : { lastError: row.lastError }),
      ...(row.lastFailureAt === null ? {} : { lastFailureAt: row.lastFailureAt }),
      consecutiveFailures: row.consecutiveFailures,
      ...(row.nextRetryAt === null ? {} : { nextRetryAt: row.nextRetryAt }),
      runCount: row.runCount,
      ...(row.maxRuns === null ? {} : { maxRuns: row.maxRuns }),
      deleteAfterRun: Boolean(row.deleteAfterRun),
      executionRevision: row.executionRevision,
      ...(row.occurrenceId === null ? {} : { occurrenceId: row.occurrenceId }),
      ...(row.occurrenceScheduledFor === null
        ? {}
        : { occurrenceScheduledFor: row.occurrenceScheduledFor }),
      occurrenceAttempt: row.occurrenceAttempt,
    };
  }

  private scheduledTaskCursor(
    scope: string,
    row: Pick<ScheduledTaskRow, 'updatedAt' | 'taskId'>,
  ): string {
    return Buffer.from(canonicalJson({ v: 1, scope, updatedAt: row.updatedAt, taskId: row.taskId }))
      .toString('base64url');
  }

  private parseScheduledTaskCursor(
    cursor: string | undefined,
    scope: string,
  ): { updatedAt: string; taskId: string } | undefined {
    if (cursor === undefined) return undefined;
    if (cursor.length === 0 || cursor.length > 2_048) throw new Error('invalid_scheduled_task_cursor');
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (
        Object.keys(parsed).sort().join(',') !== 'scope,taskId,updatedAt,v' ||
        parsed.v !== 1 || parsed.scope !== scope ||
        typeof parsed.updatedAt !== 'string' || typeof parsed.taskId !== 'string' ||
        this.scheduledTaskCursor(scope, {
            updatedAt: parsed.updatedAt,
            taskId: parsed.taskId,
          }) !== cursor
      ) throw new Error('invalid_scheduled_task_cursor');
      return { updatedAt: parsed.updatedAt, taskId: parsed.taskId };
    } catch {
      throw new Error('invalid_scheduled_task_cursor');
    }
  }

  private async listScheduledTasksRpc(
    request: ScheduledTaskRpcListRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTaskRpcListResponse> {
    context.signal?.throwIfAborted();
    if (request.executionNodeId !== context.localPeerId) {
      throw new Error('scheduled_task_execution_target_mismatch');
    }
    const states = request.states ?? ['active', 'paused'];
    const scope = createHash('sha256').update(canonicalJson({
      agentInstanceId: request.agentInstanceId,
      executionNodeId: request.executionNodeId,
      states,
    })).digest('base64url');
    const cursor = this.parseScheduledTaskCursor(request.cursor, scope);
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_agent_tasks
      WHERE agentInstanceId = ? AND executionNodeId = ?
        AND state IN (${placeholders})
        ${cursor === undefined ? '' : 'AND (updatedAt, taskId) < (?, ?)'}
      ORDER BY updatedAt DESC, taskId DESC
      LIMIT ?
    `).all(
      request.agentInstanceId,
      request.executionNodeId,
      ...states,
      ...(cursor === undefined ? [] : [cursor.updatedAt, cursor.taskId]),
      (request.limit ?? 100) + 1,
    ) as ScheduledTaskRow[];
    const limit = request.limit ?? 100;
    let selected = rows.slice(0, limit);
    let hasMoreAfter = rows.length > limit;
    for (;;) {
      const last = selected.at(-1);
      const response: ScheduledTaskRpcListResponse = {
        items: selected.map(row => this.scheduledTaskFromRow(row)),
        ...(last === undefined ? {} : { nextCursor: this.scheduledTaskCursor(scope, last) }),
        hasMoreAfter,
      };
      if (Buffer.byteLength(canonicalJson(response), 'utf8') <= request.maxBytes) {
        context.signal?.throwIfAborted();
        return response;
      }
      if (selected.length <= 1) throw new Error('scheduled_task_list_item_exceeds_byte_budget');
      selected = selected.slice(0, -1);
      hasMoreAfter = true;
    }
  }

  private async getScheduledTaskRpc(
    request: ScheduledTaskRpcGetRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask | undefined> {
    context.signal?.throwIfAborted();
    if (request.executionNodeId !== context.localPeerId) {
      throw new Error('scheduled_task_execution_target_mismatch');
    }
    const row = this.db.prepare(`
      SELECT * FROM scheduled_agent_tasks
      WHERE taskId = ? AND agentInstanceId = ? AND agentDefinitionId = ? AND executionNodeId = ?
    `).get(
      request.taskId,
      request.agentInstanceId,
      request.agentDefinitionId,
      request.executionNodeId,
    ) as ScheduledTaskRow | undefined;
    context.signal?.throwIfAborted();
    return row ? this.scheduledTaskFromRow(row) : undefined;
  }

  private async createScheduledTaskRpc(
    input: ScheduledTaskRpcCreateInput,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask> {
    this.assertWriter();
    context.signal?.throwIfAborted();
    if (input.executionNodeId !== context.localPeerId) {
      throw new Error('scheduled_task_execution_target_mismatch');
    }
    const task: ScheduledTask = {
      id: `scheduled-${randomUUID()}`,
      agentInstanceId: input.agentInstanceId,
      agentDefinitionId: input.agentDefinitionId,
      name: input.name,
      schedule: input.schedule,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.activeHoursStart === undefined ? {} : { activeHoursStart: input.activeHoursStart }),
      ...(input.activeHoursEnd === undefined ? {} : { activeHoursEnd: input.activeHoursEnd }),
      enabled: input.enabled ?? true,
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      state: 'active',
      executionNodeId: input.executionNodeId,
      ...(input.executionNodeLabel === undefined ? {} : { executionNodeLabel: input.executionNodeLabel }),
      originNodeId: context.remotePeerId,
      updatedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      runCount: 0,
      deleteAfterRun: false,
      executionRevision: 0,
      occurrenceAttempt: 0,
    };
    context.signal?.throwIfAborted();
    this.insertScheduledTask(task);
    return task;
  }

  private insertScheduledTask(task: ScheduledTask): void {
    this.db.prepare(`
      INSERT INTO scheduled_agent_tasks (
        taskId, agentInstanceId, agentDefinitionId, name, scheduleJson, payloadJson,
        activeHoursStart, activeHoursEnd, enabled, createdBy, state, executionNodeId,
        executionNodeLabel, originNodeId, updatedAt, nextRunAt, lastRunAt, lastRunStatus,
        lastError, lastFailureAt, consecutiveFailures, nextRetryAt, runCount, maxRuns,
        deleteAfterRun, executionRevision, occurrenceId, occurrenceScheduledFor, occurrenceAttempt
      ) VALUES (${Array.from({ length: 29 }, () => '?').join(', ')})
    `).run(...this.scheduledTaskValues(task));
  }

  private scheduledTaskValues(task: ScheduledTask): unknown[] {
    return [
      task.id,
      task.agentInstanceId,
      task.agentDefinitionId,
      task.name,
      canonicalJson(task.schedule),
      task.payload ? canonicalJson(task.payload) : null,
      task.activeHoursStart ?? null,
      task.activeHoursEnd ?? null,
      task.enabled ? 1 : 0,
      task.createdBy ?? null,
      task.state,
      task.executionNodeId,
      task.executionNodeLabel ?? null,
      task.originNodeId,
      task.updatedAt ?? new Date().toISOString(),
      task.nextRunAt ?? null,
      task.lastRunAt ?? null,
      task.lastRunStatus ?? null,
      task.lastError ?? null,
      task.lastFailureAt ?? null,
      task.consecutiveFailures ?? 0,
      task.nextRetryAt ?? null,
      task.runCount ?? 0,
      task.maxRuns ?? null,
      task.deleteAfterRun ? 1 : 0,
      task.executionRevision ?? 0,
      task.occurrenceId ?? null,
      task.occurrenceScheduledFor ?? null,
      task.occurrenceAttempt ?? 0,
    ];
  }

  private async updateScheduledTaskRpc(
    request: ScheduledTaskRpcUpdateRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask> {
    this.assertWriter();
    context.signal?.throwIfAborted();
    const existing = await this.getScheduledTaskRpc(request, context);
    if (!existing) throw new Error('scheduled_task_not_found');
    if (
      request.patch.executionNodeId !== undefined &&
      request.patch.executionNodeId !== existing.executionNodeId
    ) throw new Error('scheduled_task_execution_transfer_forbidden');
    const task: ScheduledTask = {
      ...existing,
      ...(request.patch.name === undefined ? {} : { name: request.patch.name }),
      ...(request.patch.schedule === undefined ? {} : { schedule: request.patch.schedule }),
      ...(request.patch.payload === undefined
        ? {}
        : request.patch.payload === null
        ? { payload: undefined }
        : { payload: request.patch.payload }),
      ...(request.patch.activeHoursStart === undefined
        ? {}
        : { activeHoursStart: request.patch.activeHoursStart ?? undefined }),
      ...(request.patch.activeHoursEnd === undefined
        ? {}
        : { activeHoursEnd: request.patch.activeHoursEnd ?? undefined }),
      ...(request.patch.enabled === undefined ? {} : { enabled: request.patch.enabled }),
      ...(request.patch.executionNodeLabel === undefined
        ? {}
        : { executionNodeLabel: request.patch.executionNodeLabel ?? undefined }),
      updatedAt: new Date().toISOString(),
      executionRevision: (existing.executionRevision ?? 0) + 1,
      nextRunAt: undefined,
      nextRetryAt: undefined,
      occurrenceId: undefined,
      occurrenceScheduledFor: undefined,
      occurrenceAttempt: 0,
    };
    context.signal?.throwIfAborted();
    const result = this.db.prepare(`
      UPDATE scheduled_agent_tasks SET
        name = ?, scheduleJson = ?, payloadJson = ?, activeHoursStart = ?, activeHoursEnd = ?,
        enabled = ?, executionNodeLabel = ?, updatedAt = ?, nextRunAt = NULL, nextRetryAt = NULL,
        occurrenceId = NULL, occurrenceScheduledFor = NULL, occurrenceAttempt = 0,
        executionRevision = ?
      WHERE taskId = ? AND agentInstanceId = ? AND agentDefinitionId = ?
        AND executionNodeId = ? AND executionRevision = ?
    `).run(
      task.name,
      canonicalJson(task.schedule),
      task.payload ? canonicalJson(task.payload) : null,
      task.activeHoursStart ?? null,
      task.activeHoursEnd ?? null,
      task.enabled ? 1 : 0,
      task.executionNodeLabel ?? null,
      task.updatedAt,
      task.executionRevision,
      task.id,
      task.agentInstanceId,
      task.agentDefinitionId,
      task.executionNodeId,
      existing.executionRevision ?? 0,
    );
    if (result.changes !== 1) throw new Error('scheduled_task_update_conflict');
    return task;
  }

  private async deleteScheduledTaskRpc(
    request: ScheduledTaskRpcDeleteRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<void> {
    this.assertWriter();
    context.signal?.throwIfAborted();
    if (request.executionNodeId !== context.localPeerId) {
      throw new Error('scheduled_task_execution_target_mismatch');
    }
    const result = this.db.prepare(`
      DELETE FROM scheduled_agent_tasks
      WHERE taskId = ? AND agentInstanceId = ? AND agentDefinitionId = ? AND executionNodeId = ?
    `).run(request.taskId, request.agentInstanceId, request.agentDefinitionId, request.executionNodeId);
    if (result.changes !== 1) throw new Error('scheduled_task_not_found');
  }

  async listRunnablePage(options: {
    executionNodeId: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ items: ScheduledTask[]; nextCursor?: string; hasMoreAfter: boolean }> {
    options.signal?.throwIfAborted();
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_agent_tasks
      WHERE executionNodeId = ? AND state = 'active' AND enabled = 1
        ${options.cursor === undefined ? '' : 'AND taskId > ?'}
      ORDER BY taskId LIMIT ?
    `).all(
      options.executionNodeId,
      ...(options.cursor === undefined ? [] : [options.cursor]),
      options.limit + 1,
    ) as ScheduledTaskRow[];
    const selected = rows.slice(0, options.limit);
    return {
      items: selected.map(row => this.scheduledTaskFromRow(row)),
      ...(rows.length > options.limit && selected.at(-1)
        ? { nextCursor: selected.at(-1)!.taskId }
        : {}),
      hasMoreAfter: rows.length > options.limit,
    };
  }

  async updateExecution(
    identity: ScheduledTaskExecutionIdentity,
    patch: ScheduledTaskExecutionPatch,
    options: { expectedExecutionRevision: number; signal?: AbortSignal },
  ): Promise<ScheduledTask | null> {
    this.assertWriter();
    options.signal?.throwIfAborted();
    const row = this.db.prepare(`
      SELECT * FROM scheduled_agent_tasks
      WHERE taskId = ? AND agentInstanceId = ? AND agentDefinitionId = ? AND executionNodeId = ?
        AND executionRevision = ?
    `).get(
      identity.taskId,
      identity.agentInstanceId,
      identity.agentDefinitionId,
      identity.executionNodeId,
      options.expectedExecutionRevision,
    ) as ScheduledTaskRow | undefined;
    if (!row) return null;
    const existing = this.scheduledTaskFromRow(row);
    const updated = { ...existing, executionRevision: options.expectedExecutionRevision + 1 } as ScheduledTask & Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete updated[key];
      else updated[key] = value;
    }
    options.signal?.throwIfAborted();
    const result = this.db.prepare(`
      UPDATE scheduled_agent_tasks SET
        state = ?, enabled = ?, updatedAt = ?, nextRunAt = ?, lastRunAt = ?,
        lastRunStatus = ?, lastError = ?, lastFailureAt = ?, consecutiveFailures = ?,
        nextRetryAt = ?, runCount = ?, executionRevision = ?, occurrenceId = ?,
        occurrenceScheduledFor = ?, occurrenceAttempt = ?
      WHERE taskId = ? AND agentInstanceId = ? AND agentDefinitionId = ?
        AND executionNodeId = ? AND executionRevision = ?
    `).run(
      updated.state,
      updated.enabled ? 1 : 0,
      updated.updatedAt,
      updated.nextRunAt ?? null,
      updated.lastRunAt ?? null,
      updated.lastRunStatus ?? null,
      updated.lastError ?? null,
      updated.lastFailureAt ?? null,
      updated.consecutiveFailures ?? 0,
      updated.nextRetryAt ?? null,
      updated.runCount ?? 0,
      updated.executionRevision,
      updated.occurrenceId ?? null,
      updated.occurrenceScheduledFor ?? null,
      updated.occurrenceAttempt ?? 0,
      identity.taskId,
      identity.agentInstanceId,
      identity.agentDefinitionId,
      identity.executionNodeId,
      options.expectedExecutionRevision,
    );
    return result.changes === 1 ? updated : null;
  }

  private agentRunFromRow(row: AgentRunRow): AgentRunRecord {
    return {
      runId: row.runId,
      conversationId: row.conversationId,
      definitionId: row.definitionId,
      turnId: row.turnId,
      requestPeerId: row.requestPeerId,
      requestId: row.requestId,
      payloadDigest: row.payloadDigest,
      ...(row.retrySourceTurnId !== null ? { retrySourceTurnId: row.retrySourceTurnId } : {}),
      state: row.state,
      acceptedAt: row.acceptedAt,
      updatedAt: row.updatedAt,
      ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
      ...(row.cancelRequestedAt !== null ? { cancelRequestedAt: row.cancelRequestedAt } : {}),
      ...(row.error !== null ? { error: normalizeAgentRunError(JSON.parse(row.error)) } : {}),
    };
  }

  private agentRunValues(record: AgentRunRecord): unknown[] {
    return [
      record.runId,
      record.conversationId,
      record.definitionId,
      record.turnId,
      record.requestPeerId,
      record.requestId,
      record.payloadDigest,
      (record as AgentRunRecord & { retrySourceTurnId?: string }).retrySourceTurnId ?? null,
      record.state,
      record.acceptedAt,
      record.updatedAt,
      record.startedAt ?? null,
      record.finishedAt ?? null,
      record.cancelRequestedAt ?? null,
      record.error ? canonicalJson(normalizeAgentRunError(record.error)) : null,
    ];
  }

  async retryTurnAtomic(input: AtomicAgentRetryInput): Promise<AtomicAgentRetryResult> {
    this.assertWriter();
    // Digesting is asynchronous. Clone first so a caller cannot mutate the
    // validated input while Web Crypto yields before the physical transaction.
    const atomicInput = structuredClone(input);
    const candidate = atomicInput.candidateRun;
    if (
      candidate.state !== 'accepted' ||
      candidate.retrySourceTurnId !== atomicInput.sourceTurnId ||
      candidate.turnId === atomicInput.sourceTurnId ||
      candidate.turnId !== atomicInput.replacementPayload.messageId ||
      candidate.turnId !== atomicInput.replacementPayload.turnId ||
      atomicInput.replacementPayload.role !== 'user' ||
      !candidate.runId ||
      !candidate.conversationId ||
      !candidate.definitionId ||
      !candidate.requestPeerId ||
      !candidate.requestId ||
      !atomicInput.originNodeId ||
      !Number.isSafeInteger(candidate.acceptedAt) ||
      !Number.isSafeInteger(candidate.updatedAt)
    ) throw new Error('atomic_agent_retry_identity');
    const expectedDigest = await digestAtomicAgentRetryPayload({
      conversationId: candidate.conversationId,
      definitionId: candidate.definitionId,
      sourceTurnId: atomicInput.sourceTurnId,
      newTurnId: candidate.turnId,
      replacementPayload: atomicInput.replacementPayload,
    });
    this.assertWriter();

    const transaction = this.db.transaction((): AtomicAgentRetryResult => {
      const existingRow = this.db.prepare(`
        SELECT * FROM agent_runs WHERE requestPeerId = ? AND requestId = ?
      `).get(candidate.requestPeerId, candidate.requestId) as AgentRunRow | undefined;
      if (candidate.payloadDigest !== expectedDigest) {
        throw new Error('atomic_agent_retry_payload_digest');
      }
      const readRawMessage = (messageId: string): ChatMessage | undefined => {
        const row = this.db.prepare(`
          SELECT * FROM messages WHERE conversationId = ? AND messageId = ?
        `).get(candidate.conversationId, messageId) as MessageRow | undefined;
        return row ? this.messageFromRow(row) : undefined;
      };
      const assertFreshSource = (): void => {
        if (atomicInput.mode !== 'fresh') return;
        const source = readRawMessage(atomicInput.sourceTurnId);
        if (
          !source ||
          source.role !== 'user' ||
          source.messageId !== atomicInput.sourceTurnId ||
          source.turnId !== atomicInput.sourceTurnId ||
          source.conversationId !== candidate.conversationId
        ) throw new Error('atomic_agent_retry_source_not_found');
        assertAtomicAgentRetrySourceMessage(atomicInput.expectedSourceMessage, source);
        if (
          canonicalJson(createAtomicAgentRetryReplacementPayload(source, candidate.turnId)) !==
            canonicalJson(atomicInput.replacementPayload)
        ) throw new Error('atomic_agent_retry_replacement_source_drift');
      };
      const readExistingResult = (run: AgentRunRecord): AtomicAgentRetryResult => {
        const drafts = createAtomicAgentRetryEventDrafts(run, atomicInput);
        const tombstoneRow = this.conversationEventById.get(drafts[0].eventId) as
          | { eventJson: string }
          | undefined;
        const userRow = this.conversationEventById.get(drafts[1].eventId) as
          | { eventJson: string }
          | undefined;
        if (!tombstoneRow || !userRow) throw new Error('atomic_agent_retry_replay_incomplete');
        // Re-run preparation as a read-only exact-draft comparison. Existing
        // causal clocks are retained, while any origin/timestamp/payload drift fails.
        const [tombstone, userEvent] = this.prepareLocalEventsInTransaction(drafts);
        if (tombstone?.kind !== 'tombstone' || userEvent?.kind !== 'message') {
          throw new Error('atomic_agent_retry_replay_invalid');
        }
        const result: AtomicAgentRetryResult = {
          run,
          created: false,
          tombstone,
          userEvent,
        };
        assertAtomicAgentRetryResult(atomicInput, result);
        return result;
      };

      if (existingRow) {
        const existing = this.agentRunFromRow(existingRow);
        if (
          existing.conversationId !== candidate.conversationId ||
          existing.definitionId !== candidate.definitionId ||
          existing.turnId !== candidate.turnId ||
          existing.requestPeerId !== candidate.requestPeerId ||
          existing.requestId !== candidate.requestId ||
          existing.payloadDigest !== candidate.payloadDigest ||
          existing.retrySourceTurnId !== atomicInput.sourceTurnId
        ) {
          throw new AgentRunRequestConflictError(candidate.requestPeerId, candidate.requestId);
        }
        assertFreshSource();
        return readExistingResult(existing);
      }
      if (atomicInput.mode !== 'fresh') throw new Error('atomic_agent_retry_replay_not_found');
      assertFreshSource();
      if (this.turnIsTombstoned.get(candidate.conversationId, atomicInput.sourceTurnId)) {
        throw new Error('atomic_agent_retry_source_not_live');
      }

      const insertedRun = this.db.prepare(`
        INSERT INTO agent_runs (
          runId, conversationId, definitionId, turnId, requestPeerId, requestId,
          payloadDigest, retrySourceTurnId, state, acceptedAt, updatedAt, startedAt, finishedAt,
          cancelRequestedAt, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...this.agentRunValues(candidate));
      if (insertedRun.changes !== 1) throw new Error('atomic_agent_retry_run_insert_failed');

      const events = this.prepareLocalEventsInTransaction(
        createAtomicAgentRetryEventDrafts(candidate, atomicInput),
      );
      let changed = false;
      for (const event of events) {
        changed = this.insertAndProjectConversationEvent(event) || changed;
      }
      if (changed) {
        this.refreshConversationProjectionV2(candidate.conversationId);
        this.rebuildAllTimelineOrdinalsV2(candidate.conversationId);
        this.bumpConversationListRevision();
      }
      const [tombstone, userEvent] = events;
      if (tombstone?.kind !== 'tombstone' || userEvent?.kind !== 'message') {
        throw new Error('atomic_agent_retry_persisted_events_invalid');
      }
      const result: AtomicAgentRetryResult = {
        run: candidate,
        created: true,
        tombstone,
        userEvent,
      };
      assertAtomicAgentRetryResult(atomicInput, result);
      return result;
    });
    return transaction.immediate();
  }

  async createOrGet(record: AgentRunRecord): Promise<AgentRunRecord> {
    this.assertWriter();
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO agent_runs (
          runId, conversationId, definitionId, turnId, requestPeerId, requestId,
          payloadDigest, retrySourceTurnId, state, acceptedAt, updatedAt, startedAt, finishedAt,
          cancelRequestedAt, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(requestPeerId, requestId) DO NOTHING
      `).run(...this.agentRunValues(record));
      if (result.changes > 0) return record;
      const existing = this.db.prepare(`
        SELECT * FROM agent_runs WHERE requestPeerId = ? AND requestId = ?
      `).get(record.requestPeerId, record.requestId) as AgentRunRow | undefined;
      if (!existing || existing.payloadDigest !== record.payloadDigest) {
        throw new AgentRunRequestConflictError(record.requestPeerId, record.requestId);
      }
      return this.agentRunFromRow(existing);
    })();
  }

  async get(runId: string): Promise<AgentRunRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE runId = ?`).get(runId) as
      | AgentRunRow
      | undefined;
    return row ? this.agentRunFromRow(row) : undefined;
  }

  async getByRequest(
    requestPeerId: string,
    requestId: string,
  ): Promise<AgentRunRecord | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM agent_runs WHERE requestPeerId = ? AND requestId = ?
    `).get(requestPeerId, requestId) as AgentRunRow | undefined;
    return row ? this.agentRunFromRow(row) : undefined;
  }

  async getByTurn(
    conversationId: string,
    turnId: string,
    requestPeerId: string,
  ): Promise<AgentRunRecord | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE conversationId = ? AND turnId = ? AND requestPeerId = ?
      ORDER BY updatedAt DESC, runId DESC LIMIT 1
    `).get(conversationId, turnId, requestPeerId) as AgentRunRow | undefined;
    return row ? this.agentRunFromRow(row) : undefined;
  }

  async transition(
    runId: string,
    expectedStates: readonly AgentRunState[],
    next: AgentRunRecord,
  ): Promise<boolean> {
    this.assertWriter();
    const activeStates = expectedStates.filter(state => state === 'accepted' || state === 'queued' || state === 'running');
    if (activeStates.length === 0 || runId !== next.runId) return false;
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM agent_runs WHERE runId = ?`).get(runId) as
        | AgentRunRow
        | undefined;
      if (
        !existing ||
        existing.conversationId !== next.conversationId ||
        existing.definitionId !== next.definitionId ||
        existing.turnId !== next.turnId ||
        existing.requestPeerId !== next.requestPeerId ||
        existing.requestId !== next.requestId ||
        existing.payloadDigest !== next.payloadDigest ||
        (existing.retrySourceTurnId ?? undefined) !==
          (next as AgentRunRecord & { retrySourceTurnId?: string }).retrySourceTurnId
      ) {
        if (!existing) return false;
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `cannot change immutable run identity ${runId}`,
          retryable: false,
        });
      }
      const legalNextStates: Record<AgentRunState, readonly AgentRunState[]> = {
        accepted: ['queued', 'failed', 'cancelled'],
        queued: ['running', 'failed', 'cancelled'],
        running: ['completed', 'failed', 'cancelled'],
        completed: [],
        failed: [],
        cancelled: [],
      };
      if (!legalNextStates[existing.state].includes(next.state)) return false;
      const placeholders = activeStates.map(() => '?').join(', ');
      const result = this.db.prepare(`
        UPDATE agent_runs SET
          state = ?, updatedAt = ?, startedAt = ?, finishedAt = ?,
          cancelRequestedAt = ?, error = ?
        WHERE runId = ? AND state IN (${placeholders})
      `).run(
        next.state,
        next.updatedAt,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.cancelRequestedAt ?? null,
        next.error ? canonicalJson(normalizeAgentRunError(next.error)) : null,
        runId,
        ...activeStates,
      );
      return result.changes === 1;
    })();
  }

  async listActive(): Promise<AgentRunRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE state IN ('accepted', 'queued', 'running')
      ORDER BY acceptedAt, runId
    `).all() as AgentRunRow[];
    return rows.map(row => this.agentRunFromRow(row));
  }

  async prune(options: { finishedBefore: number; maxRecords: number }): Promise<void> {
    this.assertWriter();
    const maximum = Math.max(0, Math.floor(options.maxRecords));
    this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM agent_runs
        WHERE finishedAt IS NOT NULL AND finishedAt < ?
      `).run(options.finishedBefore);
      const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM agent_runs`).get() as {
        count: number;
      }).count;
      const excess = Math.max(0, count - maximum);
      if (excess > 0) {
        this.db.prepare(`
          DELETE FROM agent_runs WHERE runId IN (
            SELECT runId FROM agent_runs WHERE finishedAt IS NOT NULL
            ORDER BY updatedAt, runId LIMIT ?
          )
        `).run(excess);
      }
    })();
  }
}

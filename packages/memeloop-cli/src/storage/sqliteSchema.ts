import Database from 'better-sqlite3';

import { PERMISSIONS_TABLE_DDL } from 'memeloop';

/**
 * The CLI storage schema is deliberately immutable: existing non-canonical
 * databases must be cleared rather than migrated in place. Keep the table
 * shape and statement order here together, outside the storage implementation.
 */
export const SQLITE_SCHEMA_VERSION = 1;

export const CANONICAL_SQLITE_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  conversations: [
    'conversationId',
    'title',
    'lastMessagePreview',
    'lastMessageTimestamp',
    'messageCount',
    'originNodeId',
    'originClock',
    'definitionId',
    'instanceDeltaJson',
    'isUserInitiated',
    'sourceChannelJson',
  ],
  messages: [
    'messageId',
    'conversationId',
    'originNodeId',
    'originSequence',
    'turnId',
    'timestamp',
    'lamportClock',
    'role',
    'content',
    'partsJson',
    'toolCallsJson',
    'attachmentsJson',
    'detailRefJson',
    'reasoningContent',
    'contentType',
    'hidden',
    'duration',
    'metadataJson',
    'canonicalBytes',
    'canonicalJson',
  ],
  conversation_events: [
    'eventId',
    'conversationId',
    'originNodeId',
    'originSequence',
    'lamportClock',
    'timestamp',
    'kind',
    'turnId',
    'eventJson',
  ],
  conversation_event_sequences: ['conversationId', 'originNodeId', 'lastSequence', 'contiguousFrontier'],
  conversation_turn_tombstones: [
    'eventId',
    'conversationId',
    'turnId',
    'originNodeId',
    'originSequence',
    'lamportClock',
    'timestamp',
    'reason',
    'digest',
  ],
  conversation_metadata_fields: [
    'conversationId',
    'field',
    'valueJson',
    'lamportClock',
    'originNodeId',
    'eventId',
  ],
  agent_runs: [
    'runId',
    'conversationId',
    'definitionId',
    'turnId',
    'requestPeerId',
    'requestId',
    'payloadDigest',
    'retrySourceTurnId',
    'state',
    'acceptedAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'cancelRequestedAt',
    'error',
  ],
  scheduled_agent_tasks: [
    'taskId',
    'agentInstanceId',
    'agentDefinitionId',
    'name',
    'scheduleJson',
    'payloadJson',
    'activeHoursStart',
    'activeHoursEnd',
    'enabled',
    'createdBy',
    'state',
    'executionNodeId',
    'executionNodeLabel',
    'originNodeId',
    'updatedAt',
    'nextRunAt',
    'lastRunAt',
    'lastRunStatus',
    'lastError',
    'lastFailureAt',
    'consecutiveFailures',
    'nextRetryAt',
    'runCount',
    'maxRuns',
    'deleteAfterRun',
    'executionRevision',
    'occurrenceId',
    'occurrenceScheduledFor',
    'occurrenceAttempt',
  ],
  conversation_timeline_state_v2: [
    'conversationId',
    'revision',
    'totalMessages',
    'totalTurns',
    'totalEntries',
  ],
  conversation_timeline_entries_v2: [
    'entryId',
    'cursor',
    'conversationId',
    'timestamp',
    'lamportClock',
    'originNodeId',
    'kind',
    'messageId',
    'turnId',
    'role',
    'actorId',
    'actorLabel',
    'preview',
    'entryOrdinal',
    'turnOrdinal',
    'summaryPreview',
    'compactedMessageCount',
    'compactedTurnCount',
    'coveredVersionJson',
  ],
  conversation_list_state_v2: ['id', 'revision'],
  attachments: ['contentHash', 'filename', 'mimeType', 'size', 'data'],
  attachment_sync_staging: ['contentHash', 'filename', 'mimeType', 'size', 'nextOffset'],
  attachment_sync_chunks: ['contentHash', 'offset', 'data'],
  conversation_attachment_references: ['conversationId', 'contentHash', 'messageId'],
  agent_instances: [
    'instanceId',
    'definitionId',
    'nodeId',
    'conversationId',
    'createdAt',
    'updatedAt',
    'definitionDeltaJson',
  ],
  agent_definitions: ['definitionId', 'definitionJson', 'updatedAt'],
  im_bindings: [
    'channelId',
    'imUserId',
    'activeConversationId',
    'createdAt',
    'defaultDefinitionId',
    'updatedAt',
    'pendingQuestionId',
  ],
  permissions: ['source', 'rulesJson', 'updatedAt'],
};

const CANONICAL_SQLITE_TABLE_NAMES = Object.keys(CANONICAL_SQLITE_TABLE_COLUMNS).sort();
type CanonicalTableName = keyof typeof CANONICAL_SQLITE_TABLE_COLUMNS;

export interface SQLiteSchemaHooks {
  rebuildAllTimelineOrdinalsV2(): void;
  rebuildTimelineProjectionV2(conversationId: string): void;
}

function isFreshCanonicalDatabase(database: Database.Database): boolean {
  const row = database.prepare<[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'memeloop_writer_lease'
  `).get();
  return (row?.count ?? 0) === 0;
}

function assertCanonicalSchema(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (version !== SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `incompatible SQLite schema (version ${version || 0}); clear the data directory and retry`,
    );
  }
  const rows = database.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'memeloop_writer_lease'
    ORDER BY name
  `).all();
  const actualNames = rows.map(row => row.name).sort();
  if (actualNames.join('\0') !== CANONICAL_SQLITE_TABLE_NAMES.join('\0')) {
    throw new Error(
      'incompatible SQLite schema (tables differ from the canonical schema); clear the data directory and retry',
    );
  }
  for (const [table, expected] of Object.entries(CANONICAL_SQLITE_TABLE_COLUMNS)) {
    const columns = database.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
    if (columns.map(column => column.name).join('\0') !== expected.join('\0')) {
      throw new Error(
        `incompatible SQLite schema (columns differ for ${table}); clear the data directory and retry`,
      );
    }
  }
}

function assertCanonicalTableColumns(database: Database.Database, table: CanonicalTableName): void {
  const expected = CANONICAL_SQLITE_TABLE_COLUMNS[table];
  const columns = database.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (columns.map(column => column.name).join('\0') !== expected.join('\0')) {
    throw new Error(
      `incompatible SQLite schema (columns differ for ${table}); clear the data directory and retry`,
    );
  }
}

function assertCanonicalMessagesTable(database: Database.Database): void {
  assertCanonicalTableColumns(database, 'messages');
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_cursor
    ON messages(conversationId, timestamp, lamportClock, originNodeId, messageId)
  `).run();
  database.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_origin_sequence
    ON messages(conversationId, originNodeId, originSequence)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_turn_cursor
    ON messages(conversationId, turnId, timestamp, lamportClock, originNodeId, messageId)
  `).run();
}

function assertCanonicalAgentRunsTable(database: Database.Database): void {
  assertCanonicalTableColumns(database, 'agent_runs');
}

function assertCanonicalImBindingsTable(database: Database.Database): void {
  assertCanonicalTableColumns(database, 'im_bindings');
}

function assertOrCreateCanonicalTimelineEntriesTable(
  database: Database.Database,
  allowCreate: boolean,
): boolean {
  const table = database.prepare<[string], { sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get('conversation_timeline_entries_v2');
  const columns = table === undefined
    ? []
    : database.prepare<[], { name: string }>(
      `PRAGMA table_info(conversation_timeline_entries_v2)`,
    ).all();
  const names = new Set(columns.map(column => column.name));
  const compatible = table?.sql?.includes("kind IN ('message', 'compaction')") === true &&
    ['messageId', 'role', 'actorId', 'actorLabel', 'preview', 'entryOrdinal', 'turnOrdinal']
      .every(name => names.has(name));
  if (table !== undefined && !compatible) {
    throw new Error(
      'incompatible SQLite schema (columns differ for conversation_timeline_entries_v2); clear the data directory and retry',
    );
  }
  if (table === undefined && !allowCreate) {
    throw new Error(
      'incompatible SQLite schema (missing conversation_timeline_entries_v2); clear the data directory and retry',
    );
  }
  if (table === undefined) {
    database.prepare(`
      CREATE TABLE conversation_timeline_entries_v2 (
        entryId TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        lamportClock INTEGER NOT NULL,
        originNodeId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'compaction')),
        messageId TEXT,
        turnId TEXT NOT NULL,
        role TEXT,
        actorId TEXT,
        actorLabel TEXT,
        preview TEXT,
        entryOrdinal INTEGER NOT NULL DEFAULT 0,
        turnOrdinal INTEGER,
        summaryPreview TEXT,
        compactedMessageCount INTEGER,
        compactedTurnCount INTEGER,
        coveredVersionJson TEXT
      )
    `).run();
  }
  return !compatible;
}

/** Creates only the immutable canonical schema, in the legacy statement order. */
export function initializeCanonicalSchema(database: Database.Database, hooks: SQLiteSchemaHooks): void {
  const fresh = isFreshCanonicalDatabase(database);
  if (!fresh) assertCanonicalSchema(database);

  database.prepare(`
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
  `).run();
  database.prepare(`
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
  `).run();
  assertCanonicalMessagesTable(database);

  database.prepare(`
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
  database.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_origin_sequence
    ON conversation_events(conversationId, originNodeId, originSequence)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_conversation_events_sync_cursor
    ON conversation_events(conversationId, originNodeId, originSequence, eventId)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_conversation_events_kind_turn
    ON conversation_events(
      conversationId, kind, turnId, originNodeId, originSequence, eventId
    )
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_event_sequences (
      conversationId TEXT NOT NULL,
      originNodeId TEXT NOT NULL,
      lastSequence INTEGER NOT NULL,
      contiguousFrontier INTEGER NOT NULL,
      PRIMARY KEY (conversationId, originNodeId)
    )
  `).run();
  database.prepare(`
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
  database.prepare(`
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
  database.prepare(`
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
  assertCanonicalAgentRunsTable(database);
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_active
    ON agent_runs(state, updatedAt)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_turn_peer
    ON agent_runs(conversationId, turnId, requestPeerId, updatedAt)
  `).run();

  database.prepare(`
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
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_agent_tasks_rpc_page
    ON scheduled_agent_tasks(agentInstanceId, executionNodeId, state, updatedAt DESC, taskId DESC)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_agent_tasks_restore
    ON scheduled_agent_tasks(executionNodeId, state, enabled, taskId)
  `).run();

  database.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_timeline_state_v2 (
      conversationId TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      totalMessages INTEGER NOT NULL DEFAULT 0,
      totalTurns INTEGER NOT NULL DEFAULT 0,
      totalEntries INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  const rebuildTimelineProjection = assertOrCreateCanonicalTimelineEntriesTable(database, fresh);
  if (fresh) hooks.rebuildAllTimelineOrdinalsV2();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_timeline_entries_v2_cursor
    ON conversation_timeline_entries_v2(
      conversationId, timestamp, lamportClock, originNodeId, entryId
    )
  `).run();
  database.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_entries_v2_stable_cursor
    ON conversation_timeline_entries_v2(conversationId, cursor)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_timeline_entries_v2_turn_messages
    ON conversation_timeline_entries_v2(conversationId, turnId)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_timeline_entries_v2_ordinal
    ON conversation_timeline_entries_v2(conversationId, entryOrdinal)
  `).run();
  if (rebuildTimelineProjection) {
    const conversations = database.prepare<[], { conversationId: string }>(`
      SELECT DISTINCT conversationId FROM conversation_events
      UNION
      SELECT DISTINCT conversationId FROM messages
    `).all();
    for (const row of conversations) hooks.rebuildTimelineProjectionV2(row.conversationId);
  }
  database.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_list_state_v2 (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  database.prepare(`
    INSERT OR IGNORE INTO conversation_list_state_v2 (id, revision) VALUES (1, 0)
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_conversations_list_cursor
    ON conversations(lastMessageTimestamp, conversationId)
  `).run();

  database.prepare(`
    CREATE TABLE IF NOT EXISTS attachments (
      contentHash TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL
    );
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS attachment_sync_staging (
      contentHash TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      nextOffset INTEGER NOT NULL
    )
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS attachment_sync_chunks (
      contentHash TEXT NOT NULL,
      offset INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (contentHash, offset),
      FOREIGN KEY (contentHash) REFERENCES attachment_sync_staging(contentHash) ON DELETE CASCADE
    )
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_attachment_references (
      conversationId TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      messageId TEXT NOT NULL,
      PRIMARY KEY (conversationId, contentHash, messageId)
    )
  `).run();
  database.prepare(`
    CREATE INDEX IF NOT EXISTS idx_conversation_attachment_lookup
    ON conversation_attachment_references(conversationId, contentHash)
  `).run();

  database.prepare(`
    CREATE TABLE IF NOT EXISTS agent_instances (
      instanceId TEXT PRIMARY KEY,
      definitionId TEXT NOT NULL,
      nodeId TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      definitionDeltaJson TEXT
    );
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS agent_definitions (
      definitionId TEXT PRIMARY KEY,
      definitionJson TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `).run();
  database.prepare(`
    CREATE TABLE IF NOT EXISTS im_bindings (
      channelId TEXT NOT NULL,
      imUserId TEXT NOT NULL,
      activeConversationId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      defaultDefinitionId TEXT,
      updatedAt INTEGER NOT NULL,
      pendingQuestionId TEXT,
      PRIMARY KEY (channelId, imUserId)
    );
  `).run();
  assertCanonicalImBindingsTable(database);

  database.exec(PERMISSIONS_TABLE_DDL);
  if (fresh) database.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
}

/** Install lease fencing triggers after the owner token function is registered. */
export function installFencingTriggers(database: Database.Database): void {
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
      database.exec(`
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

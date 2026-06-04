import Database from 'better-sqlite3';

import type { AgentDefinition, AgentInstanceMeta, AttachmentRef as AttachmentReference, ChatMessage, ConversationMeta } from '../protocol/index.js';

import { PERMISSIONS_TABLE_DDL } from '../permission/storage.js';
import type { ImChannelBindingRecord } from '../types.js';

import type { GetMessagesOptions, IAgentStorage, ListConversationsOptions } from './interface.js';

export interface SQLiteAgentStorageOptions {
  /**
   * SQLite 文件路径，默认使用内存数据库（测试友好）。
   */
  filename?: string;
}

export class SQLiteAgentStorage implements IAgentStorage {
  private db: Database.Database;

  constructor(options: SQLiteAgentStorageOptions = {}) {
    const filename = options.filename ?? ':memory:';
    this.db = new Database(filename);
    this.migrate();
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
          timestamp INTEGER NOT NULL,
          lamportClock INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          toolCallsJson TEXT,
          attachmentsJson TEXT,
          detailRefJson TEXT
        );
      `,
      )
      .run();

    this.ensureMessagesDetailRefColumn();

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
          defaultDefinitionId TEXT,
          updatedAt INTEGER NOT NULL,
          PRIMARY KEY (channelId, imUserId)
        );
      `,
      )
      .run();

    this.ensureImBindingsPendingQuestionColumn();

    this.db.exec(PERMISSIONS_TABLE_DDL);
  }

  /** Upgrades DBs created before `DetailRef` column existed. */
  private ensureMessagesDetailRefColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (cols.some((c) => c.name === 'detailRefJson')) return;
    this.db.prepare(`ALTER TABLE messages ADD COLUMN detailRefJson TEXT`).run();
  }

  private ensureImBindingsPendingQuestionColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(im_bindings)`).all() as { name: string }[];
    if (cols.some((c) => c.name === 'pendingQuestionId')) return;
    this.db.prepare(`ALTER TABLE im_bindings ADD COLUMN pendingQuestionId TEXT`).run();
  }

  async listConversations(options: ListConversationsOptions = {}): Promise<ConversationMeta[]> {
    const { limit = 50, offset = 0 } = options;
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM conversations
        ORDER BY lastMessageTimestamp DESC
        LIMIT ? OFFSET ?;
      `,
      )
      .all(limit, offset) as any[];

    return rows.map((row) => {
      const meta: ConversationMeta = {
        conversationId: row.conversationId,
        title: row.title,
        lastMessagePreview: row.lastMessagePreview,
        lastMessageTimestamp: row.lastMessageTimestamp,
        messageCount: row.messageCount,
        originNodeId: row.originNodeId,
        definitionId: row.definitionId,
        instanceDelta: row.instanceDeltaJson ? JSON.parse(row.instanceDeltaJson) : undefined,
        isUserInitiated: Boolean(row.isUserInitiated),
        sourceChannel: row.sourceChannelJson ? JSON.parse(row.sourceChannelJson) : undefined,
      };
      return meta;
    });
  }

  async getMessages(
    conversationId: string,
    _options: GetMessagesOptions = {},
  ): Promise<ChatMessage[]> {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM messages
        WHERE conversationId = ?
        ORDER BY timestamp ASC, lamportClock ASC;
      `,
      )
      .all(conversationId) as any[];

    return rows.map((row) => {
      const message: ChatMessage = {
        messageId: row.messageId,
        conversationId: row.conversationId,
        originNodeId: row.originNodeId,
        timestamp: row.timestamp,
        lamportClock: row.lamportClock,
        role: row.role,
        content: row.content,
        toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : undefined,
        attachments: row.attachmentsJson ? JSON.parse(row.attachmentsJson) : undefined,
        detailRef: row.detailRefJson ? JSON.parse(row.detailRefJson) : undefined,
      };
      return message;
    });
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const upsertConversation = this.db.prepare(
      `
      INSERT INTO conversations (
        conversationId, title, lastMessagePreview, lastMessageTimestamp, messageCount,
        originNodeId, definitionId, instanceDeltaJson, isUserInitiated, sourceChannelJson
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversationId) DO UPDATE SET
        lastMessagePreview = excluded.lastMessagePreview,
        lastMessageTimestamp = excluded.lastMessageTimestamp,
        messageCount = conversations.messageCount + 1;
    `,
    );

    const insertMessage = this.db.prepare(
      `
      INSERT INTO messages (
        messageId, conversationId, originNodeId, timestamp, lamportClock,
        role, content, toolCallsJson, attachmentsJson, detailRefJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    );

    const definitionId = message.conversationId.includes(':')
      ? message.conversationId.split(':').slice(0, -1).join(':')
      : message.conversationId;

    const preview = typeof message.content === 'string'
      ? message.content.slice(0, 200)
      : String(message.content).slice(0, 200);

    const isAuxiliaryConversation = message.conversationId.startsWith('terminal:') ||
      message.conversationId.startsWith('spawn:') ||
      message.conversationId.startsWith('remote:');
    const isUserInitiated = isAuxiliaryConversation ? 0 : 1;

    const tx = this.db.transaction(() => {
      upsertConversation.run(
        message.conversationId,
        definitionId,
        preview,
        message.timestamp,
        1,
        message.originNodeId,
        definitionId,
        null,
        isUserInitiated,
        null,
      );
      insertMessage.run(
        message.messageId,
        message.conversationId,
        message.originNodeId,
        message.timestamp,
        message.lamportClock,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.attachments ? JSON.stringify(message.attachments) : null,
        message.detailRef ? JSON.stringify(message.detailRef) : null,
      );
    });

    tx();
  }

  async upsertConversationMetadata(meta: ConversationMeta): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO conversations (
          conversationId, title, lastMessagePreview, lastMessageTimestamp, messageCount,
          originNodeId, definitionId, instanceDeltaJson, isUserInitiated, sourceChannelJson
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversationId) DO UPDATE SET
          title = excluded.title,
          lastMessagePreview = excluded.lastMessagePreview,
          lastMessageTimestamp = excluded.lastMessageTimestamp,
          messageCount = excluded.messageCount,
          originNodeId = excluded.originNodeId,
          definitionId = excluded.definitionId,
          instanceDeltaJson = excluded.instanceDeltaJson,
          isUserInitiated = excluded.isUserInitiated,
          sourceChannelJson = excluded.sourceChannelJson;
      `,
      )
      .run(
        meta.conversationId,
        meta.title,
        meta.lastMessagePreview,
        meta.lastMessageTimestamp,
        meta.messageCount,
        meta.originNodeId,
        meta.definitionId,
        meta.instanceDelta ? JSON.stringify(meta.instanceDelta) : null,
        meta.isUserInitiated ? 1 : 0,
        meta.sourceChannel ? JSON.stringify(meta.sourceChannel) : null,
      );
  }

  async insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const insertIgnore = this.db.prepare(
      `
      INSERT OR IGNORE INTO messages (
        messageId, conversationId, originNodeId, timestamp, lamportClock,
        role, content, toolCallsJson, attachmentsJson, detailRefJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    );
    const affected = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        const info = insertIgnore.run(
          m.messageId,
          m.conversationId,
          m.originNodeId,
          m.timestamp,
          m.lamportClock,
          m.role,
          m.content,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.attachments ? JSON.stringify(m.attachments) : null,
          m.detailRef ? JSON.stringify(m.detailRef) : null,
        );
        if (info.changes > 0) {
          affected.add(m.conversationId);
        }
      }
    });
    tx();
    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as c FROM messages WHERE conversationId = ?;`,
    );
    const upd = this.db.prepare(
      `UPDATE conversations SET messageCount = ? WHERE conversationId = ?;`,
    );
    for (const cid of affected) {
      const row = countStmt.get(cid) as { c: number } | undefined;
      const c = row?.c ?? 0;
      upd.run(c, cid);
    }
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
      .get(contentHash) as any | undefined;

    if (!row) return null;

    const reference: AttachmentReference = {
      contentHash: row.contentHash,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
    };
    return reference;
  }

  async saveAttachment(reference: AttachmentReference, data: Buffer | Uint8Array): Promise<void> {
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

  /**
   * 启动时由节点写入（builtin + YAML）；亦可单独持久化供仅 DB 可用的定义。
   */
  seedAgentDefinitions(definitions: AgentDefinition[]): void {
    const stmt = this.db.prepare(
      `
      INSERT OR REPLACE INTO agent_definitions (definitionId, definitionJson, updatedAt)
      VALUES (?, ?, ?);
    `,
    );
    const now = Date.now();
    for (const def of definitions) {
      stmt.run(def.id, JSON.stringify(def), now);
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
        FROM messages
        WHERE conversationId = ?;
      `,
      )
      .get(conversationId) as { m: number } | undefined;
    return typeof row?.m === 'number' ? row.m : 0;
  }

  async saveAgentInstance(meta: AgentInstanceMeta): Promise<void> {
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
      .get(conversationId) as any | undefined;

    if (!row) return null;

    return {
      conversationId: row.conversationId,
      title: row.title,
      lastMessagePreview: row.lastMessagePreview,
      lastMessageTimestamp: row.lastMessageTimestamp,
      messageCount: row.messageCount,
      originNodeId: row.originNodeId,
      definitionId: row.definitionId,
      instanceDelta: row.instanceDeltaJson ? JSON.parse(row.instanceDeltaJson) : undefined,
      isUserInitiated: Boolean(row.isUserInitiated),
      sourceChannel: row.sourceChannelJson ? JSON.parse(row.sourceChannelJson) : undefined,
    };
  }

  async getImBinding(channelId: string, imUserId: string): Promise<ImChannelBindingRecord | null> {
    const row = this.db
      .prepare(
        `
        SELECT channelId, imUserId, activeConversationId, defaultDefinitionId, pendingQuestionId, updatedAt
        FROM im_bindings WHERE channelId = ? AND imUserId = ? LIMIT 1
      `,
      )
      .get(channelId, imUserId) as
        | {
          channelId: string;
          imUserId: string;
          activeConversationId: string;
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
      defaultDefinitionId: row.defaultDefinitionId ?? undefined,
      pendingQuestionId: row.pendingQuestionId ?? undefined,
    };
  }

  async setImBinding(record: ImChannelBindingRecord): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO im_bindings (channelId, imUserId, activeConversationId, defaultDefinitionId, pendingQuestionId, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
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
        record.defaultDefinitionId ?? null,
        record.pendingQuestionId ?? null,
        now,
      );
  }
}

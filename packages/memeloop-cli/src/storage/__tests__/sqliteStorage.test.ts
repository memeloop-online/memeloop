import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildConversationTimelinePage, canonicalJsonString, ChatSyncEngine, isConversationEvent, messageToConversationEvent, versionVectorKey } from 'memeloop';
import type { AgentDefinition, AgentRunRecord, AttachmentReference, ChatMessage, ChatSyncPeer, ConversationEvent, ConversationMeta, VersionRange } from 'memeloop';
import { nextLamportClockForConversation } from 'memeloop/loop-api';

import { SQLiteAgentStorage } from '../sqliteStorage.js';

function createConversationMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    conversationId: 'c1',
    title: 'Test',
    lastMessagePreview: 'hi',
    lastMessageTimestamp: Date.now(),
    messageCount: 1,
    originNodeId: 'node-1',
    originClock: 1,
    definitionId: 'memeloop:test',
    isUserInitiated: true,
    ...overrides,
  };
}

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const messageId = overrides.messageId ?? 'm1';
  const lamportClock = overrides.lamportClock ?? 1;
  const role = overrides.role ?? 'user';
  return {
    messageId,
    turnId: overrides.turnId ?? (role === 'user' ? messageId : messageId),
    conversationId: 'c1',
    originNodeId: 'node-1',
    timestamp: Date.now(),
    originSequence: overrides.originSequence ?? lamportClock,
    lamportClock,
    role,
    content: 'hello',
    ...overrides,
  };
}

async function persistMessages(
  storage: SQLiteAgentStorage,
  messages: readonly ChatMessage[],
): Promise<void> {
  for (const conversationId of new Set(messages.map(message => message.conversationId))) {
    if (await storage.getConversationMeta(conversationId)) continue;
    const first = messages.find(message => message.conversationId === conversationId)!;
    await storage.upsertConversationMetadata(createConversationMeta({
      conversationId,
      definitionId: 'memeloop:test-explicit',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: first.originNodeId,
      originClock: 0,
    }));
  }
  await storage.insertEventsIfAbsent(messages.map(messageToConversationEvent));
}

async function initializeConversation(
  storage: SQLiteAgentStorage,
  conversationId: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<void> {
  await storage.upsertConversationMetadata(createConversationMeta({
    conversationId,
    title: conversationId,
    lastMessagePreview: '',
    lastMessageTimestamp: 0,
    messageCount: 0,
    originClock: 0,
    definitionId: 'memeloop:test-explicit',
    ...overrides,
  }));
}

function sqliteSyncPeer(nodeId: string, storage: SQLiteAgentStorage): ChatSyncPeer {
  return {
    nodeId,
    async exchangeVersionFrontierPage(
      localFrontiers,
      remoteAfter,
      includeRemotePage,
      conversationIds,
      options,
    ) {
      const remotePage = includeRemotePage
        ? await storage.getEventVersionFrontierPage({
          limit: 128,
          ...(remoteAfter ? { after: remoteAfter } : {}),
          ...(conversationIds ? { conversationIds } : {}),
          signal: options?.signal,
        })
        : { items: [] };
      const storedForLocal = await storage.getEventVersionFrontiersForKeys(
        localFrontiers.map(frontier => ({
          conversationId: frontier.conversationId,
          originNodeId: frontier.originNodeId,
        })),
        { signal: options?.signal },
      );
      const storedByKey = new Map(storedForLocal.map(frontier => [
        versionVectorKey(frontier.conversationId, frontier.originNodeId),
        frontier.maxContiguousOriginSequence,
      ]));
      const missingForRemote: VersionRange[] = localFrontiers.flatMap(frontier => {
        const stored = storedByKey.get(versionVectorKey(
          frontier.conversationId,
          frontier.originNodeId,
        )) ?? 0;
        return frontier.maxContiguousOriginSequence > stored
          ? [{
            conversationId: frontier.conversationId,
            originNodeId: frontier.originNodeId,
            fromExclusive: stored,
            toInclusive: frontier.maxContiguousOriginSequence,
          }]
          : [];
      });
      return { remotePage, missingForRemote };
    },
    async pullMissingEvents(conversationId, ranges, cursor, options) {
      const page = await storage.getConversationEventPage(conversationId, {
        limit: 128,
        direction: 'forward',
        ...(cursor ? { after: cursor } : {}),
        ranges: ranges.map(range => ({
          originNodeId: range.originNodeId,
          fromExclusive: range.fromExclusive,
          toInclusive: range.toInclusive,
        })),
        signal: options?.signal,
      });
      return {
        items: page.items,
        ...(page.hasMoreAfter && page.endCursor ? { nextCursor: page.endCursor } : {}),
      };
    },
    async pushEvents(events) {
      await storage.insertEventsIfAbsent(events);
    },
  };
}

async function syncSqliteStores(
  localNodeId: string,
  local: SQLiteAgentStorage,
  remoteNodeId: string,
  remote: SQLiteAgentStorage,
): Promise<void> {
  await new ChatSyncEngine({
    nodeId: localNodeId,
    storage: local,
    peers: () => [sqliteSyncPeer(remoteNodeId, remote)],
    failOnMessageSyncError: true,
  }).syncOnce();
}

describe('SQLiteAgentStorage', () => {
  it('merges 100k shuffled remote messages linearly and revisions compaction/tombstone pages', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'scale-merge');
    const events = Array.from({ length: 100_000 }, (_, index): ConversationEvent => {
      const sequence = (index * 7_919) % 100_000 + 1;
      const eventId = `remote-${sequence.toString().padStart(6, '0')}`;
      return {
        eventId,
        conversationId: 'scale-merge',
        originNodeId: 'remote-origin',
        originSequence: sequence,
        lamportClock: sequence,
        timestamp: sequence,
        kind: 'message',
        message: {
          messageId: eventId,
          turnId: eventId,
          role: 'user',
          content: `remote ${sequence}`,
        },
      };
    });
    const db = (storage as unknown as { db: Database.Database }).db;
    const prepare = vi.spyOn(db, 'prepare');
    const startedAt = performance.now();
    await storage.insertEventsIfAbsent(events);
    const elapsedMs = performance.now() - startedAt;

    expect(prepare.mock.calls.length).toBeLessThanOrEqual(4);
    expect(prepare.mock.calls.map(call => call[0]).join('\n'))
      .not.toMatch(/anchorIndex|SET\s+turnIndex|SET\s+entryIndex/i);
    expect(elapsedMs).toBeLessThan(30_000);
    prepare.mockRestore();

    const timeline = await storage.getConversationTimelinePage('scale-merge', {
      limit: 64,
      maxBytes: 256 * 1024,
    });
    if (timeline.reset) throw new Error('unexpected timeline reset');
    expect(timeline).toMatchObject({
      totalMessages: 100_000,
      totalTurns: 100_000,
      totalEntries: 100_000,
    });
    expect(timeline.items).toHaveLength(64);
    expect(timeline.items.at(-1)?.entryId).toBe('remote-100000');
    const randomSeekStartedAt = performance.now();
    for (const entryIndex of [1, 12_345, 49_999, 75_432, 99_998]) {
      const page = await storage.getConversationTimelinePage('scale-merge', {
        limit: 9,
        maxBytes: 256 * 1024,
        aroundEntryIndex: entryIndex,
        expectedRevision: timeline.revision,
      });
      if (page.reset) throw new Error('unexpected random timeline reset');
      expect(page.items.some(item => item.entryIndex === entryIndex)).toBe(true);
    }
    expect(performance.now() - randomSeekStartedAt).toBeLessThan(1_000);
    const ordinalPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM conversation_timeline_entries_v2
      WHERE conversationId = ? AND entryOrdinal >= ?
      ORDER BY entryOrdinal LIMIT ?
    `).all('scale-merge', 50_000, 9) as Array<{ detail: string }>;
    expect(ordinalPlan.map(row => row.detail).join('\n'))
      .toMatch(/idx_timeline_entries_v2_ordinal/);
    const middleTimeline = await storage.getConversationTimelinePage('scale-merge', {
      limit: 1,
      maxBytes: 256 * 1024,
      aroundEntryIndex: 50_000,
      expectedRevision: timeline.revision,
    });
    if (middleTimeline.reset || middleTimeline.items[0]?.kind !== 'turn') {
      throw new Error('missing middle turn');
    }
    const middleWindowStartedAt = performance.now();
    const middleWindow = await storage.getMessageWindowAround('scale-merge', {
      focus: {
        kind: 'turn',
        turnId: middleTimeline.items[0].turnId,
        cursor: middleTimeline.items[0].cursor,
      },
      expectedRevision: timeline.revision,
      maxMessages: 9,
      maxBytes: 256 * 1024,
    });
    expect(middleWindow.reset).toBe(false);
    expect(performance.now() - middleWindowStartedAt).toBeLessThan(500);
    const messageSeekPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT message.* FROM messages AS message
      WHERE message.conversationId = ?
        AND (message.timestamp, message.lamportClock, message.originNodeId, message.messageId)
            > (?, ?, ?, ?)
      ORDER BY message.timestamp, message.lamportClock, message.originNodeId, message.messageId
      LIMIT ?
    `).all('scale-merge', 50_000, 50_000, 'remote-origin', 'remote-050000', 9) as Array<{ detail: string }>;
    expect(messageSeekPlan.map(row => row.detail).join('\n'))
      .toMatch(/idx_messages_conversation_cursor/);
    const messageTail = await storage.getMessagePage('scale-merge', {
      limit: 80,
      maxBytes: 256 * 1024,
    });
    if (messageTail.reset) throw new Error('unexpected message page reset');
    expect(messageTail.items).toHaveLength(80);

    await storage.insertEventsIfAbsent([{
      eventId: 'scale-summary',
      conversationId: 'scale-merge',
      originNodeId: 'compactor',
      originSequence: 1,
      lamportClock: 100_001,
      timestamp: 50_000,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion: { 'remote-origin': 100_000 },
        coveredMessageCountByOrigin: { 'remote-origin': 100_000 },
        coveredUserTurnCountByOrigin: { 'remote-origin': 100_000 },
        droppedMessageCount: 100_000,
        droppedTurnCount: 100_000,
      },
      summary: { turnId: 'scale-summary-turn', content: 'scale summary' },
    }]);
    expect(
      await storage.getConversationTimelinePage('scale-merge', {
        limit: 64,
        maxBytes: 256 * 1024,
        beforeCursor: timeline.startCursor,
        expectedRevision: timeline.revision,
      }),
    ).toMatchObject({ reset: true });
    expect(
      await storage.getMessagePage('scale-merge', {
        limit: 80,
        maxBytes: 256 * 1024,
        before: messageTail.startCursor,
        expectedRevision: messageTail.revision,
      }),
    ).toMatchObject({ reset: true });

    await storage.insertEventsIfAbsent([{
      eventId: 'scale-delete',
      conversationId: 'scale-merge',
      originNodeId: 'deleter',
      originSequence: 1,
      lamportClock: 100_002,
      timestamp: 100_002,
      kind: 'tombstone',
      targetTurnId: 'remote-050000',
    }]);
    const finalTimeline = await storage.getConversationTimelinePage('scale-merge', {
      limit: 64,
      maxBytes: 256 * 1024,
    });
    if (finalTimeline.reset) throw new Error('unexpected timeline reset');
    expect(finalTimeline).toMatchObject({
      totalMessages: 99_999,
      totalTurns: 99_999,
      totalEntries: 100_000,
    });
    expect(finalTimeline.items.some(item => item.entryId === 'remote-050000')).toBe(false);
  }, 60_000);

  it('reads a one-event delta over 100k real rows with two indexed queries', async () => {
    const storage = new SQLiteAgentStorage();
    const db = (storage as unknown as { db: Database.Database }).db;
    db.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100000
      )
      INSERT INTO conversation_events (
        eventId, conversationId, originNodeId, originSequence,
        lamportClock, timestamp, kind, turnId, eventJson
      )
      SELECT
        'event-' || value, 'scale', 'origin', value,
        value, value, 'message', 'event-' || value,
        json_object(
          'eventId', 'event-' || value,
          'conversationId', 'scale',
          'originNodeId', 'origin',
          'originSequence', value,
          'lamportClock', value,
          'timestamp', value,
          'kind', 'message',
          'message', json_object(
            'messageId', 'event-' || value,
            'turnId', 'event-' || value,
            'role', 'user',
            'content', 'body'
          )
        )
      FROM sequence;
      INSERT INTO conversation_event_sequences (
        conversationId, originNodeId, lastSequence, contiguousFrontier
      ) VALUES ('scale', 'origin', 100000, 100000);
    `);
    const prepare = vi.spyOn(db, 'prepare');
    const frontierStartedAt = performance.now();
    const frontier = await storage.getEventVersionFrontierPage({ limit: 128 });
    const frontierMs = performance.now() - frontierStartedAt;
    const deltaStartedAt = performance.now();
    const delta = await storage.getConversationEventPage('scale', {
      limit: 128,
      direction: 'forward',
      ranges: [{ originNodeId: 'origin', fromExclusive: 99_999, toInclusive: 100_000 }],
    });
    const deltaMs = performance.now() - deltaStartedAt;

    expect(frontier.items).toEqual([{
      conversationId: 'scale',
      originNodeId: 'origin',
      maxContiguousOriginSequence: 100_000,
    }]);
    expect(delta.items.map(event => event.originSequence)).toEqual([100_000]);
    expect(prepare).toHaveBeenCalledTimes(2);
    const sql = prepare.mock.calls.map(call => call[0]).join('\n');
    expect(sql).toContain('FROM conversation_event_sequences');
    expect(sql).toContain('originSequence > ? AND originSequence <= ?');
    expect(frontierMs).toBeLessThan(1_000);
    expect(deltaMs).toBeLessThan(1_000);
  }, 15_000);

  it('stages large attachment chunks idempotently and publishes only after hash verification', async () => {
    const storage = new SQLiteAgentStorage();
    const bytes = new Uint8Array(7 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const reference = {
      contentHash,
      filename: 'large.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
    };
    const first = bytes.slice(0, 3 * 1024 * 1024);
    expect(await storage.stageAttachmentChunk(reference, 0, first)).toBe(first.byteLength);
    expect(await storage.stageAttachmentChunk(reference, 0, first)).toBe(first.byteLength);
    await expect(storage.stageAttachmentChunk(reference, 0, new Uint8Array(first.byteLength)))
      .rejects.toThrow('attachment_chunk_retry_conflict');
    let offset = first.byteLength;
    while (offset < bytes.byteLength) {
      const chunk = bytes.slice(offset, offset + 3 * 1024 * 1024);
      offset = await storage.stageAttachmentChunk(reference, offset, chunk);
    }
    expect(await storage.getAttachment(contentHash)).toBeNull();
    await storage.commitStagedAttachment(contentHash);
    expect(await storage.verifyAttachment(contentHash)).toBe(true);
    expect((await storage.readAttachmentRange(contentHash, 0, 3 * 1024 * 1024))?.byteLength)
      .toBe(3 * 1024 * 1024);

    const controller = new AbortController();
    controller.abort(new Error('cancelled_chunk_read'));
    await expect(storage.readAttachmentRange(contentHash, 0, 1, {
      signal: controller.signal,
    })).rejects.toThrow('cancelled_chunk_read');
  }, 15_000);

  it('keyset-pages 100k origins without OR lists or SQLite bind growth', async () => {
    const storage = new SQLiteAgentStorage();
    const db = (storage as unknown as { db: Database.Database }).db;
    db.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100000
      )
      INSERT INTO conversation_event_sequences (
        conversationId, originNodeId, lastSequence, contiguousFrontier
      )
      SELECT 'many-origins', printf('origin-%06d', value), 1, 1 FROM sequence;
    `);
    const prepare = vi.spyOn(db, 'prepare');
    const startedAt = performance.now();
    let after: { conversationId: string; originNodeId: string } | undefined;
    let count = 0;
    do {
      const page = await storage.getEventVersionFrontierPage({
        limit: 256,
        ...(after ? { after } : {}),
      });
      count += page.items.length;
      after = page.nextCursor;
    } while (after);
    const elapsedMs = performance.now() - startedAt;

    expect(count).toBe(100_000);
    expect(prepare).toHaveBeenCalledTimes(Math.ceil(100_000 / 256));
    expect(prepare.mock.calls.every(call => !call[0].includes(' OR '))).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 15_000);
  it('lists conversations metadata-only', async () => {
    const storage = new SQLiteAgentStorage();
    const meta = createConversationMeta();

    // 直接插入一条 conversation 行，模拟已有会话

    const db: any = (storage as any).db;
    db.prepare(
      `
      INSERT INTO conversations (
        conversationId, title, lastMessagePreview, lastMessageTimestamp,
        messageCount, originNodeId, originClock, definitionId,
        instanceDeltaJson, isUserInitiated, sourceChannelJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
      null,
      meta.isUserInitiated ? 1 : 0,
      null,
    );

    const page = await storage.listConversationsPage({ limit: 50, maxBytes: 256 * 1024 });
    expect(page.reset).toBe(false);
    expect(page.reset ? [] : page.items).toHaveLength(1);
    expect(page.reset ? undefined : page.items[0]?.conversationId).toBe('c1');

    const one = await storage.getConversationMeta('c1');
    expect(one?.definitionId).toBe('memeloop:test');
    expect(await storage.getConversationMeta('missing')).toBeNull();
  });

  it('revision-fences filtered conversation list keysets and enforces exact byte budgets', async () => {
    const storage = new SQLiteAgentStorage();
    for (let index = 0; index < 6; index += 1) {
      await initializeConversation(storage, `directory-${index}`, {
        definitionId: index % 2 === 0 ? 'definition-even' : 'definition-odd',
        lastMessageTimestamp: index + 1,
        sourceChannel: { channelId: index % 2 === 0 ? 'even' : 'odd' } as ConversationMeta['sourceChannel'],
      });
    }
    const first = await storage.listConversationsPage({
      limit: 2,
      maxBytes: 256 * 1024,
      query: { definitionId: 'definition-even', sourceChannelId: 'even' },
    });
    if (first.reset) throw new Error('unexpected conversation list reset');
    expect(first.items.map(item => item.conversationId)).toEqual(['directory-4', 'directory-2']);
    expect(first.total).toBe(3);
    expect(first.hasMoreBefore).toBe(true);

    const second = await storage.listConversationsPage({
      limit: 2,
      maxBytes: 256 * 1024,
      query: { definitionId: 'definition-even', sourceChannelId: 'even' },
      beforeCursor: first.endCursor,
      expectedRevision: first.revision,
    });
    if (second.reset) throw new Error('unexpected conversation list reset');
    expect(second.items.map(item => item.conversationId)).toEqual(['directory-0']);

    expect(
      await storage.listConversationsPage({
        limit: 2,
        maxBytes: 256 * 1024,
        query: { definitionId: 'definition-odd' },
        beforeCursor: first.endCursor,
        expectedRevision: first.revision,
      }),
    ).toEqual({ reset: true, revision: first.revision });

    const exactBytes = Buffer.byteLength(canonicalJsonString(first), 'utf8');
    expect(
      await storage.listConversationsPage({
        limit: 2,
        maxBytes: exactBytes,
        query: { definitionId: 'definition-even', sourceChannelId: 'even' },
      }),
    ).toEqual(first);
    const smaller = await storage.listConversationsPage({
      limit: 2,
      maxBytes: exactBytes - 1,
      query: { definitionId: 'definition-even', sourceChannelId: 'even' },
    });
    if (smaller.reset) throw new Error('unexpected conversation list reset');
    expect(smaller.items).toHaveLength(1);
    expect(Buffer.byteLength(canonicalJsonString(smaller), 'utf8')).toBeLessThanOrEqual(exactBytes - 1);

    await initializeConversation(storage, 'directory-new', {
      definitionId: 'definition-even',
      lastMessageTimestamp: 10,
    });
    expect(
      await storage.listConversationsPage({
        limit: 2,
        maxBytes: 256 * 1024,
        beforeCursor: first.endCursor,
        expectedRevision: first.revision,
        query: { definitionId: 'definition-even', sourceChannelId: 'even' },
      }),
    ).toMatchObject({ reset: true });
  });

  it('appends and reads messages by conversation', async () => {
    const storage = new SQLiteAgentStorage();
    const msg1 = createMessage({ messageId: 'm1', content: 'hello' });
    const msg2 = createMessage({ messageId: 'm2', content: 'world', lamportClock: 2 });

    await persistMessages(storage, [msg1, msg2]);

    const msgs = await storage.getMessages('c1', { mode: 'full-content' });
    expect(msgs.map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  it('persists compaction metadata and keyset-pages a long conversation', async () => {
    const storage = new SQLiteAgentStorage();
    const messages = Array.from({ length: 1_000 }, (_, index) =>
      createMessage({
        messageId: `long-${index.toString().padStart(4, '0')}`,
        conversationId: 'long',
        timestamp: 1_000 + index,
        lamportClock: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index % 2 === 0 ? 'prompt' : 'response'} ${index}`,
        ...(index === 501
          ? { metadata: { contextCompaction: { droppedMessageCount: 500 } } }
          : {}),
      }));
    await storage.upsertConversationMetadata(createConversationMeta({
      conversationId: 'long',
      messageCount: 0,
    }));
    await persistMessages(storage, messages);

    const tail = await storage.getMessagePage('long', {
      limit: 80,
      maxBytes: 256 * 1024,
    });
    expect(tail.reset).toBe(false);
    if (tail.reset) throw new Error('unexpected message page reset');
    expect(tail.items).toHaveLength(80);
    expect(tail.items[0].messageId).toBe('long-0920');
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);
    const older = await storage.getMessagePage('long', {
      limit: 80,
      maxBytes: 256 * 1024,
      before: tail.startCursor,
      expectedRevision: tail.revision,
    });
    if (older.reset) throw new Error('unexpected message page reset');
    expect(older.items.at(-1)?.messageId).toBe('long-0919');

    expect((await storage.getMessages('long'))[501].metadata).toEqual({
      contextCompaction: { droppedMessageCount: 500 },
    });
    const timeline = await storage.getConversationTimelinePage('long', {
      limit: 40,
      maxBytes: 256 * 1024,
    });
    if (timeline.reset) throw new Error('unexpected timeline reset');
    expect(timeline.totalMessages).toBe(1_000);
    expect(timeline.totalTurns).toBe(500);
    expect(timeline.items).toHaveLength(40);
    expect(timeline.items.at(-1)?.turnIndex).toBe(499);
  });

  it('enforces canonical UTF-8 page bytes and revision-resets every visible mutation', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'message-revisions');
    await storage.insertEventsIfAbsent(Array.from({ length: 3 }, (_, index) =>
      messageToConversationEvent(createMessage({
        conversationId: 'message-revisions',
        messageId: `revision-${index + 1}`,
        turnId: `revision-${index + 1}`,
        originNodeId: 'origin',
        originSequence: index + 1,
        timestamp: index + 1,
        lamportClock: index + 1,
        role: 'user',
        content: `消息 😀 ${index + 1}`,
      }))));
    const full = await storage.getMessagePage('message-revisions', {
      limit: 3,
      maxBytes: 256 * 1024,
    });
    if (full.reset) throw new Error('unexpected message page reset');
    const exactBytes = Buffer.byteLength(canonicalJsonString(full), 'utf8');
    expect(
      await storage.getMessagePage('message-revisions', {
        limit: 3,
        maxBytes: exactBytes,
      }),
    ).toEqual(full);
    const trimmed = await storage.getMessagePage('message-revisions', {
      limit: 3,
      maxBytes: exactBytes - 1,
    });
    if (trimmed.reset) throw new Error('unexpected message page reset');
    expect(trimmed.items.length).toBeLessThan(3);
    expect(Buffer.byteLength(canonicalJsonString(trimmed), 'utf8')).toBeLessThanOrEqual(exactBytes - 1);

    await storage.insertEventsIfAbsent([messageToConversationEvent(createMessage({
      conversationId: 'message-revisions',
      messageId: 'revision-4',
      turnId: 'revision-4',
      originNodeId: 'origin',
      originSequence: 4,
      timestamp: 4,
      lamportClock: 4,
      role: 'user',
      content: 'four',
    }))]);
    expect(
      await storage.getMessagePage('message-revisions', {
        limit: 3,
        maxBytes: 256 * 1024,
        before: full.startCursor,
        expectedRevision: full.revision,
      }),
    ).toMatchObject({ reset: true });

    const afterInsert = await storage.getMessagePage('message-revisions', {
      limit: 3,
      maxBytes: 256 * 1024,
    });
    if (afterInsert.reset) throw new Error('unexpected message page reset');
    await storage.insertEventsIfAbsent([{
      eventId: 'revision-delete',
      conversationId: 'message-revisions',
      originNodeId: 'deleter',
      originSequence: 1,
      timestamp: 5,
      lamportClock: 5,
      kind: 'tombstone',
      targetTurnId: 'revision-2',
    }]);
    expect(
      await storage.getMessagePage('message-revisions', {
        limit: 3,
        maxBytes: 256 * 1024,
        before: afterInsert.startCursor,
        expectedRevision: afterInsert.revision,
      }),
    ).toMatchObject({ reset: true });

    const afterDelete = await storage.getMessagePage('message-revisions', {
      limit: 3,
      maxBytes: 256 * 1024,
    });
    if (afterDelete.reset) throw new Error('unexpected message page reset');
    await storage.insertEventsIfAbsent([{
      eventId: 'revision-summary',
      conversationId: 'message-revisions',
      originNodeId: 'compactor',
      originSequence: 1,
      timestamp: 6,
      lamportClock: 6,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion: { origin: 4 },
        coveredMessageCountByOrigin: { origin: 4 },
        coveredUserTurnCountByOrigin: { origin: 4 },
        droppedMessageCount: 4,
        droppedTurnCount: 4,
      },
      summary: { turnId: 'revision-summary-turn', content: 'summary' },
    }]);
    expect(
      await storage.getMessagePage('message-revisions', {
        limit: 3,
        maxBytes: 256 * 1024,
        before: afterDelete.startCursor,
        expectedRevision: afterDelete.revision,
      }),
    ).toMatchObject({ reset: true });

    const db = (storage as unknown as { db: Database.Database }).db;
    const prepare = vi.spyOn(db, 'prepare');
    await expect(storage.getMessagePage('message-revisions', {
      limit: 81,
      maxBytes: 256 * 1024,
    })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(storage.getMessagePage('message-revisions', {
      limit: 50,
      maxBytes: 4 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'INVALID' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('matches portable cursor direction, BINARY ordering, and timeline semantics', async () => {
    const cursorMessages = [
      createMessage({
        conversationId: 'cursor-order',
        messageId: 'same-a',
        originNodeId: 'a',
        timestamp: 10,
        lamportClock: 10,
      }),
      createMessage({
        conversationId: 'cursor-order',
        messageId: 'same-Z',
        originNodeId: 'Z',
        timestamp: 10,
        lamportClock: 10,
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        createMessage({
          conversationId: 'cursor-order',
          messageId: `later-${index}`,
          timestamp: 20 + index,
          lamportClock: 20 + index,
        })),
    ];
    const cursorStorage = new SQLiteAgentStorage();
    await persistMessages(cursorStorage, cursorMessages);
    const forward = await cursorStorage.getMessagePage('cursor-order', {
      limit: 2,
      maxBytes: 256 * 1024,
      direction: 'forward',
    });
    if (forward.reset) throw new Error('unexpected message page reset');
    expect(forward.items.map(item => item.messageId)).toEqual(['same-Z', 'same-a']);
    const backwardAfter = await cursorStorage.getMessagePage('cursor-order', {
      limit: 2,
      maxBytes: 256 * 1024,
      after: {
        timestamp: 21,
        lamportClock: 21,
        originNodeId: 'node-1',
        messageId: 'later-1',
      },
      expectedRevision: forward.revision,
      direction: 'backward',
    });
    if (backwardAfter.reset) throw new Error('unexpected message page reset');
    expect(backwardAfter.items.map(item => item.messageId)).toEqual(['later-6', 'later-7']);

    const timelineMessages = Array.from({ length: 20 }, (_, index) =>
      createMessage({
        conversationId: 'timeline-parity',
        messageId: `timeline-${index}`,
        timestamp: 1_000 + index,
        lamportClock: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        turnId: `timeline-${index % 2 === 0 ? index : index - 1}`,
        content: `  ${index % 2 === 0 ? 'prompt' : 'response'} ${index}\nmore detail`,
        ...(index === 5 ? { metadata: { note: 'mentions "contextCompaction" only' } } : {}),
      }));
    timelineMessages.push(createMessage({
      conversationId: 'timeline-parity',
      messageId: 'timeline-summary',
      timestamp: 1_007,
      lamportClock: 1_000,
      role: 'assistant',
      content: '  Earlier work summary',
      metadata: { contextCompaction: { droppedMessageCount: 8 } },
    }));
    await persistMessages(cursorStorage, timelineMessages);

    const timelineEvents = timelineMessages.map(messageToConversationEvent);
    const timelineOptions = { limit: 20, maxBytes: 256 * 1024 };
    const sqlite = await cursorStorage.getConversationTimelinePage(
      'timeline-parity',
      timelineOptions,
    );
    if (sqlite.reset) throw new Error('unexpected timeline reset');
    const portable = buildConversationTimelinePage(
      timelineEvents,
      'timeline-parity',
      timelineOptions,
      sqlite.revision,
    );
    expect(sqlite).toEqual(portable);
    expect(sqlite.items.some(anchor => anchor.entryId === 'timeline-5')).toBe(false);
    const shortOptions = { limit: 4, maxBytes: 256 * 1024 };
    expect(await cursorStorage.getConversationTimelinePage('timeline-parity', shortOptions))
      .toEqual(buildConversationTimelinePage(
        timelineEvents,
        'timeline-parity',
        shortOptions,
        sqlite.revision,
      ));
  });

  it('keeps Unicode previews byte-identical across incremental projection and set rebuild', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'preview-parity');
    const messages = [
      createMessage({
        conversationId: 'preview-parity',
        messageId: 'preview-turn',
        turnId: 'preview-turn',
        originNodeId: 'preview-origin',
        originSequence: 1,
        timestamp: 1,
        lamportClock: 1,
        role: 'user',
        content: `\n \t \n${'a'.repeat(94)}😀suffix\nignored`,
      }),
      createMessage({
        conversationId: 'preview-parity',
        messageId: 'preview-answer',
        turnId: 'preview-turn',
        originNodeId: 'preview-origin',
        originSequence: 2,
        timestamp: 2,
        lamportClock: 2,
        role: 'assistant',
        content: `\n\n${'b'.repeat(94)}😀suffix`,
      }),
    ];
    const events = messages.map(messageToConversationEvent);
    await storage.insertEventsIfAbsent(events);
    const options = { limit: 50, maxBytes: 256 * 1024, previewLength: 96 };
    const incremental = await storage.getConversationTimelinePage('preview-parity', options);
    if (incremental.reset) throw new Error('unexpected timeline reset');
    expect(incremental).toEqual(buildConversationTimelinePage(
      events,
      'preview-parity',
      options,
      incremental.revision,
    ));
    expect(incremental.items[0]).toMatchObject({
      userPreview: `${'a'.repeat(94)}…`,
      participantPreviews: [{
        actorId: 'preview-origin',
        actorLabel: 'preview-origin',
        role: 'assistant',
        preview: `${'b'.repeat(94)}…`,
      }],
      responseCount: 1,
    });
    expect(JSON.stringify(incremental)).not.toContain('\uFFFD');

    const internal = storage as unknown as {
      db: Database.Database;
      rebuildTimelineProjectionV2(conversationId: string): void;
      timelinePreview(content: unknown): string;
    };
    expect(() => internal.timelinePreview({ content: 'not-a-string' }))
      .toThrow('timeline preview content must be a string');
    internal.db.transaction(() => {
      internal.rebuildTimelineProjectionV2('preview-parity');
    })();
    const rebuilt = await storage.getConversationTimelinePage('preview-parity', options);
    if (rebuilt.reset) throw new Error('unexpected timeline reset');
    expect(rebuilt.revision).not.toBe(incremental.revision);
    expect(rebuilt).toEqual(buildConversationTimelinePage(
      events,
      'preview-parity',
      options,
      rebuilt.revision,
    ));
    expect({ ...rebuilt, revision: incremental.revision })
      .toEqual(incremental);
    expect(
      await storage.getConversationTimelinePage('preview-parity', {
        ...options,
        beforeCursor: incremental.endCursor,
        expectedRevision: incremental.revision,
      }),
    ).toEqual({ reset: true, revision: rebuilt.revision });

    const prepare = vi.spyOn(internal.db, 'prepare');
    await expect(storage.getConversationTimelinePage('preview-parity', {
      limit: 65,
      maxBytes: 256 * 1024,
    })).rejects.toThrow('invalid_conversation_timeline_page_limit');
    await expect(storage.getConversationTimelinePage('preview-parity', {
      limit: 50,
      maxBytes: 1024 * 1024 + 1,
    })).rejects.toThrow('invalid_conversation_timeline_page_byte_budget');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('atomically seeks bounded message windows around turn and compaction timeline entries', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'around-window');
    const messages = Array.from({ length: 16 }, (_, index) => {
      const turn = Math.floor(index / 2);
      return createMessage({
        conversationId: 'around-window',
        messageId: index % 2 === 0 ? `around-turn-${turn}` : `around-answer-${turn}`,
        turnId: `around-turn-${turn}`,
        originNodeId: 'around-origin',
        originSequence: index + 1,
        timestamp: index + 1,
        lamportClock: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index % 2 === 0 ? 'question' : 'answer'} ${turn}`,
      });
    });
    await storage.insertEventsIfAbsent(messages.map(messageToConversationEvent));
    const timeline = await storage.getConversationTimelinePage('around-window', {
      limit: 50,
      maxBytes: 256 * 1024,
    });
    if (timeline.reset) throw new Error('unexpected timeline reset');
    const turn = timeline.items.find(item => item.kind === 'turn' && item.turnId === 'around-turn-4');
    if (!turn || turn.kind !== 'turn') throw new Error('missing timeline turn');

    const db = (storage as unknown as { db: Database.Database }).db;
    const prepare = vi.spyOn(db, 'prepare');
    const window = await storage.getMessageWindowAround('around-window', {
      focus: { kind: 'turn', turnId: turn.turnId, cursor: turn.cursor },
      expectedRevision: timeline.revision,
      maxMessages: 5,
      maxBytes: 256 * 1024,
    });
    if (window.reset) throw new Error('unexpected message window reset');
    expect(window.items.length).toBeLessThanOrEqual(5);
    expect(window.items.map((item: ChatMessage) => item.turnId)).toContain('around-turn-4');
    expect(window.focus).toEqual({ kind: 'turn', turnId: 'around-turn-4', cursor: turn.cursor });
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(7);
    const aroundSql = prepare.mock.calls.map(call => call[0]).join('\n');
    expect(aroundSql).not.toMatch(/\bOFFSET\b|SELECT COUNT\(\*\).*prior/is);
    expect(aroundSql.match(/SELECT message\.\*/g)).toHaveLength(3);
    expect(aroundSql).toMatch(/<= \(\?, \?, \?, \?\)/);
    expect(aroundSql).toMatch(/> \(\?, \?, \?, \?\)/);
    prepare.mockRestore();

    const exactBytes = Buffer.byteLength(canonicalJsonString(window), 'utf8');
    expect(
      await storage.getMessageWindowAround('around-window', {
        focus: { kind: 'turn', turnId: turn.turnId, cursor: turn.cursor },
        expectedRevision: timeline.revision,
        maxMessages: 5,
        maxBytes: exactBytes,
      }),
    ).toEqual(window);

    await storage.insertEventsIfAbsent([{
      eventId: 'around-summary',
      conversationId: 'around-window',
      originNodeId: 'around-compactor',
      originSequence: 1,
      timestamp: 9,
      lamportClock: 100,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion: { 'around-origin': 8 },
        coveredMessageCountByOrigin: { 'around-origin': 8 },
        coveredUserTurnCountByOrigin: { 'around-origin': 4 },
        droppedMessageCount: 8,
        droppedTurnCount: 4,
      },
      summary: { turnId: 'around-summary-turn', content: 'Earlier context summary' },
    }]);
    const withCompaction = await storage.getConversationTimelinePage('around-window', {
      limit: 50,
      maxBytes: 256 * 1024,
    });
    if (withCompaction.reset) throw new Error('unexpected timeline reset');
    const compaction = withCompaction.items.find(item => item.kind === 'compaction');
    if (!compaction || compaction.kind !== 'compaction') throw new Error('missing compaction entry');
    const compactionWindow = await storage.getMessageWindowAround('around-window', {
      focus: { kind: 'timeline-entry', entryId: compaction.entryId, cursor: compaction.cursor },
      expectedRevision: withCompaction.revision,
      maxMessages: 5,
      maxBytes: 256 * 1024,
    });
    if (compactionWindow.reset) throw new Error('unexpected message window reset');
    expect(compactionWindow.focus).toMatchObject({
      kind: 'compaction',
      entry: { entryId: 'around-summary', cursor: compaction.cursor },
    });
    expect(compactionWindow.items.length).toBeLessThanOrEqual(5);

    await storage.insertEventsIfAbsent([{
      eventId: 'around-delete',
      conversationId: 'around-window',
      originNodeId: 'around-deleter',
      originSequence: 1,
      timestamp: 101,
      lamportClock: 101,
      kind: 'tombstone',
      targetTurnId: 'around-turn-4',
    }]);
    expect(
      await storage.getMessageWindowAround('around-window', {
        focus: { kind: 'turn', turnId: turn.turnId, cursor: turn.cursor },
        expectedRevision: withCompaction.revision,
        maxMessages: 5,
        maxBytes: 256 * 1024,
      }),
    ).toMatchObject({ reset: true });

    const controller = new AbortController();
    controller.abort(new Error('cancel around'));
    const abortedPrepare = vi.spyOn(db, 'prepare');
    await expect(storage.getMessageWindowAround('around-window', {
      focus: { kind: 'timeline-entry', entryId: compaction.entryId, cursor: compaction.cursor },
      expectedRevision: withCompaction.revision,
      maxMessages: 5,
      maxBytes: 256 * 1024,
    }, { signal: controller.signal })).rejects.toThrow('cancel around');
    expect(abortedPrepare).not.toHaveBeenCalled();
  });

  it('keeps a 10k-message tool-heavy timeline result and previews bounded', async () => {
    const storage = new SQLiteAgentStorage();
    const messages = Array.from({ length: 10_000 }, (_, index) => {
      const position = index % 5;
      const role: ChatMessage['role'] = position === 0 ? 'user' : position === 1 ? 'assistant' : 'tool';
      return createMessage({
        conversationId: 'tool-heavy',
        messageId: `heavy-${index.toString().padStart(5, '0')}`,
        timestamp: 10_000 + index,
        lamportClock: index + 1,
        role,
        turnId: `heavy-${(index - position).toString().padStart(5, '0')}`,
        content: role === 'tool' ? 'x'.repeat(4_096) : `${role} ${index}`,
      });
    });
    await persistMessages(storage, messages);

    const startedAt = performance.now();
    const timeline = await storage.getConversationTimelinePage('tool-heavy', {
      limit: 64,
      maxBytes: 256 * 1024,
      previewLength: 48,
    });
    const elapsedMs = performance.now() - startedAt;

    if (timeline.reset) throw new Error('unexpected timeline reset');
    expect(timeline.totalMessages).toBe(10_000);
    expect(timeline.totalTurns).toBe(2_000);
    expect(timeline.items).toHaveLength(64);
    expect(timeline.items.every(anchor =>
      anchor.kind === 'compaction' ||
      anchor.userPreview.length <= 48 &&
        anchor.participantPreviews.every(participant => participant.preview.length <= 48)
    )).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('reuses prepared statements on the append hot path', async () => {
    const storage = new SQLiteAgentStorage();
    const db = (storage as unknown as { db: Database.Database }).db;
    await initializeConversation(storage, 'c1');
    const prepare = vi.spyOn(db, 'prepare');

    await storage.insertEventsIfAbsent([
      createMessage({ messageId: 'prepared-1' }),
      createMessage({ messageId: 'prepared-2', lamportClock: 2 }),
    ].map(messageToConversationEvent));

    expect(prepare).not.toHaveBeenCalled();
  });

  it('persists canonical toolCalls/attachments for a conversationId without a colon', async () => {
    const storage = new SQLiteAgentStorage();
    await persistMessages(storage, [
      createMessage({
        conversationId: 'noColon',
        messageId: 'm-nc',
        content: '123',
        toolCalls: [{ id: 't1', toolName: 'test', arguments: { x: 1 } }] as any,
        attachments: [{ contentHash: `sha256:${'a'.repeat(64)}`, filename: 'x', mimeType: 'text/plain', size: 1 }] as any,
      }),
    ]);
    const meta = await storage.getConversationMeta('noColon');
    expect(meta?.definitionId).toBe('memeloop:test-explicit');
    const msgs = await storage.getMessages('noColon');
    expect(msgs[0]?.toolCalls?.[0]?.id).toBe('t1');
    expect(msgs[0]?.attachments?.[0]?.contentHash).toBe(`sha256:${'a'.repeat(64)}`);
    expect(
      await storage.conversationReferencesAttachment(
        'noColon',
        `sha256:${'a'.repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      await storage.conversationReferencesAttachment(
        'another-conversation',
        `sha256:${'a'.repeat(64)}`,
      ),
    ).toBe(false);
  });

  it('requires explicit definition metadata and never derives it from opaque conversation ids', async () => {
    const storage = new SQLiteAgentStorage();
    const message = createMessage({
      conversationId: 'opaque:with:many:colons',
      messageId: 'opaque-message',
      turnId: 'opaque-message',
      originNodeId: 'remote',
      originSequence: 2,
      lamportClock: 2,
      timestamp: 2,
    });
    await expect(storage.insertEventsIfAbsent([messageToConversationEvent(message)]))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(storage.appendLocalEvent({
      eventId: 'local-without-metadata',
      conversationId: 'opaque-local',
      originNodeId: 'local',
      timestamp: 1,
      kind: 'message',
      message: {
        messageId: 'local-without-metadata',
        turnId: 'local-without-metadata',
        role: 'user',
        content: 'must reject',
      },
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    const metadata: ConversationEvent = {
      eventId: 'opaque-metadata',
      conversationId: 'opaque:with:many:colons',
      originNodeId: 'remote',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      kind: 'metadataPatch',
      patch: { definitionId: 'definition-explicit', title: 'Opaque' },
    };
    // A remote sync page itself may be shuffled; the explicit metadata event
    // establishes identity for the whole atomic page without id parsing.
    await storage.insertEventsIfAbsent([messageToConversationEvent(message), metadata]);
    expect(await storage.getConversationMeta('opaque:with:many:colons'))
      .toMatchObject({ definitionId: 'definition-explicit', title: 'Opaque' });
    expect(await storage.getConversationMeta('opaque-local')).toBeNull();
    await expect(storage.upsertConversationMetadata(createConversationMeta({
      conversationId: 'invalid-definition',
      definitionId: '',
    }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(storage.insertEventsIfAbsent([{
      eventId: 'invalid-definition-patch',
      conversationId: 'opaque:with:many:colons',
      originNodeId: 'invalid-origin',
      originSequence: 1,
      lamportClock: 3,
      timestamp: 3,
      kind: 'metadataPatch',
      patch: { definitionId: { inferred: true } },
    } as unknown as ConversationEvent])).rejects.toMatchObject({ code: 'INVALID' });
    expect((await storage.getConversationMeta('opaque:with:many:colons'))?.definitionId)
      .toBe('definition-explicit');
  });

  it('persists and reads structured message parts', async () => {
    const storage = new SQLiteAgentStorage();
    await persistMessages(storage, [
      createMessage({
        messageId: 'm-parts',
        role: 'tool',
        content: 'Result from grep: found',
        parts: [{
          type: 'tool-result',
          toolName: 'grep',
          parameters: { pattern: 'foo' },
          result: 'found',
        }],
      }),
    ]);

    const msgs = await storage.getMessages('c1');
    expect(msgs.find((message) => message.messageId === 'm-parts')?.parts).toEqual([
      expect.objectContaining({ type: 'tool-result', toolName: 'grep', result: 'found' }),
    ]);
  });

  it('uses explicit metadata instead of inferring conversation semantics from an opaque id', async () => {
    const storage = new SQLiteAgentStorage();
    const cid = 'terminal:sess-xyz';
    await initializeConversation(storage, cid, { isUserInitiated: false });
    await storage.insertEventsIfAbsent([
      createMessage({
        messageId: 't1',
        conversationId: cid,
        role: 'tool',
        content: '[stdout] x',
      }),
    ].map(messageToConversationEvent));
    const meta = await storage.getConversationMeta(cid);
    expect(meta?.isUserInitiated).toBe(false);
  });

  it('persists and reads detailRef on messages', async () => {
    const storage = new SQLiteAgentStorage();
    const detailRef = {
      type: 'terminal-session' as const,
      sessionId: 'sess-1',
      nodeId: 'node-a',
      exitCode: 0,
    };
    await persistMessages(storage, [
      createMessage({
        messageId: 'm-dr',
        role: 'tool',
        content: 'summary',
        detailRef,
      }),
    ]);
    const msgs = await storage.getMessages('c1');
    expect(msgs[0]?.detailRef).toEqual(detailRef);
  });

  it('fails closed when opening a pre-event messages schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memeloop-sqlite-'));
    const file = join(dir, 'legacy.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE messages (
        messageId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        originNodeId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        lamportClock INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        partsJson TEXT,
        toolCallsJson TEXT,
        attachmentsJson TEXT
      );
    `);
    raw.close();

    expect(() => new SQLiteAgentStorage({ filename: file })).toThrow(
      'incompatible messages schema',
    );
  });

  it('upserts conversation metadata and insertMessagesIfAbsent merges without duplicate', async () => {
    const storage = new SQLiteAgentStorage();
    const meta = createConversationMeta({ conversationId: 'c-merge', messageCount: 0 });
    await storage.upsertConversationMetadata(meta);
    const m1 = createMessage({
      conversationId: 'c-merge',
      messageId: 'mid-1',
      lamportClock: 1,
    });
    const m2 = createMessage({
      conversationId: 'c-merge',
      messageId: 'mid-2',
      lamportClock: 2,
    });
    await persistMessages(storage, [m1, m2]);
    await persistMessages(storage, [m1]);
    const msgs = await storage.getMessages('c-merge');
    expect(msgs).toHaveLength(2);
    const list = await storage.listConversationsPage({ limit: 50, maxBytes: 256 * 1024 });
    if (list.reset) throw new Error('unexpected conversation list reset');
    const row = list.items.find((c) => c.conversationId === 'c-merge');
    expect(row?.messageCount).toBe(2);
  });

  it('upsertConversationMetadata stores instanceDelta + sourceChannel and insertMessagesIfAbsent handles empty', async () => {
    const storage = new SQLiteAgentStorage();
    await storage.upsertConversationMetadata(
      createConversationMeta({
        conversationId: 'c-meta',
        instanceDelta: { x: 1 } as any,
        sourceChannel: { channelId: 'ch', imUserId: 'u', platform: 'telegram' } as any,
        isUserInitiated: false,
      }),
    );
    const meta = await storage.getConversationMeta('c-meta');
    expect(meta?.instanceDelta).toEqual({ x: 1 });
    expect((meta as any)?.sourceChannel?.channelId).toBe('ch');
    await persistMessages(storage, []);
  });

  it('saves and reads attachments by contentHash', async () => {
    const storage = new SQLiteAgentStorage();
    const ref: AttachmentReference = {
      contentHash: 'sha256:abc',
      filename: 'a.txt',
      mimeType: 'text/plain',
      size: 3,
    };

    await storage.saveAttachment(ref, Buffer.from('abc'));

    const loaded = await storage.getAttachment(ref.contentHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.filename).toBe('a.txt');
  });

  it('readAttachmentData returns bytes, and null when missing; saveAttachment replaces existing', async () => {
    const storage = new SQLiteAgentStorage();
    expect(await storage.readAttachmentData('missing')).toBeNull();
    const ref = { contentHash: 'sha256:r', filename: 'r.bin', mimeType: 'application/octet-stream', size: 3 } as any;
    await storage.saveAttachment(ref, new Uint8Array([1, 2, 3]));
    const data1 = await storage.readAttachmentData(ref.contentHash);
    expect(Array.from(data1 ?? [])).toEqual([1, 2, 3]);
    await storage.saveAttachment({ ...ref, size: 1 }, new Uint8Array([9]));
    const data2 = await storage.readAttachmentData(ref.contentHash);
    expect(Array.from(data2 ?? [])).toEqual([9]);
  });

  it('seedAgentDefinitions + getAgentDefinition round-trip', async () => {
    const storage = new SQLiteAgentStorage();
    const def: AgentDefinition = {
      id: 'memeloop:seed-test',
      name: 'Seed',
      description: 'd',
      systemPrompt: 'sys',
      tools: [],
      version: '1',
    };
    storage.seedAgentDefinitions([def]);
    const loaded = await storage.getAgentDefinition('memeloop:seed-test');
    expect(loaded?.id).toBe('memeloop:seed-test');
    expect(loaded?.systemPrompt).toBe('sys');
    expect(await storage.getAgentDefinition('missing')).toBeNull();
  });

  it('getAgentDefinition returns null on invalid JSON row', async () => {
    const storage = new SQLiteAgentStorage();

    const db: any = (storage as any).db;
    db.prepare(
      `INSERT OR REPLACE INTO agent_definitions (definitionId, definitionJson, updatedAt) VALUES (?, ?, ?);`,
    ).run('bad', '{not-json', Date.now());
    expect(await storage.getAgentDefinition('bad')).toBeNull();
  });

  it('saveAgentInstance stores definitionDeltaJson null/defined', async () => {
    const storage = new SQLiteAgentStorage();
    await storage.saveAgentInstance({
      instanceId: 'i1',
      definitionId: 'd1',
      nodeId: 'n1',
      conversationId: 'c1',
      createdAt: 1,
      updatedAt: 2,
    } as any);
    await storage.saveAgentInstance({
      instanceId: 'i2',
      definitionId: 'd2',
      nodeId: 'n1',
      conversationId: 'c2',
      createdAt: 1,
      updatedAt: 2,
      definitionDelta: { x: 1 } as any,
    } as any);
  });

  it('persists IM binding pendingQuestionId', async () => {
    const storage = new SQLiteAgentStorage();
    await storage.setImBinding({
      channelId: 'ch1',
      imUserId: 'u1',
      activeConversationId: 'conv1',
      createdAt: 123,
      pendingQuestionId: 'q1',
    });
    const row = await storage.getImBinding('ch1', 'u1');
    expect(row?.pendingQuestionId).toBe('q1');
    expect(row?.createdAt).toBe(123);
    await storage.setImBinding({
      channelId: 'ch1',
      imUserId: 'u1',
      activeConversationId: 'conv1',
      createdAt: 999,
    });
    const cleared = await storage.getImBinding('ch1', 'u1');
    expect(cleared?.pendingQuestionId).toBeUndefined();
    expect(cleared?.createdAt).toBe(123);
  });

  it('getImBinding returns null when missing', async () => {
    const storage = new SQLiteAgentStorage();
    expect(await storage.getImBinding('none', 'u')).toBeNull();
  });

  it('getMaxLamportClockForConversation uses SQL MAX', async () => {
    const storage = new SQLiteAgentStorage();
    await persistMessages(storage, [
      createMessage({ messageId: 'a', lamportClock: 7 }),
      createMessage({ messageId: 'b', lamportClock: 42, content: 'x' }),
    ]);
    const max = await storage.getMaxLamportClockForConversation('c1');
    expect(max).toBe(42);
  });

  it('restores the durable event frontier and Lamport clock after reopening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memeloop-lamport-reopen-'));
    const filename = join(directory, 'agent.db');
    const storage = new SQLiteAgentStorage({ filename });
    await initializeConversation(storage, 'durable-clock');
    await storage.insertEventsIfAbsent([
      {
        eventId: 'remote-metadata-1',
        conversationId: 'durable-clock',
        originNodeId: 'remote-peer',
        originSequence: 1,
        lamportClock: 80,
        timestamp: 80,
        kind: 'metadataPatch',
        patch: { title: 'remote title' },
      },
      {
        eventId: 'remote-tombstone-2',
        conversationId: 'durable-clock',
        originNodeId: 'remote-peer',
        originSequence: 2,
        lamportClock: 90,
        timestamp: 90,
        kind: 'tombstone',
        targetTurnId: 'remote-deleted-turn',
      },
    ]);
    expect(await nextLamportClockForConversation(storage, 'durable-clock')).toBe(91);
    storage.close();

    const reopened = new SQLiteAgentStorage({ filename });
    try {
      expect(await nextLamportClockForConversation(reopened, 'durable-clock')).toBe(91);
      await expect(reopened.getEventVersionFrontierPage({ limit: 10 })).resolves.toEqual({
        items: [{
          conversationId: 'durable-clock',
          originNodeId: 'remote-peer',
          maxContiguousOriginSequence: 2,
        }],
      });
      await expect(reopened.appendLocalEvent({
        eventId: 'local-metadata-1',
        conversationId: 'durable-clock',
        originNodeId: 'local-peer',
        timestamp: 91,
        kind: 'metadataPatch',
        patch: { title: 'local title' },
      })).resolves.toMatchObject({
        originSequence: 1,
        lamportClock: 91,
      });
    } finally {
      reopened.close();
    }
  });

  it('does not let a stale UI metadata snapshot delete remotely merged messages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memeloop-remote-merge-reopen-'));
    const filename = join(directory, 'agent.db');
    const storage = new SQLiteAgentStorage({ filename });
    await initializeConversation(storage, 'remote-merge');
    const remote = createMessage({
      conversationId: 'remote-merge',
      messageId: 'remote-message',
      turnId: 'remote-message',
      originNodeId: 'remote-peer',
      originSequence: 1,
      lamportClock: 7,
      content: 'durable remote content',
    });
    await storage.insertEventsIfAbsent([messageToConversationEvent(remote)]);

    // A renderer/UI snapshot may lag behind sync and still report zero visible
    // messages. Metadata is an independent projection and must never replace
    // the authoritative append-only event log.
    await storage.upsertConversationMetadata(createConversationMeta({
      conversationId: 'remote-merge',
      title: 'stale UI snapshot',
      messageCount: 0,
      originNodeId: 'local-peer',
      originClock: 0,
    }));
    expect(await storage.getMessages('remote-merge')).toEqual([
      expect.objectContaining({
        messageId: 'remote-message',
        content: 'durable remote content',
        originNodeId: 'remote-peer',
      }),
    ]);
    storage.close();

    const reopened = new SQLiteAgentStorage({ filename });
    try {
      expect(await reopened.getMessages('remote-merge')).toEqual([
        expect.objectContaining({
          messageId: 'remote-message',
          content: 'durable remote content',
          originNodeId: 'remote-peer',
        }),
      ]);
    } finally {
      reopened.close();
    }
  });

  it('pages compaction candidates across controls and tombstones with exact origin counts', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'coverage');
    const base = {
      conversationId: 'coverage',
      timestamp: 1,
      lamportClock: 1,
    };
    const message = (
      eventId: string,
      originNodeId: string,
      originSequence: number,
      role: 'user' | 'assistant',
      turnId = eventId,
    ): ConversationEvent => ({
      ...base,
      eventId,
      originNodeId,
      originSequence,
      lamportClock: originSequence,
      timestamp: originSequence,
      kind: 'message',
      message: { messageId: eventId, turnId, role, content: eventId },
    });
    const events: ConversationEvent[] = [
      message('a-1', 'a', 1, 'user'),
      { ...base, eventId: 'a-control', originNodeId: 'a', originSequence: 2, lamportClock: 2, timestamp: 2, kind: 'metadataPatch', patch: { title: 'covered' } },
      message('a-3-hidden', 'a', 3, 'user'),
      message('a-4', 'a', 4, 'assistant', 'a-1'),
      message('a-5', 'a', 5, 'assistant', 'a-1'),
      message('b-1', 'b', 1, 'user'),
      { ...base, eventId: 'b-tombstone', originNodeId: 'b', originSequence: 2, lamportClock: 2, timestamp: 2, kind: 'tombstone', targetTurnId: 'a-3-hidden' },
    ];
    await storage.insertEventsIfAbsent(events);

    const first = await storage.getCompactionCandidatePage('coverage', {
      afterCoveredVersion: {},
      maxMessages: 2,
      maxBytes: 256 * 1024,
    });
    expect(first).toMatchObject({
      messages: [{ messageId: 'a-1' }, { messageId: 'a-4' }],
      nextCoveredVersion: { a: 4 },
      newlyCoveredMessageCountByOrigin: { a: 2 },
      newlyCoveredUserTurnCountByOrigin: { a: 1 },
      hasMore: true,
    });

    const second = await storage.getCompactionCandidatePage('coverage', {
      afterCoveredVersion: { a: 4, b: 2 },
      maxMessages: 80,
      maxBytes: 256 * 1024,
    });
    expect(second).toMatchObject({
      messages: [{ messageId: 'a-5' }],
      nextCoveredVersion: { a: 5, b: 2 },
      newlyCoveredMessageCountByOrigin: { a: 1 },
      newlyCoveredUserTurnCountByOrigin: {},
      hasMore: false,
    });
  });

  it('syncs raw compaction controls and invalidates a summary after a later remote tombstone', async () => {
    const source = new SQLiteAgentStorage();
    const destination = new SQLiteAgentStorage();
    const boundary = {
      version: 2 as const,
      coveredVersion: { 'message-origin': 1 },
      coveredMessageCountByOrigin: { 'message-origin': 1 },
      coveredUserTurnCountByOrigin: { 'message-origin': 1 },
      droppedMessageCount: 1,
      droppedTurnCount: 1,
    };
    const initialEvents: ConversationEvent[] = [
      {
        eventId: 'redaction-sync-metadata',
        conversationId: 'redaction-sync',
        originNodeId: 'metadata-origin',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 0,
        kind: 'metadataPatch',
        patch: { definitionId: 'memeloop:test-explicit' },
      },
      {
        eventId: 'coverage-sync-metadata',
        conversationId: 'coverage-sync',
        originNodeId: 'metadata-origin',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 0,
        kind: 'metadataPatch',
        patch: { definitionId: 'memeloop:test-explicit' },
      },
      {
        eventId: 'message-before-summary',
        conversationId: 'redaction-sync',
        originNodeId: 'message-origin',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 1,
        kind: 'message',
        message: {
          messageId: 'message-before-summary',
          turnId: 'message-before-summary',
          role: 'user',
          content: 'erase me later',
        },
      },
      {
        eventId: 'summary-before-delete',
        conversationId: 'redaction-sync',
        originNodeId: 'summary-origin',
        originSequence: 1,
        lamportClock: 2,
        timestamp: 2,
        kind: 'compaction',
        mode: 'summary',
        boundary,
        summary: { turnId: 'summary-turn', content: 'polluted summary' },
      },
      {
        eventId: 'coverage-control',
        conversationId: 'coverage-sync',
        originNodeId: 'coverage-origin',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 1,
        kind: 'compaction',
        mode: 'coverage-only',
        boundary: {
          version: 2,
          coveredVersion: { 'covered-origin': 1 },
          coveredMessageCountByOrigin: { 'covered-origin': 1 },
          coveredUserTurnCountByOrigin: { 'covered-origin': 1 },
          droppedMessageCount: 1,
          droppedTurnCount: 1,
        },
        summary: null,
      },
    ];
    expect(initialEvents.every(isConversationEvent)).toBe(true);
    await source.insertEventsIfAbsent(initialEvents);

    await syncSqliteStores('destination', destination, 'source', source);
    expect(
      await destination.getRetainedCompactionControls('redaction-sync', {
        limit: 32,
        maxBytes: 1024 * 1024,
      }),
    ).toMatchObject({
      invalidated: false,
      items: [{ eventId: 'summary-before-delete', mode: 'summary' }],
    });
    const coverageEvents = (await destination.getConversationEventPage('coverage-sync', {
      limit: 8,
      direction: 'forward',
    })).items;
    expect(coverageEvents.find(event => event.eventId === 'coverage-control'))
      .toMatchObject({ eventId: 'coverage-control', mode: 'coverage-only', summary: null });
    expect(await destination.getMessages('coverage-sync')).toEqual([]);

    await source.insertEventsIfAbsent([{
      eventId: 'delete-after-summary',
      conversationId: 'redaction-sync',
      originNodeId: 'delete-origin',
      originSequence: 1,
      lamportClock: 3,
      timestamp: 3,
      kind: 'tombstone',
      targetTurnId: 'message-before-summary',
      reason: 'redaction',
    }]);
    await syncSqliteStores('destination', destination, 'source', source);

    expect(
      await destination.getRetainedCompactionControls('redaction-sync', {
        limit: 32,
        maxBytes: 1024 * 1024,
      }),
    ).toEqual({ items: [], invalidated: true, hasMore: false });
  });

  it('persists run idempotency and enforces lifecycle CAS across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memeloop-runs-'));
    const file = join(dir, 'runs.db');
    const accepted: AgentRunRecord = {
      runId: 'run-1',
      conversationId: 'run-conversation',
      definitionId: 'definition',
      turnId: 'turn-1',
      requestPeerId: 'peer',
      requestId: 'request',
      payloadDigest: 'digest',
      state: 'accepted',
      acceptedAt: 1,
      updatedAt: 1,
    };
    const storage = new SQLiteAgentStorage({ filename: file });
    expect(await storage.createOrGet(accepted)).toEqual(accepted);
    expect(await storage.createOrGet({ ...accepted, runId: 'ignored-same-request' })).toEqual(accepted);
    await expect(storage.createOrGet({
      ...accepted,
      runId: 'drift',
      payloadDigest: 'different',
    })).rejects.toThrow('payload drift');
    expect(
      await storage.transition('run-1', ['accepted'], {
        ...accepted,
        state: 'completed',
        updatedAt: 2,
      }),
    ).toBe(false);
    const queued = { ...accepted, state: 'queued' as const, updatedAt: 2 };
    expect(await storage.transition('run-1', ['accepted'], queued)).toBe(true);
    expect(
      await storage.transition('run-1', ['accepted'], {
        ...queued,
        state: 'cancelled',
        updatedAt: 3,
      }),
    ).toBe(false);
    const failedAccepted: AgentRunRecord = {
      ...accepted,
      runId: 'run-failed',
      turnId: 'turn-failed',
      requestId: 'request-failed',
    };
    const failed: AgentRunRecord = {
      ...failedAccepted,
      state: 'failed',
      updatedAt: 3,
      finishedAt: 3,
      error: {
        code: 'INTERNAL',
        messageKey: 'agent.run.error.internal',
        retryable: false,
        diagnosticId: 'diagnostic-failed-transition',
      },
    };
    expect(await storage.createOrGet(failedAccepted)).toEqual(failedAccepted);
    expect(await storage.transition('run-failed', ['accepted'], failed)).toBe(true);
    expect(await storage.get('run-failed')).toEqual(failed);
    storage.close();

    const reopened = new SQLiteAgentStorage({ filename: file });
    expect(await reopened.get('run-1')).toEqual(queued);
    expect(await reopened.getByTurn('run-conversation', 'turn-1', 'peer')).toEqual(queued);
    expect(await reopened.listActive()).toEqual([queued]);
    expect(await reopened.get('run-failed')).toEqual(failed);
    reopened.close();
  });

  it('keeps local allocation gap-free across retries, drift, and batch rollback', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'atomic');
    const draft = {
      eventId: 'local-1',
      conversationId: 'atomic',
      originNodeId: 'local-node',
      timestamp: 1,
      kind: 'message' as const,
      message: {
        messageId: 'local-1',
        turnId: 'local-1',
        role: 'user' as const,
        content: 'one',
      },
    };
    const first = await storage.appendLocalEvent(draft);
    expect((await storage.appendLocalEvent(draft)).originSequence).toBe(1);
    await expect(storage.appendLocalEvent({
      ...draft,
      message: { ...draft.message, content: 'drift' },
    })).rejects.toThrow('different payload');
    const second = await storage.appendLocalEvent({
      ...draft,
      eventId: 'local-2',
      timestamp: 2,
      message: { ...draft.message, messageId: 'local-2', turnId: 'local-2', content: 'two' },
    });
    expect([first.originSequence, second.originSequence]).toEqual([1, 2]);

    const remote = (eventId: string): ConversationEvent => ({
      eventId,
      conversationId: 'atomic',
      originNodeId: 'remote-node',
      originSequence: 1,
      lamportClock: 3,
      timestamp: 3,
      kind: 'message',
      message: { messageId: eventId, turnId: eventId, role: 'user', content: eventId },
    });
    await expect(storage.insertEventsIfAbsent([remote('remote-1'), remote('remote-conflict')]))
      .rejects.toThrow('already occupied');
    expect(
      (await storage.getEventVersionFrontierPage({
        limit: 128,
        conversationIds: ['atomic'],
      })).items,
    ).toEqual([
      { conversationId: 'atomic', originNodeId: 'local-node', maxContiguousOriginSequence: 2 },
    ]);
  });

  it('hides a turn whether its tombstone arrives before or after late messages', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'delete-before');
    await storage.insertEventsIfAbsent([{
      eventId: 'delete-first',
      conversationId: 'delete-before',
      originNodeId: 'remote',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      kind: 'tombstone',
      targetTurnId: 'late-turn',
      reason: 'user-delete',
    }, {
      eventId: 'late-assistant',
      conversationId: 'delete-before',
      originNodeId: 'remote',
      originSequence: 2,
      lamportClock: 2,
      timestamp: 2,
      kind: 'message',
      message: {
        messageId: 'late-assistant',
        turnId: 'late-turn',
        role: 'assistant',
        content: 'must stay hidden',
      },
    }]);
    expect(await storage.getMessages('delete-before')).toEqual([]);
    expect((await storage.getConversationMeta('delete-before'))?.messageCount).toBe(0);

    await initializeConversation(storage, 'delete-after');
    const rootDraft = {
      eventId: 'visible-turn',
      conversationId: 'delete-after',
      originNodeId: 'local',
      timestamp: 1,
      kind: 'message' as const,
      message: {
        messageId: 'visible-turn',
        turnId: 'visible-turn',
        role: 'user' as const,
        content: 'visible first',
      },
    };
    await storage.appendLocalEvent(rootDraft);
    await storage.appendLocalEvent({
      eventId: 'visible-answer',
      conversationId: 'delete-after',
      originNodeId: 'local',
      timestamp: 2,
      kind: 'message',
      message: {
        messageId: 'visible-answer',
        turnId: 'visible-turn',
        role: 'assistant',
        content: 'answer',
      },
    });
    await storage.appendLocalEvent({
      eventId: 'delete-after-event',
      conversationId: 'delete-after',
      originNodeId: 'local',
      timestamp: 3,
      kind: 'tombstone',
      targetTurnId: 'visible-turn',
      reason: 'user-delete',
    });
    expect(await storage.getMessages('delete-after')).toEqual([]);
    expect(
      await storage.getConversationTimelinePage('delete-after', {
        limit: 50,
        maxBytes: 256 * 1024,
      }),
    ).toMatchObject({
      reset: false,
      items: [],
      totalMessages: 0,
      totalTurns: 0,
      totalEntries: 0,
    });
    expect(await storage.getConversationMeta('delete-after')).toMatchObject({
      messageCount: 0,
      lastMessagePreview: '',
    });
  });

  it('finds retained incomparable summaries beyond a 10k tail and filters covered pages', async () => {
    const storage = new SQLiteAgentStorage();
    await initializeConversation(storage, 'retained');
    const summary = (
      eventId: string,
      originNodeId: string,
      originSequence: number,
      coveredVersion: Record<string, number>,
    ): ConversationEvent => ({
      eventId,
      conversationId: 'retained',
      originNodeId,
      originSequence,
      lamportClock: originSequence,
      timestamp: originSequence,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion,
        coveredMessageCountByOrigin: Object.fromEntries(
          Object.keys(coveredVersion).map(origin => [origin, 1]),
        ),
        coveredUserTurnCountByOrigin: Object.fromEntries(
          Object.keys(coveredVersion).map(origin => [origin, 1]),
        ),
        droppedMessageCount: Object.keys(coveredVersion).length,
        droppedTurnCount: 1,
      },
      summary: { turnId: eventId, content: eventId },
    });
    const coverage = (
      eventId: string,
      originNodeId: string,
      originSequence: number,
      coveredVersion: Record<string, number>,
    ): ConversationEvent => ({
      eventId,
      conversationId: 'retained',
      originNodeId,
      originSequence,
      lamportClock: originSequence + 20,
      timestamp: originSequence + 20,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary: {
        version: 2,
        coveredVersion,
        coveredMessageCountByOrigin: Object.fromEntries(
          Object.keys(coveredVersion).map(origin => [origin, 1]),
        ),
        coveredUserTurnCountByOrigin: Object.fromEntries(
          Object.keys(coveredVersion).map(origin => [origin, 1]),
        ),
        droppedMessageCount: Object.keys(coveredVersion).length,
        droppedTurnCount: 1,
      },
      summary: null,
    });
    await storage.insertEventsIfAbsent([
      summary('summary-a', 'summary-origin-a', 1, { a: 2 }),
      summary('summary-b', 'summary-origin-b', 1, { b: 2 }),
      summary('summary-a-new', 'summary-origin-a', 2, { a: 3 }),
      coverage('coverage-a-newest', 'coverage-origin', 1, { a: 5 }),
      summary('summary-a-deleted', 'summary-origin-a', 3, { a: 4 }),
      {
        eventId: 'delete-summary-a-deleted',
        conversationId: 'retained',
        originNodeId: 'delete-origin',
        originSequence: 1,
        lamportClock: 4,
        timestamp: 4,
        kind: 'tombstone',
        targetTurnId: 'summary-a-deleted',
      },
      {
        eventId: 'covered-message',
        conversationId: 'retained',
        originNodeId: 'a',
        originSequence: 1,
        lamportClock: 10,
        timestamp: 10,
        kind: 'message',
        message: {
          messageId: 'covered-message',
          turnId: 'covered-message',
          role: 'user',
          content: 'covered',
        },
      },
      {
        eventId: 'unknown-origin-message',
        conversationId: 'retained',
        originNodeId: 'unknown',
        originSequence: 1,
        lamportClock: 11,
        timestamp: 11,
        kind: 'message',
        message: {
          messageId: 'unknown-origin-message',
          turnId: 'unknown-origin-message',
          role: 'user',
          content: 'must remain',
        },
      },
      ...Array.from({ length: 10_001 }, (_, index): ConversationEvent => ({
        eventId: `tail-${index}`,
        conversationId: 'retained',
        originNodeId: 'tail-origin',
        originSequence: index + 1,
        lamportClock: index + 100,
        timestamp: index + 100,
        kind: 'message',
        message: {
          messageId: `tail-${index}`,
          turnId: 'tail-turn',
          role: 'tool',
          content: 'tail',
        },
      })),
    ]);
    await expect(storage.getRetainedCompactionControls('retained', {
      limit: 33,
      maxBytes: 1024 * 1024,
    }))
      .rejects.toMatchObject({ code: 'INVALID' });
    const db = (storage as unknown as { db: Database.Database }).db;
    const prepare = vi.spyOn(db, 'prepare');
    const controls = await storage.getRetainedCompactionControls('retained', {
      limit: 32,
      maxBytes: 1024 * 1024,
    });
    expect(controls.items.map(event => event.eventId)).toEqual([
      'coverage-a-newest',
      'summary-a-new',
      'summary-b',
    ]);
    expect(controls.items.find(event => event.eventId === 'coverage-a-newest'))
      .toMatchObject({ mode: 'coverage-only', summary: null });
    expect(controls.invalidated).toBe(false);
    expect(controls.hasMore).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
    const page = await storage.getMessagePage('retained', {
      limit: 80,
      maxBytes: 1024 * 1024,
      direction: 'forward',
      afterCoveredVersion: { a: 1, 'tail-origin': 10_001 },
    });
    if (page.reset) throw new Error('unexpected message page reset');
    expect(page.items.map(message => message.messageId)).toEqual(['unknown-origin-message']);
    expect(page.hasMoreBefore).toBe(false);
    expect(page.hasMoreAfter).toBe(false);
  });
});

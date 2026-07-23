import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentDefinition, AttachmentReference, ChatMessage, ConversationMeta } from 'memeloop';

import { SQLiteAgentStorage } from '../sqliteStorage.js';

function createConversationMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    conversationId: 'c1',
    title: 'Test',
    lastMessagePreview: 'hi',
    lastMessageTimestamp: Date.now(),
    messageCount: 1,
    originNodeId: 'node-1',
    definitionId: 'memeloop:test',
    isUserInitiated: true,
    ...overrides,
  };
}

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    originNodeId: 'node-1',
    timestamp: Date.now(),
    lamportClock: 1,
    role: 'user',
    content: 'hello',
    ...overrides,
  };
}

describe('SQLiteAgentStorage', () => {
  it('lists conversations metadata-only', async () => {
    const storage = new SQLiteAgentStorage();
    const meta = createConversationMeta();

    // 直接插入一条 conversation 行，模拟已有会话

    const db: any = (storage as any).db;
    db.prepare(
      `
      INSERT INTO conversations (
        conversationId, title, lastMessagePreview, lastMessageTimestamp,
        messageCount, originNodeId, definitionId,
        instanceDeltaJson, isUserInitiated, sourceChannelJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    ).run(
      meta.conversationId,
      meta.title,
      meta.lastMessagePreview,
      meta.lastMessageTimestamp,
      meta.messageCount,
      meta.originNodeId,
      meta.definitionId,
      null,
      meta.isUserInitiated ? 1 : 0,
      null,
    );

    const list = await storage.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe('c1');

    const one = await storage.getConversationMeta('c1');
    expect(one?.definitionId).toBe('memeloop:test');
    expect(await storage.getConversationMeta('missing')).toBeNull();
  });

  it('appends and reads messages by conversation', async () => {
    const storage = new SQLiteAgentStorage();
    const msg1 = createMessage({ messageId: 'm1', content: 'hello' });
    const msg2 = createMessage({ messageId: 'm2', content: 'world', lamportClock: 2 });

    await storage.appendMessage(msg1);
    await storage.appendMessage(msg2);

    const msgs = await storage.getMessages('c1', { mode: 'full-content' });
    expect(msgs.map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  it('appendMessage handles conversationId without colon and non-string content; persists toolCalls/attachments', async () => {
    const storage = new SQLiteAgentStorage();
    await storage.appendMessage(
      createMessage({
        conversationId: 'noColon',
        messageId: 'm-nc',
        content: 123 as any,
        toolCalls: [{ toolId: 't1', parameters: { x: 1 } }] as any,
        attachments: [{ contentHash: 'sha256:x', filename: 'x', mimeType: 'text/plain', size: 1 }] as any,
      }),
    );
    const meta = await storage.getConversationMeta('noColon');
    expect(meta?.definitionId).toBe('noColon');
    const msgs = await storage.getMessages('noColon');
    expect(msgs[0]?.toolCalls?.[0]?.toolId).toBe('t1');
    expect(msgs[0]?.attachments?.[0]?.contentHash).toBe('sha256:x');
  });

  it('persists and reads structured message parts', async () => {
    const storage = new SQLiteAgentStorage();
    await storage.appendMessage(
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
    );

    const msgs = await storage.getMessages('c1');
    expect(msgs.find((message) => message.messageId === 'm-parts')?.parts).toEqual([
      expect.objectContaining({ type: 'tool-result', toolName: 'grep', result: 'found' }),
    ]);
  });

  it('appendMessage sets isUserInitiated false for terminal:/spawn:/remote: conversations on first insert', async () => {
    const storage = new SQLiteAgentStorage();
    const cid = 'terminal:sess-xyz';
    await storage.appendMessage(
      createMessage({
        messageId: 't1',
        conversationId: cid,
        role: 'tool',
        content: '[stdout] x',
      }),
    );
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
    await storage.appendMessage(
      createMessage({
        messageId: 'm-dr',
        role: 'tool',
        content: 'summary',
        detailRef,
      }),
    );
    const msgs = await storage.getMessages('c1');
    expect(msgs[0]?.detailRef).toEqual(detailRef);
  });

  it('ALTER adds detailRefJson when opening a legacy messages table', async () => {
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

    const storage = new SQLiteAgentStorage({ filename: file });
    await storage.appendMessage(
      createMessage({
        messageId: 'legacy-m',
        content: 'x',
        detailRef: { type: 'file', fileUri: 'memeloop://node/n/file/a' },
      }),
    );
    const msgs = await storage.getMessages('c1');
    expect(msgs[0]?.detailRef?.fileUri).toBe('memeloop://node/n/file/a');
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
    await storage.insertMessagesIfAbsent([m1, m2]);
    await storage.insertMessagesIfAbsent([m1]);
    const msgs = await storage.getMessages('c-merge');
    expect(msgs).toHaveLength(2);
    const list = await storage.listConversations();
    const row = list.find((c) => c.conversationId === 'c-merge');
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
    await storage.insertMessagesIfAbsent([]);
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
    await storage.appendMessage(createMessage({ messageId: 'a', lamportClock: 7 }));
    await storage.appendMessage(
      createMessage({ messageId: 'b', lamportClock: 42, content: 'x' }),
    );
    const max = await storage.getMaxLamportClockForConversation('c1');
    expect(max).toBe(42);
  });
});

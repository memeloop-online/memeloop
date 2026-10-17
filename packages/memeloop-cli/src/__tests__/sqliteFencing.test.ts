import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { ChatMessage, ConversationMessageCursor } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SQLiteAgentStorage } from '../storage/sqliteStorage.js';
import { acquireWriterLease, currentWriterLeaseToken, revokeWriterLease, type WriterLease, WriterLeaseConflictError } from '../storage/writerLease.js';

async function readAllMessages(storage: SQLiteAgentStorage, conversationId: string) {
  const messages: ChatMessage[] = [];
  let after: ConversationMessageCursor | undefined;
  let expectedRevision: string | undefined;
  for (;;) {
    const page = await storage.getFullContentMessagePage(conversationId, {
      direction: 'forward',
      limit: 50,
      maxBytes: 256 * 1024,
      ...(after === undefined ? {} : { after, expectedRevision }),
    });
    if (page.reset) break;
    messages.push(...page.items);
    expectedRevision = page.revision;
    if (!page.hasMoreAfter || page.endCursor === undefined) break;
    after = page.endCursor;
  }
  return messages;
}

function seedLegacyHeldLease(file: string, token = 1): void {
  const database = new Database(file);
  try {
    database.exec(`
      CREATE TABLE memeloop_writer_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token INTEGER NOT NULL,
        ownerId TEXT NOT NULL,
        held INTEGER NOT NULL CHECK (held IN (0, 1))
      );
      CREATE TABLE preserved_user_data (value TEXT NOT NULL);
    `);
    database.prepare(`
      INSERT INTO memeloop_writer_lease (singleton, token, ownerId, held)
      VALUES (1, ?, 'legacy-owner', 1)
    `).run(token);
    database.prepare(`INSERT INTO preserved_user_data (value) VALUES ('must-survive')`).run();
  } finally {
    database.close();
  }
}

function setLeaseOwnerPid(file: string, ownerPid: number): void {
  const database = new Database(file);
  try {
    database.prepare('UPDATE memeloop_writer_lease SET held = 1, ownerPid = ? WHERE singleton = 1').run(ownerPid);
  } finally {
    database.close();
  }
}

describe('SQLite single-writer fencing', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memeloop-fence-'));
    file = join(directory, 'fenced.db');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a second writer for the same file', () => {
    const first = new SQLiteAgentStorage({ filename: file });
    expect(() => new SQLiteAgentStorage({ filename: file })).toThrow(WriterLeaseConflictError);
    first.close();
  });

  it('rejects the same database opened through a symlink alias', async () => {
    const first = new SQLiteAgentStorage({ filename: file });
    const alias = join(directory, 'alias.db');
    await symlink(file, alias);
    expect(() => new SQLiteAgentStorage({ filename: alias })).toThrow(WriterLeaseConflictError);
    first.close();
  });

  it('allows a new writer after the previous one closes', () => {
    const first = new SQLiteAgentStorage({ filename: file });
    first.close();
    const second = new SQLiteAgentStorage({ filename: file });
    second.close();
  });

  it('keeps a lease held by another live process', () => {
    const first = acquireWriterLease(file);
    setLeaseOwnerPid(file, 42_424);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      expect(() => acquireWriterLease(file)).toThrow(WriterLeaseConflictError);
      expect(kill).toHaveBeenCalledWith(42_424, 0);
    } finally {
      kill.mockRestore();
      first.release();
    }
  });

  it('recovers a lease only after its owner PID is definitively gone', () => {
    const first = acquireWriterLease(file);
    setLeaseOwnerPid(file, 42_424);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('process does not exist') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    try {
      const recovered = acquireWriterLease(file);
      expect(recovered.token).toBe(first.token + 1);
      expect(() => acquireWriterLease(file)).toThrow(WriterLeaseConflictError);
      recovered.release();
    } finally {
      kill.mockRestore();
      first.release();
    }
  });

  it('preserves a held legacy lease when its owner cannot be proven dead', () => {
    seedLegacyHeldLease(file, 41);

    expect(() => acquireWriterLease(file)).toThrow(WriterLeaseConflictError);

    const database = new Database(file);
    try {
      expect(database.prepare('SELECT value FROM preserved_user_data').get()).toEqual({ value: 'must-survive' });
      expect(database.prepare('PRAGMA table_info(memeloop_writer_lease)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'ownerPid' })]),
      );
    } finally {
      database.close();
    }
  });

  it('mutations fail with STALE_EPOCH after the lease is revoked', async () => {
    const storage = new SQLiteAgentStorage({ filename: file });
    await initializeConversation(storage);
    await storage.appendLocalEvent({
      eventId: 'm1',
      conversationId: 'c1',
      originNodeId: 'fencing-test',
      timestamp: 1,
      kind: 'message',
      message: { messageId: 'm1', turnId: 'm1', role: 'user', content: 'before', parts: [{ type: 'text', text: 'before' }] },
    });

    revokeWriterLease(file);

    await expect(
      storage.appendLocalEvent({
        eventId: 'm2',
        conversationId: 'c1',
        originNodeId: 'fencing-test',
        timestamp: 2,
        kind: 'message',
        message: { messageId: 'm2', turnId: 'm2', role: 'user', content: 'after', parts: [{ type: 'text', text: 'after' }] },
      }),
    ).rejects.toMatchObject({ code: 'STALE_EPOCH' });

    // Reads remain available after fencing (SQLite allows concurrent readers).
    const messages = await readAllMessages(storage, 'c1');
    expect(messages.map((message) => message.messageId)).toEqual(['m1']);
  });

  it('issues monotonically increasing fencing tokens', () => {
    const first = acquireWriterLease(file);
    expect(currentWriterLeaseToken(file)).toBe(first.token);
    first.release();
    const second = acquireWriterLease(file);
    expect(second.token).toBeGreaterThan(first.token);
    second.release();
  });

  it('rejects a stale connection inside the write statement', () => {
    const first = acquireWriterLease(file);
    const staleToken = first.token;
    first.release();
    const current = acquireWriterLease(file);
    const staleLease: WriterLease = {
      filename: first.filename,
      token: staleToken,
      ownerId: first.ownerId,
      held: () => true,
      release: () => undefined,
    };
    const stale = new SQLiteAgentStorage({ filename: file, lease: staleLease });

    expect(() => {
      stale.seedAgentDefinitions([{
        id: 'stale-writer',
        name: 'stale-writer',
        description: 'must not persist',
        systemPrompt: 'none',
        tools: [],
        version: '1',
      }]);
    }).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }) as Error);

    stale.close();
    current.release();
  });
});

describe('SQLite online snapshots', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memeloop-snap-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a readable online snapshot while the writer stays live', async () => {
    const file = join(directory, 'source.db');
    const snapshotPath = join(directory, 'snapshot.db');
    const storage = new SQLiteAgentStorage({ filename: file });
    await initializeConversation(storage);

    await storage.appendLocalEvent({
      eventId: 'm1',
      conversationId: 'c1',
      originNodeId: 'snapshot-test',
      timestamp: 1,
      kind: 'message',
      message: { messageId: 'm1', turnId: 'm1', role: 'user', content: 'snapshot-me', parts: [{ type: 'text', text: 'snapshot-me' }] },
    });
    await storage.createSnapshot(snapshotPath);
    // Writer remains usable after the snapshot.
    await storage.appendLocalEvent({
      eventId: 'm2',
      conversationId: 'c1',
      originNodeId: 'snapshot-test',
      timestamp: 2,
      kind: 'message',
      message: { messageId: 'm2', turnId: 'm2', role: 'user', content: 'after-snapshot', parts: [{ type: 'text', text: 'after-snapshot' }] },
    });

    const restored = new SQLiteAgentStorage({ filename: snapshotPath });
    const messages = await readAllMessages(restored, 'c1');
    expect(messages.map((message) => message.messageId)).toEqual(['m1']);

    restored.close();
    storage.close();
  });

  it('refuses snapshots once the writer lease is lost', async () => {
    const file = join(directory, 'source.db');
    const storage = new SQLiteAgentStorage({ filename: file });
    revokeWriterLease(file);

    await expect(storage.createSnapshot(join(directory, 'snapshot.db'))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });
});

async function initializeConversation(storage: SQLiteAgentStorage): Promise<void> {
  await storage.upsertConversationMetadata({
    conversationId: 'c1',
    title: 'Fencing test',
    lastMessagePreview: '',
    lastMessageTimestamp: 0,
    messageCount: 0,
    originNodeId: 'fencing-test',
    originClock: 0,
    definitionId: 'definition-1',
    isUserInitiated: true,
  });
}

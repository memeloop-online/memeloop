import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatMessage } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../storage/sqliteStorage.js';
import { acquireWriterLease, currentWriterLeaseToken, revokeWriterLease, WriterLeaseConflictError } from '../storage/writerLease.js';

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

  it('allows a new writer after the previous one closes', () => {
    const first = new SQLiteAgentStorage({ filename: file });
    first.close();
    const second = new SQLiteAgentStorage({ filename: file });
    second.close();
  });

  it('mutations fail with STALE_EPOCH after the lease is revoked', async () => {
    const storage = new SQLiteAgentStorage({ filename: file });
    await storage.appendMessage(createChatMessage({ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'before', lamportClock: 1 }));

    revokeWriterLease(file);

    await expect(
      storage.appendMessage(createChatMessage({ messageId: 'm2', conversationId: 'c1', role: 'user', content: 'after', lamportClock: 2 })),
    ).rejects.toMatchObject({ code: 'STALE_EPOCH' });

    // Reads remain available after fencing (SQLite allows concurrent readers).
    const messages = await storage.getMessages('c1');
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

    await storage.appendMessage(createChatMessage({ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'snapshot-me', lamportClock: 1 }));
    await storage.createSnapshot(snapshotPath);
    // Writer remains usable after the snapshot.
    await storage.appendMessage(createChatMessage({ messageId: 'm2', conversationId: 'c1', role: 'user', content: 'after-snapshot', lamportClock: 2 }));

    const restored = new SQLiteAgentStorage({ filename: snapshotPath });
    const messages = await restored.getMessages('c1');
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

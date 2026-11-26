import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SQLiteAttachmentStore } from '../sqliteAttachmentStore.js';
import { initializeCanonicalSchema } from '../sqliteSchema.js';
import { SQLiteAgentStorage } from '../sqliteStorage.js';
import { acquireWriterLease } from '../writerLease.js';

const data = Buffer.from('attachment');
const reference = {
  contentHash: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  filename: 'fixture.txt',
  mimeType: 'text/plain',
  size: data.length,
};

describe('SQLiteAttachmentStore', () => {
  let db: Database.Database;
  let store: SQLiteAttachmentStore;
  let assertWriter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeCanonicalSchema(db, {
      rebuildAllTimelineOrdinalsV2: () => {},
      rebuildTimelineProjectionV2: () => {},
    });
    assertWriter = vi.fn();
    store = new SQLiteAttachmentStore(db, assertWriter);
  });

  afterEach(() => db.close());

  it('rolls back a rejected initial offset and resumes idempotent staging', async () => {
    await expect(store.stageAttachmentChunk(reference, 2, data.subarray(2)))
      .rejects.toThrow('attachment_chunk_offset_mismatch');
    expect(db.prepare('SELECT * FROM attachment_sync_staging').all()).toEqual([]);
    expect(await store.stageAttachmentChunk(reference, 0, data.subarray(0, 2))).toBe(2);
    expect(await store.stageAttachmentChunk(reference, 0, data.subarray(0, 2))).toBe(2);
    await expect(store.commitStagedAttachment(reference.contentHash)).rejects.toThrow('attachment_incomplete');
    expect(await store.getAttachment(reference.contentHash)).toBeNull();
    expect(await store.stageAttachmentChunk(reference, 2, data.subarray(2))).toBe(data.length);
    await store.commitStagedAttachment(reference.contentHash);
    expect(await store.getAttachment(reference.contentHash)).toEqual(reference);
    expect(await store.readAttachmentData(reference.contentHash)).toEqual(new Uint8Array(data));
    expect(await store.readAttachmentRange(reference.contentHash, 2, 3)).toEqual(new Uint8Array(data.subarray(2, 5)));
    expect(await store.verifyAttachment(reference.contentHash)).toBe(true);
    expect(db.prepare('SELECT * FROM attachment_sync_staging').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM attachment_sync_chunks').all()).toEqual([]);
  });

  it('retains staged chunks when publication rolls back and permits a later commit', async () => {
    await store.stageAttachmentChunk(reference, 0, data.subarray(0, 2));
    await store.stageAttachmentChunk(reference, 2, data.subarray(2));
    db.exec(`
      CREATE TRIGGER reject_attachment_append BEFORE UPDATE ON attachments
      BEGIN SELECT RAISE(ABORT, 'append_failed'); END
    `);
    await expect(store.commitStagedAttachment(reference.contentHash)).rejects.toThrow('append_failed');
    expect(await store.getAttachment(reference.contentHash)).toBeNull();
    expect(db.prepare('SELECT * FROM attachment_sync_chunks').all()).toHaveLength(2);
    db.exec('DROP TRIGGER reject_attachment_append');
    await store.commitStagedAttachment(reference.contentHash);
    await store.commitStagedAttachment(reference.contentHash);
    expect(await store.verifyAttachment(reference.contentHash)).toBe(true);
  });

  it('checks cancellation before staging or publishing and keeps reads lease-independent', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(store.stageAttachmentChunk(reference, 0, data, { signal })).rejects.toThrow('cancelled');
    await expect(store.commitStagedAttachment(reference.contentHash, { signal })).rejects.toThrow('cancelled');
    await expect(store.readAttachmentRange(reference.contentHash, 0, 1, { signal })).rejects.toThrow('cancelled');
    await expect(store.verifyAttachment(reference.contentHash, { signal })).rejects.toThrow('cancelled');
    expect(assertWriter).not.toHaveBeenCalled();
    await store.saveAttachment(reference, data);
    assertWriter.mockImplementation(() => {
      throw new Error('lease_expired');
    });
    expect(await store.verifyAttachment(reference.contentHash)).toBe(true);
    await expect(store.saveAttachment(reference, data)).rejects.toThrow('lease_expired');
    await expect(store.stageAttachmentChunk(reference, 0, data)).rejects.toThrow('lease_expired');
    await expect(store.commitStagedAttachment(reference.contentHash)).rejects.toThrow('lease_expired');
  });
});

it('delegates attachment writes through the facade current writer lease', async () => {
  let held = true;
  const directory = mkdtempSync(join(tmpdir(), 'memeloop-attachment-lease-'));
  const filename = join(directory, 'storage.db');
  const lease = acquireWriterLease(filename);
  const storage = new SQLiteAgentStorage({
    filename,
    lease: { ...lease, held: () => held && lease.held() },
  });
  try {
    await storage.stageAttachmentChunk(reference, 0, data);
    held = false;
    await expect(storage.saveAttachment(reference, data)).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await expect(storage.stageAttachmentChunk(reference, 0, data)).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await expect(storage.commitStagedAttachment(reference.contentHash)).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    held = true;
    await storage.commitStagedAttachment(reference.contentHash);
    held = false;
    expect(await storage.verifyAttachment(reference.contentHash)).toBe(true);
    expect(await storage.readAttachmentData(reference.contentHash)).toEqual(new Uint8Array(data));
  } finally {
    storage.close();
    lease.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

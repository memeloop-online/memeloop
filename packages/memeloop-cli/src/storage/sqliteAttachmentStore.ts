import type Database from 'better-sqlite3';
import type { AttachmentReference } from 'memeloop';
import { createHash } from 'node:crypto';

export class SQLiteAttachmentStore {
  constructor(
    private readonly database: Database.Database,
    private readonly assertWriter: () => void,
  ) {}

  async conversationReferencesAttachment(conversationId: string, contentHash: string): Promise<boolean> {
    return this.database.prepare(`
      SELECT 1 FROM conversation_attachment_references
      WHERE conversationId = ? AND contentHash = ? LIMIT 1
    `).get(conversationId, contentHash) !== undefined;
  }

  async getAttachment(contentHash: string): Promise<AttachmentReference | null> {
    const row = this.database.prepare(`
      SELECT contentHash, filename, mimeType, size
      FROM attachments WHERE contentHash = ?
    `).get(contentHash) as AttachmentReference | undefined;
    return row ?? null;
  }

  async saveAttachment(reference: AttachmentReference, data: Buffer | Uint8Array): Promise<void> {
    this.assertWriter();
    this.database.prepare(`
      INSERT OR REPLACE INTO attachments (contentHash, filename, mimeType, size, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(reference.contentHash, reference.filename, reference.mimeType, reference.size, Buffer.from(data));
  }

  async readAttachmentData(contentHash: string): Promise<Uint8Array | null> {
    const row = this.database.prepare('SELECT data FROM attachments WHERE contentHash = ?')
      .get(contentHash) as { data: Buffer } | undefined;
    return row?.data ? new Uint8Array(row.data) : null;
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
    const row = this.database.prepare(`
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
    return this.database.transaction(() => {
      const published = this.database.prepare(`
        SELECT filename, mimeType, size FROM attachments WHERE contentHash = ?
      `).get(reference.contentHash) as Pick<AttachmentReference, 'filename' | 'mimeType' | 'size'> | undefined;
      if (published) {
        if (published.size !== reference.size) throw new Error('attachment_reference_conflict');
        return reference.size;
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO attachment_sync_staging (
          contentHash, filename, mimeType, size, nextOffset
        ) VALUES (?, ?, ?, ?, 0)
      `).run(reference.contentHash, reference.filename, reference.mimeType, reference.size);
      const staging = this.database.prepare(`
        SELECT filename, mimeType, size, nextOffset
        FROM attachment_sync_staging WHERE contentHash = ?
      `).get(reference.contentHash) as Pick<AttachmentReference, 'filename' | 'mimeType' | 'size'> & {
        nextOffset: number;
      };
      if (staging.size !== reference.size) throw new Error('attachment_reference_conflict');
      if (offset < staging.nextOffset) {
        const prior = this.database.prepare(`
          SELECT data FROM attachment_sync_chunks WHERE contentHash = ? AND offset = ?
        `).get(reference.contentHash, offset) as { data: Buffer } | undefined;
        if (!prior || !Buffer.from(data).equals(prior.data)) {
          if (offset !== 0) throw new Error('attachment_chunk_retry_conflict');
          // A new peer may replace an unverified corrupt prefix, never a published body.
          this.database.prepare('DELETE FROM attachment_sync_chunks WHERE contentHash = ?').run(reference.contentHash);
          this.database.prepare('UPDATE attachment_sync_staging SET nextOffset = 0 WHERE contentHash = ?').run(reference.contentHash);
          staging.nextOffset = 0;
        } else {
          return staging.nextOffset;
        }
      }
      if (offset !== staging.nextOffset) throw new Error('attachment_chunk_offset_mismatch');
      this.database.prepare(`
        INSERT INTO attachment_sync_chunks (contentHash, offset, data) VALUES (?, ?, ?)
      `).run(reference.contentHash, offset, Buffer.from(data));
      const nextOffset = offset + data.byteLength;
      this.database.prepare(`
        UPDATE attachment_sync_staging SET nextOffset = ? WHERE contentHash = ?
      `).run(nextOffset, reference.contentHash);
      return nextOffset;
    })();
  }

  async commitStagedAttachment(contentHash: string, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    this.assertWriter();
    const published = await this.getAttachment(contentHash);
    if (published) {
      if (!await this.verifyAttachment(contentHash)) throw new Error('attachment_hash_mismatch');
      return;
    }
    const staging = this.database.prepare(`
      SELECT contentHash, filename, mimeType, size, nextOffset
      FROM attachment_sync_staging WHERE contentHash = ?
    `).get(contentHash) as AttachmentReference & { nextOffset: number } | undefined;
    if (!staging || staging.nextOffset !== staging.size) throw new Error('attachment_incomplete');
    const chunks = this.database.prepare(`
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
      // An unverified body must not poison every later retry from a good peer.
      this.database.transaction(() => {
        this.database.prepare('DELETE FROM attachment_sync_chunks WHERE contentHash = ?').run(contentHash);
        this.database.prepare('DELETE FROM attachment_sync_staging WHERE contentHash = ?').run(contentHash);
      })();
      throw new Error('attachment_hash_mismatch');
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO attachments (contentHash, filename, mimeType, size, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(contentHash, staging.filename, staging.mimeType, staging.size, Buffer.alloc(0));
      const offsets = this.database.prepare(`
        SELECT offset FROM attachment_sync_chunks WHERE contentHash = ? ORDER BY offset
      `).all(contentHash) as Array<{ offset: number }>;
      const selectChunk = this.database.prepare(`
        SELECT data FROM attachment_sync_chunks WHERE contentHash = ? AND offset = ?
      `);
      const appendChunk = this.database.prepare(`
        UPDATE attachments SET data = CAST(data || ? AS BLOB) WHERE contentHash = ?
      `);
      for (const item of offsets) {
        options?.signal?.throwIfAborted();
        const chunk = selectChunk.get(contentHash, item.offset) as { data: Buffer };
        appendChunk.run(chunk.data, contentHash);
      }
      this.database.prepare('DELETE FROM attachment_sync_chunks WHERE contentHash = ?').run(contentHash);
      this.database.prepare('DELETE FROM attachment_sync_staging WHERE contentHash = ?').run(contentHash);
    })();
  }

  async verifyAttachment(contentHash: string, options?: { signal?: AbortSignal }): Promise<boolean> {
    options?.signal?.throwIfAborted();
    if (!/^sha256:[\da-f]{64}$/iu.test(contentHash)) return false;
    const reference = await this.getAttachment(contentHash);
    if (!reference) return false;
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < reference.size) {
      options?.signal?.throwIfAborted();
      const chunk = await this.readAttachmentRange(contentHash, offset, 3 * 1024 * 1024, options);
      if (!chunk || chunk.byteLength === 0) return false;
      digest.update(chunk);
      offset += chunk.byteLength;
    }
    return offset === reference.size && `sha256:${digest.digest('hex')}` === contentHash.toLowerCase();
  }
}

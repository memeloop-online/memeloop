import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStorageConformance } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MarkdownAgentStorage } from '../storage/markdownStorage.js';

describe('MarkdownAgentStorage', () => {
  let root: string;
  let storage: MarkdownAgentStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memeloop-md-'));
    storage = new MarkdownAgentStorage({ rootDirectory: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the storage conformance suite', async () => {
    const report = await runStorageConformance(storage, { conversationId: 'md-conformance' });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.checks);
  });

  it('writes metadata atomically without leaving temp files', async () => {
    await storage.upsertConversationMetadata({
      conversationId: 'c1',
      title: 'test',
      lastMessagePreview: '',
      lastMessageTimestamp: Date.now(),
      messageCount: 0,
      originNodeId: 'local',
      definitionId: 'agent',
      isUserInitiated: true,
    });

    const metaFiles = await readdir(join(root, 'meta'));
    expect(metaFiles).toEqual(['c1.json']);
    expect(metaFiles.every((file) => !file.includes('.tmp-'))).toBe(true);

    const written = JSON.parse(await readFile(join(root, 'meta', 'c1.json'), 'utf8')) as { title: string };
    expect(written.title).toBe('test');
  });

  it('stores blobs content-addressed and converges identical content to one object', async () => {
    const bytes = new TextEncoder().encode('same-content');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const reference = { contentHash, filename: 'a.bin', mimeType: 'application/octet-stream', size: bytes.byteLength };

    await storage.saveAttachment(reference, bytes);
    await storage.saveAttachment({ ...reference, filename: 'b.bin' }, bytes);

    const blobFiles = (await readdir(join(root, 'blobs'))).filter((file) => !file.endsWith('.json'));
    expect(blobFiles).toEqual([encodeURIComponent(contentHash)]);
    const data = await storage.readAttachmentData(contentHash);
    expect(new TextDecoder().decode(data ?? new Uint8Array())).toBe('same-content');
  });

  it('isolates corrupt immutable event files on read', async () => {
    const eventsPath = join(root, 'events', 'c1');
    await storage.appendMessage({ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 } as never);
    await mkdir(eventsPath, { recursive: true });
    await writeFile(join(eventsPath, 'broken.json'), '{"messageId":"m2",broken', 'utf8');

    const messages = await storage.getMessages('c1');
    expect(messages.map((message) => message.messageId)).toEqual(['m1']);
  });

  it('dedupes insertMessagesIfAbsent across separate calls', async () => {
    const message = { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 } as never;
    await storage.insertMessagesIfAbsent([message]);
    await storage.insertMessagesIfAbsent([message]);
    expect(await storage.getMessages('c1')).toHaveLength(1);
  });

  it('dedupes concurrent publication across storage instances', async () => {
    const second = new MarkdownAgentStorage({ rootDirectory: root });
    const message = { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 } as never;
    await Promise.all([storage.insertMessagesIfAbsent([message]), second.insertMessagesIfAbsent([message])]);
    expect(await storage.getMessages('c1')).toHaveLength(1);
  });

  it('rejects attachment hash and size mismatches', async () => {
    const bytes = new TextEncoder().encode('content');
    await expect(storage.saveAttachment({
      contentHash: 'sha256:not-the-content',
      filename: 'bad.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
    }, bytes)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(storage.saveAttachment({
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      filename: 'bad-size.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength + 1,
    }, bytes)).rejects.toMatchObject({ code: 'INVALID' });
  });
});

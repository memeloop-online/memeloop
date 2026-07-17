import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    const reference = { contentHash: 'sha256:same', filename: 'a.bin', mimeType: 'application/octet-stream', size: bytes.byteLength };

    await storage.saveAttachment(reference, bytes);
    await storage.saveAttachment({ ...reference, filename: 'b.bin' }, bytes);

    const blobFiles = (await readdir(join(root, 'blobs'))).filter((file) => !file.endsWith('.json'));
    expect(blobFiles).toEqual(['sha256%3Asame']);
    const data = await storage.readAttachmentData('sha256:same');
    expect(new TextDecoder().decode(data ?? new Uint8Array())).toBe('same-content');
  });

  it('appends events as JSONL and skips torn lines on read', async () => {
    const eventsPath = join(root, 'events', 'c1.jsonl');
    await storage.appendMessage({ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 } as never);
    // Simulate a torn write at the tail.
    await writeFile(eventsPath, `${JSON.stringify({ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 })}\n{"messageId":"m2",broken`, 'utf8');

    const messages = await storage.getMessages('c1');
    expect(messages.map((message) => message.messageId)).toEqual(['m1']);
  });

  it('dedupes insertMessagesIfAbsent across separate calls', async () => {
    const message = { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'one', lamportClock: 1 } as never;
    await storage.insertMessagesIfAbsent([message]);
    await storage.insertMessagesIfAbsent([message]);
    expect(await storage.getMessages('c1')).toHaveLength(1);
  });
});

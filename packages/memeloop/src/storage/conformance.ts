import { type AttachmentReference, createChatMessage } from '../conversation/index.js';

import type { FullAgentStorage } from './ports.js';

/**
 * Storage conformance suite (plan 24.43).
 *
 * Host-agnostic behavioral checks every logical storage driver must pass.
 * Run it in the host's own test setup (`runStorageConformance` returns a
 * report; `assertStorageConformance` throws on the first failure summary).
 * Drivers that implement only a subset of ports can run the relevant checks
 * via `checks` filtering.
 */

export interface StorageConformanceFailure {
  check: string;
  message: string;
}

export interface StorageConformanceReport {
  checks: number;
  passed: number;
  failures: StorageConformanceFailure[];
}

export const STORAGE_CONFORMANCE_CHECKS = [
  'append-and-read-messages',
  'insert-if-absent-dedupes',
  'conversation-metadata-round-trip',
  'list-conversations',
  'attachment-round-trip',
  'missing-definition-returns-null',
] as const;

export type StorageConformanceCheck = (typeof STORAGE_CONFORMANCE_CHECKS)[number];

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export async function runStorageConformance(
  storage: FullAgentStorage,
  options: { conversationId?: string; checks?: readonly StorageConformanceCheck[] } = {},
): Promise<StorageConformanceReport> {
  const conversationId = options.conversationId ?? `conformance-${Date.now().toString(36)}`;
  const enabled = new Set(options.checks ?? STORAGE_CONFORMANCE_CHECKS);
  const failures: StorageConformanceFailure[] = [];
  let checks = 0;

  async function run(name: StorageConformanceCheck, body: () => Promise<void>): Promise<void> {
    if (!enabled.has(name)) return;
    checks += 1;
    try {
      await body();
    } catch (error) {
      failures.push({ check: name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  function expect(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  await run('append-and-read-messages', async () => {
    const first = createChatMessage({ messageId: `${conversationId}:m1`, conversationId, role: 'user', content: 'hello', lamportClock: 1 });
    const second = createChatMessage({ messageId: `${conversationId}:m2`, conversationId, role: 'assistant', content: 'world', lamportClock: 2 });
    await storage.appendMessage(first);
    await storage.appendMessage(second);
    const messages = await storage.getMessages(conversationId, { mode: 'full-content' });
    const ids = messages.map((message) => message.messageId);
    expect(ids.includes(first.messageId) && ids.includes(second.messageId), `expected both messages, got ${ids.join(',')}`);
    const roundTrip = messages.find((message) => message.messageId === first.messageId);
    expect(roundTrip?.content === 'hello', 'message content must round-trip');
  });

  await run('insert-if-absent-dedupes', async () => {
    const message = createChatMessage({ messageId: `${conversationId}:dup`, conversationId, role: 'user', content: 'once', lamportClock: 3 });
    await storage.insertMessagesIfAbsent([message]);
    await storage.insertMessagesIfAbsent([message]);
    const messages = await storage.getMessages(conversationId, { mode: 'full-content' });
    const occurrences = messages.filter((entry) => entry.messageId === message.messageId);
    expect(occurrences.length === 1, `expected exactly one copy, got ${occurrences.length}`);
  });

  await run('conversation-metadata-round-trip', async () => {
    await storage.upsertConversationMetadata({
      conversationId,
      title: 'conformance',
      lastMessagePreview: '',
      lastMessageTimestamp: Date.now(),
      messageCount: 0,
      originNodeId: 'local',
      definitionId: 'conformance-agent',
      isUserInitiated: true,
    });
    const meta = await storage.getConversationMeta(conversationId);
    expect(meta != null, 'getConversationMeta must return the upserted row');
    expect(meta?.definitionId === 'conformance-agent', 'metadata fields must round-trip');
  });

  await run('list-conversations', async () => {
    const conversations = await storage.listConversations();
    expect(
      conversations.some((meta) => meta.conversationId === conversationId),
      'listConversations must include the written conversation',
    );
  });

  await run('attachment-round-trip', async () => {
    const bytes = new TextEncoder().encode('conformance-blob-payload');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const contentHash = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const reference: AttachmentReference = {
      contentHash,
      filename: 'payload.bin',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
    };
    await storage.saveAttachment(reference, bytes);
    const stored = await storage.getAttachment(reference.contentHash);
    expect(stored != null, 'getAttachment must return the saved reference');
    if (typeof storage.readAttachmentData === 'function') {
      const data = await storage.readAttachmentData(reference.contentHash);
      expect(data != null && bytesEqual(data, bytes), 'attachment bytes must round-trip as Uint8Array');
    }
  });

  await run('missing-definition-returns-null', async () => {
    const missing = await storage.getAgentDefinition(`${conversationId}:missing`);
    expect(missing === null, 'getAgentDefinition must return null for unknown ids');
  });

  return { checks, passed: checks - failures.length, failures };
}

export async function assertStorageConformance(
  storage: FullAgentStorage,
  options: { conversationId?: string; checks?: readonly StorageConformanceCheck[] } = {},
): Promise<void> {
  const report = await runStorageConformance(storage, options);
  if (report.failures.length > 0) {
    const summary = report.failures.map((failure) => `${failure.check}: ${failure.message}`).join('; ');
    throw new Error(`storage conformance failed (${report.passed}/${report.checks}): ${summary}`);
  }
}

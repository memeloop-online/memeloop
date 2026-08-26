import { type AttachmentReference, createLocalMessageDraft } from '../conversation/index.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';

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
  'list-conversations-page',
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
      failures.push({ check: name, message: safeErrorMessageFromUnknown(error, { fallback: 'Storage conformance check failed' }) });
    }
  }

  function expect(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  async function ensureConversationMetadata(): Promise<void> {
    if (await storage.getConversationMeta(conversationId)) return;
    await storage.upsertConversationMetadata({
      conversationId,
      title: 'conformance',
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: 'conformance',
      originClock: 0,
      definitionId: 'conformance-agent',
      isUserInitiated: true,
    });
  }

  await run('append-and-read-messages', async () => {
    await ensureConversationMetadata();
    const firstId = `${conversationId}:m1`;
    const first = await storage.appendLocalEvent(createLocalMessageDraft({
      messageId: firstId,
      turnId: firstId,
      conversationId,
      originNodeId: 'conformance',
      timestamp: 1,
      role: 'user',
      content: 'hello',
    }));
    const secondId = `${conversationId}:m2`;
    await storage.appendLocalEvent(createLocalMessageDraft({
      messageId: secondId,
      turnId: firstId,
      conversationId,
      originNodeId: 'conformance',
      timestamp: 2,
      role: 'assistant',
      content: 'world',
    }));
    const page = await storage.getMessagePage(conversationId, {
      direction: 'forward',
      limit: 16,
      maxBytes: 1_048_576,
      mode: 'full-content',
    });
    if (page.reset) {
      throw new Error('initial message page must not reset');
    }
    const messages = page.items;
    const ids = messages.map((message) => message.messageId);
    expect(ids.includes(firstId) && ids.includes(secondId), `expected both messages, got ${ids.join(',')}`);
    const roundTrip = messages.find((message) => message.messageId === first.eventId);
    expect(roundTrip?.content === 'hello', 'message content must round-trip');
  });

  await run('insert-if-absent-dedupes', async () => {
    await ensureConversationMetadata();
    const messageId = `${conversationId}:dup`;
    const message = await storage.appendLocalEvent(createLocalMessageDraft({
      messageId,
      turnId: messageId,
      conversationId,
      originNodeId: 'conformance',
      timestamp: 3,
      role: 'user',
      content: 'once',
    }));
    await storage.insertEventsIfAbsent([message]);
    const page = await storage.getMessagePage(conversationId, {
      direction: 'forward',
      limit: 16,
      maxBytes: 1_048_576,
      mode: 'full-content',
    });
    if (page.reset) {
      throw new Error('initial message page must not reset');
    }
    const messages = page.items;
    const occurrences = messages.filter((entry) => entry.messageId === messageId);
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
      originClock: 1,
      definitionId: 'conformance-agent',
      isUserInitiated: true,
    });
    const meta = await storage.getConversationMeta(conversationId);
    expect(meta != null, 'getConversationMeta must return the upserted row');
    expect(meta?.definitionId === 'conformance-agent', 'metadata fields must round-trip');
  });

  await run('list-conversations-page', async () => {
    await ensureConversationMetadata();
    const page = await storage.listConversationsPage({
      limit: 100,
      maxBytes: 1_048_576,
    });
    expect(!page.reset, 'initial conversation list page must not reset');
    const conversations = page.reset ? [] : page.items;
    expect(
      conversations.some((meta) => meta.conversationId === conversationId),
      'listConversationsPage must include the written conversation',
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

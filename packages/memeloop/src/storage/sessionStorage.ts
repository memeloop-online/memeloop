import type { ChatMessage } from '../conversation/index.js';

export interface CheckpointRecord {
  conversationId: string;
  messages: ChatMessage[];
  savedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface CheckpointSummary {
  conversationId: string;
  savedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface CheckpointStore {
  saveCheckpoint(conversationId: string, messages: ChatMessage[]): Promise<CheckpointRecord>;
  loadCheckpoint(conversationId: string): Promise<CheckpointRecord | null>;
  listCheckpoints(): Promise<CheckpointSummary[]>;
  deleteCheckpoint(conversationId: string): Promise<boolean>;
}

export interface SessionStorageOptions {
  records?: CheckpointRecord[];
}

export function createCheckpointRecord(
  conversationId: string,
  messages: ChatMessage[],
  savedAt = new Date().toISOString(),
): CheckpointRecord {
  const lastMessage = messages[messages.length - 1];
  const preview = lastMessage && typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 200) : '';

  return {
    conversationId,
    messages: [...messages],
    savedAt,
    messageCount: messages.length,
    lastMessagePreview: preview,
  };
}

export function parseCheckpointRecord(raw: string): CheckpointRecord | null {
  try {
    const record = JSON.parse(raw) as unknown;
    return isCheckpointRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export function serializeCheckpointRecord(record: CheckpointRecord): string {
  return JSON.stringify(record, null, 2);
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, CheckpointRecord>();

  constructor(options: SessionStorageOptions = {}) {
    for (const record of options.records ?? []) {
      this.records.set(record.conversationId, cloneCheckpointRecord(record));
    }
  }

  async saveCheckpoint(conversationId: string, messages: ChatMessage[]): Promise<CheckpointRecord> {
    const record = createCheckpointRecord(conversationId, messages);
    this.records.set(conversationId, cloneCheckpointRecord(record));
    return cloneCheckpointRecord(record);
  }

  async loadCheckpoint(conversationId: string): Promise<CheckpointRecord | null> {
    const record = this.records.get(conversationId);
    return record ? cloneCheckpointRecord(record) : null;
  }

  async listCheckpoints(): Promise<CheckpointSummary[]> {
    return [...this.records.values()]
      .map(toCheckpointSummary)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async deleteCheckpoint(conversationId: string): Promise<boolean> {
    return this.records.delete(conversationId);
  }
}

export class SessionStorage extends InMemoryCheckpointStore {}

function isCheckpointRecord(record: unknown): record is CheckpointRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Record<string, unknown>;
  return (
    typeof candidate.conversationId === 'string' &&
    Array.isArray(candidate.messages) &&
    typeof candidate.savedAt === 'string' &&
    typeof candidate.messageCount === 'number' &&
    typeof candidate.lastMessagePreview === 'string'
  );
}

function cloneCheckpointRecord(record: CheckpointRecord): CheckpointRecord {
  return {
    ...record,
    messages: [...record.messages],
  };
}

function toCheckpointSummary(record: CheckpointRecord): CheckpointSummary {
  return {
    conversationId: record.conversationId,
    savedAt: record.savedAt,
    messageCount: record.messageCount,
    lastMessagePreview: record.lastMessagePreview,
  };
}

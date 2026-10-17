import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  assertCanonicalChatMessageProjection,
  type ChatMessage,
  type CheckpointRecord,
  type CheckpointStore,
  type CheckpointSummary,
  createCheckpointRecord,
  type MemeLoopLogger,
  parseCheckpointRecord,
  serializeCheckpointRecord,
} from 'memeloop';

export interface FileCheckpointStoreOptions {
  directory: string;
  logger?: Pick<MemeLoopLogger, 'warn'>;
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string;
  private readonly logger?: Pick<MemeLoopLogger, 'warn'>;

  constructor(options: FileCheckpointStoreOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
  }

  async saveCheckpoint(
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<CheckpointRecord> {
    assertCanonicalCheckpointMessages(conversationId, messages);
    await this.ensureDirectory();
    const record = createCheckpointRecord(conversationId, messages);
    await fs.writeFile(this.checkpointPath(conversationId), serializeCheckpointRecord(record), 'utf-8');
    return record;
  }

  async loadCheckpoint(conversationId: string): Promise<CheckpointRecord | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath(conversationId), 'utf-8');
      const record = parseCheckpointRecord(raw);
      if (record === null) return null;
      assertCanonicalCheckpointMessages(record.conversationId, record.messages);
      return record;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async listCheckpoints(): Promise<CheckpointSummary[]> {
    await this.ensureDirectory();
    const entries: CheckpointSummary[] = [];

    try {
      const files = await fs.readdir(this.directory);
      for (const file of files) {
        if (!file.endsWith('.checkpoint.json')) continue;
        const checkpointFile = path.join(this.directory, file);
        try {
          const raw = await fs.readFile(checkpointFile, 'utf-8');
          const record = parseCheckpointRecord(raw);
          if (!record) {
            this.logger?.warn?.(
              `checkpoint file '${checkpointFile}' is invalid: expected a canonical checkpoint record`,
            );
            continue;
          }
          assertCanonicalCheckpointMessages(record.conversationId, record.messages);
          entries.push({
            conversationId: record.conversationId,
            savedAt: record.savedAt,
            messageCount: record.messageCount,
            lastMessagePreview: record.lastMessagePreview,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger?.warn?.(`checkpoint file '${checkpointFile}' skipped: ${detail}`, error);
        }
      }
    } catch (error: unknown) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async deleteCheckpoint(conversationId: string): Promise<boolean> {
    try {
      await fs.unlink(this.checkpointPath(conversationId));
      return true;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  private checkpointPath(conversationId: string): string {
    const safeName = conversationId.replace(/[<>:"/\\|?*]/g, '_');
    return path.join(this.directory, `${safeName}.checkpoint.json`);
  }
}

export class SessionStorage extends FileCheckpointStore {}

function assertCanonicalCheckpointMessages(
  conversationId: string,
  messages: readonly ChatMessage[],
): void {
  for (const [index, message] of messages.entries()) {
    try {
      assertCanonicalChatMessageProjection(message, conversationId);
    } catch (error) {
      throw new Error(`checkpoint message ${index} is not canonical`, { cause: error });
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

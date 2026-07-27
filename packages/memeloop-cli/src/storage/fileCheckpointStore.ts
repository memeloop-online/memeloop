import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  type ChatMessage,
  type CheckpointRecord,
  type CheckpointStore,
  type CheckpointSummary,
  createCheckpointRecord,
  parseCheckpointRecord,
  serializeCheckpointRecord,
} from 'memeloop';

export interface FileCheckpointStoreOptions {
  directory: string;
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string;

  constructor(options: FileCheckpointStoreOptions) {
    this.directory = options.directory;
  }

  async saveCheckpoint(
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<CheckpointRecord> {
    await this.ensureDirectory();
    const record = createCheckpointRecord(conversationId, messages);
    await fs.writeFile(this.checkpointPath(conversationId), serializeCheckpointRecord(record), 'utf-8');
    return record;
  }

  async loadCheckpoint(conversationId: string): Promise<CheckpointRecord | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath(conversationId), 'utf-8');
      return parseCheckpointRecord(raw);
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
        try {
          const raw = await fs.readFile(path.join(this.directory, file), 'utf-8');
          const record = parseCheckpointRecord(raw);
          if (!record) continue;
          entries.push({
            conversationId: record.conversationId,
            savedAt: record.savedAt,
            messageCount: record.messageCount,
            lastMessagePreview: record.lastMessagePreview,
          });
        } catch {
          // Skip malformed or unreadable checkpoint files.
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

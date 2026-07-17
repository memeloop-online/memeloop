import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AgentDefinition,
  AgentInstanceMeta,
  AttachmentReference,
  ChatMessage,
  ConversationMeta,
  FullAgentStorage,
  GetMessagesOptions,
  IMChannelBinding,
  ListConversationsOptions,
} from 'memeloop';

/**
 * Markdown/filesystem storage driver (plan 24.43).
 *
 * Text-native, git-friendly layout:
 *   events/<conversation>.jsonl   append-only conversation events (one JSON per line)
 *   meta/<conversation>.json      conversation directory rows
 *   blobs/<hash>                  content-addressed blob bytes
 *   blobs/<hash>.json             blob references
 *   definitions/<id>.json         agent definitions
 *   instances/<id>.json           agent run state
 *   im/<channel>-<user>.json      IM bindings
 *
 * Write guarantees: blob/meta/definition writes use write-temp-then-rename
 * (POSIX-atomic replacement); event appends use O_APPEND (atomic for
 * line-sized writes). Blob paths are derived from the caller-supplied
 * content hash (content-addressed), so identical content converges to one
 * object.
 */

export interface MarkdownStorageOptions {
  rootDirectory: string;
}

let temporaryCounter = 0;

async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryCounter += 1;
  const temporary = `${path}.tmp-${process.pid}-${temporaryCounter.toString(36)}`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

function sanitizeId(id: string): string {
  return encodeURIComponent(id);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class MarkdownAgentStorage implements FullAgentStorage {
  private readonly root: string;

  constructor(options: MarkdownStorageOptions) {
    this.root = options.rootDirectory;
  }

  private eventsPath(conversationId: string): string {
    return join(this.root, 'events', `${sanitizeId(conversationId)}.jsonl`);
  }

  private metaPath(conversationId: string): string {
    return join(this.root, 'meta', `${sanitizeId(conversationId)}.json`);
  }

  private blobPath(contentHash: string): string {
    return join(this.root, 'blobs', sanitizeId(contentHash));
  }

  private async readEvents(conversationId: string): Promise<ChatMessage[]> {
    let text: string;
    try {
      text = await readFile(this.eventsPath(conversationId), 'utf8');
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as ChatMessage);
      } catch {
        // Skip torn/corrupt lines instead of failing the whole read.
      }
    }
    return messages;
  }

  async listConversations(options: ListConversationsOptions = {}): Promise<ConversationMeta[]> {
    let files: string[] = [];
    try {
      files = await readdir(join(this.root, 'meta'));
    } catch {
      return [];
    }
    const metas: ConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const meta = await readJsonFile<ConversationMeta>(join(this.root, 'meta', file));
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0));
    const offset = options.offset ?? 0;
    const limit = options.limit ?? metas.length;
    return metas.slice(offset, offset + limit);
  }

  async getMessages(conversationId: string, _options: GetMessagesOptions = {}): Promise<ChatMessage[]> {
    return this.readEvents(conversationId);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const path = this.eventsPath(message.conversationId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(message)}\n`, 'utf8');
  }

  async insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void> {
    const byConversation = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const list = byConversation.get(message.conversationId) ?? [];
      list.push(message);
      byConversation.set(message.conversationId, list);
    }
    for (const [conversationId, batch] of byConversation) {
      const existing = new Set((await this.readEvents(conversationId)).map((message) => message.messageId));
      for (const message of batch) {
        if (!existing.has(message.messageId)) {
          await this.appendMessage(message);
          existing.add(message.messageId);
        }
      }
    }
  }

  async getMaxLamportClockForConversation(conversationId: string): Promise<number> {
    const messages = await this.readEvents(conversationId);
    return messages.reduce((max, message) => Math.max(max, message.lamportClock ?? 0), 0);
  }

  async upsertConversationMetadata(meta: ConversationMeta): Promise<void> {
    await writeFileAtomic(this.metaPath(meta.conversationId), JSON.stringify(meta, null, 2));
  }

  async getConversationMeta(conversationId: string): Promise<ConversationMeta | null> {
    return readJsonFile<ConversationMeta>(this.metaPath(conversationId));
  }

  async saveAttachment(reference: AttachmentReference, data: Uint8Array): Promise<void> {
    await writeFileAtomic(this.blobPath(reference.contentHash), data);
    await writeFileAtomic(`${this.blobPath(reference.contentHash)}.json`, JSON.stringify(reference, null, 2));
  }

  async getAttachment(contentHash: string): Promise<AttachmentReference | null> {
    return readJsonFile<AttachmentReference>(`${this.blobPath(contentHash)}.json`);
  }

  async readAttachmentData(contentHash: string): Promise<Uint8Array | null> {
    try {
      const data = await readFile(this.blobPath(contentHash));
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return null;
    }
  }

  async getAgentDefinition(id: string): Promise<AgentDefinition | null> {
    return readJsonFile<AgentDefinition>(join(this.root, 'definitions', `${sanitizeId(id)}.json`));
  }

  async saveAgentDefinition(definition: AgentDefinition & { id: string }): Promise<void> {
    await writeFileAtomic(join(this.root, 'definitions', `${sanitizeId(definition.id)}.json`), JSON.stringify(definition, null, 2));
  }

  async saveAgentInstance(meta: AgentInstanceMeta): Promise<void> {
    await writeFileAtomic(join(this.root, 'instances', `${sanitizeId(meta.instanceId)}.json`), JSON.stringify(meta, null, 2));
  }

  async getImBinding(channelId: string, imUserId: string): Promise<IMChannelBinding | null> {
    return readJsonFile<IMChannelBinding>(join(this.root, 'im', `${sanitizeId(`${channelId}:${imUserId}`)}.json`));
  }

  async setImBinding(record: IMChannelBinding): Promise<void> {
    const key = `${record.channelId}:${record.imUserId}`;
    await writeFileAtomic(join(this.root, 'im', `${sanitizeId(key)}.json`), JSON.stringify(record, null, 2));
  }

  /** Remove the storage tree (tests). */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

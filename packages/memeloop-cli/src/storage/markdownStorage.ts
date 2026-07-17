import { createHash } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OrchestrationError } from 'memeloop';
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
 *   events/<conversation>/<id>    immutable conversation event files
 *   meta/<conversation>.json      conversation directory rows
 *   blobs/<hash>                  content-addressed blob bytes
 *   blobs/<hash>.json             blob references
 *   definitions/<id>.json         agent definitions
 *   instances/<id>.json           agent run state
 *   im/<channel>-<user>.json      IM bindings
 *
 * Write guarantees: blob/meta/definition writes use write-temp-then-rename
 * (POSIX-atomic replacement); event publication uses an atomic hard link so
 * concurrent processes cannot publish the same message identity twice.
 * Blob hashes and sizes are recomputed before storage.
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

async function writeFileIfAbsentAtomic(path: string, data: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  temporaryCounter += 1;
  const temporary = `${path}.tmp-${process.pid}-${temporaryCounter.toString(36)}`;
  await writeFile(temporary, data, { flag: 'wx' });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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

  private eventsDirectory(conversationId: string): string {
    return join(this.root, 'events', sanitizeId(conversationId));
  }

  private eventPath(message: Pick<ChatMessage, 'conversationId' | 'messageId'>): string {
    return join(this.eventsDirectory(message.conversationId), `${sanitizeId(message.messageId)}.json`);
  }

  private metaPath(conversationId: string): string {
    return join(this.root, 'meta', `${sanitizeId(conversationId)}.json`);
  }

  private blobPath(contentHash: string): string {
    return join(this.root, 'blobs', sanitizeId(contentHash));
  }

  private async readEvents(conversationId: string): Promise<ChatMessage[]> {
    let files: string[];
    try {
      files = await readdir(this.eventsDirectory(conversationId));
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        messages.push(JSON.parse(await readFile(join(this.eventsDirectory(conversationId), file), 'utf8')) as ChatMessage);
      } catch {
        // A corrupt immutable event is isolated instead of hiding valid peers.
      }
    }
    return messages.sort((left, right) =>
      (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
      (left.lamportClock ?? 0) - (right.lamportClock ?? 0) ||
      left.messageId.localeCompare(right.messageId)
    );
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
    await writeFileIfAbsentAtomic(this.eventPath(message), JSON.stringify(message));
  }

  async insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      await writeFileIfAbsentAtomic(this.eventPath(message), JSON.stringify(message));
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
    if (reference.size !== data.byteLength) {
      throw new OrchestrationError({ code: 'INVALID', message: 'attachment size does not match content bytes', retryable: false });
    }
    const actualHash = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    if (reference.contentHash !== actualHash) {
      throw new OrchestrationError({ code: 'INVALID', message: `attachment hash mismatch: expected '${actualHash}'`, retryable: false });
    }
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

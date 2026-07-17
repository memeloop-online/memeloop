import type { AgentDefinition, AgentInstanceMeta } from '../agent/types.js';
import type { AttachmentReference, ChatMessage } from '../conversation/index.js';
import type { IMChannelBinding } from '../im/protocol.js';
import { OrchestrationError } from '../orchestration/errors.js';
import type { ConversationMeta } from '../sync/protocol.js';

import type { FullAgentStorage, GetMessagesOptions, ListConversationsOptions } from './ports.js';

/**
 * TiddlyWiki HTTP storage driver (plan 24.44).
 *
 * Portable: depends only on an injectable `fetch` (browser and Node 18+).
 * Every tiddler write is a compare-and-swap: the driver reads the current
 * ETag, writes with `If-Match`, and retries a bounded number of times on
 * 412/409 before failing with CONFLICT. Blobs are stored inline as base64 up
 * to `maxInlineBlobBytes`; larger payloads are rejected with guidance to use
 * an external BlobStore, keeping tiddlers small.
 *
 * Credentials are materialized per request by a trusted resolver from an
 * opaque handle. Raw credentials never enter this portable driver.
 */

export interface TiddlyWikiCredentialResolver {
  resolveHeaders(handle: string, request: { url: string; method: string }): Promise<Record<string, string>>;
}

export interface TiddlyWikiHttpStorageOptions {
  /** Wiki base URL, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** TiddlyWeb recipe (default `default`). */
  recipe?: string;
  /** Injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Opaque CredentialGrant handle and trusted materialization port. */
  credentialHandle?: string;
  credentialResolver?: TiddlyWikiCredentialResolver;
  /** Maximum inline blob size in bytes (default 256 KiB). */
  maxInlineBlobBytes?: number;
  /** CAS retry budget per write (default 3). */
  maxCasAttempts?: number;
}

const PREFIX = '$:/memeloop';
const DEFAULT_MAX_INLINE_BLOB = 256 * 1024;
const DEFAULT_CAS_ATTEMPTS = 3;

interface Tiddler {
  title: string;
  text?: string;
  type?: string;
  revision?: string;
  fields?: Record<string, string>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function escapeFilterValue(value: string): string {
  return value.replace(/["\\[\]]/g, (character) => `\\${character}`);
}

export class TiddlyWikiHttpStorage implements FullAgentStorage {
  private readonly baseUrl: string;
  private readonly recipe: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentialHandle?: string;
  private readonly credentialResolver?: TiddlyWikiCredentialResolver;
  private readonly maxInlineBlobBytes: number;
  private readonly maxCasAttempts: number;

  constructor(options: TiddlyWikiHttpStorageOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.recipe = options.recipe ?? 'default';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxInlineBlobBytes = options.maxInlineBlobBytes ?? DEFAULT_MAX_INLINE_BLOB;
    this.maxCasAttempts = options.maxCasAttempts ?? DEFAULT_CAS_ATTEMPTS;
    if ((options.credentialHandle === undefined) !== (options.credentialResolver === undefined)) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'credentialHandle and credentialResolver must be provided together',
        retryable: false,
      });
    }
    this.credentialHandle = options.credentialHandle;
    this.credentialResolver = options.credentialResolver;
  }

  private eventTitle(conversationId: string, messageId: string): string {
    return `${PREFIX}/e/${conversationId}/${messageId}`;
  }

  private metaTitle(conversationId: string): string {
    return `${PREFIX}/meta/${conversationId}`;
  }

  private blobTitle(contentHash: string): string {
    return `${PREFIX}/blob/${contentHash}`;
  }

  private definitionTitle(id: string): string {
    return `${PREFIX}/def/${id}`;
  }

  private instanceTitle(id: string): string {
    return `${PREFIX}/inst/${id}`;
  }

  private imTitle(channelId: string, imUserId: string): string {
    return `${PREFIX}/im/${channelId}/${imUserId}`;
  }

  private tiddlerUrl(title: string): string {
    return `${this.baseUrl}/recipes/${encodeURIComponent(this.recipe)}/tiddlers/${encodeURIComponent(title)}`;
  }

  private filterUrl(filter: string): string {
    return `${this.baseUrl}/recipes/${encodeURIComponent(this.recipe)}/tiddlers.json?filter=${encodeURIComponent(filter)}`;
  }

  private async headers(url: string, method: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const credentialHeaders = this.credentialHandle && this.credentialResolver
      ? await this.credentialResolver.resolveHeaders(this.credentialHandle, { url, method })
      : {};
    return {
      'content-type': 'application/json',
      'x-requested-with': 'TiddlyWiki',
      ...credentialHeaders,
      ...extra,
    };
  }

  /** GET a tiddler; returns null on 404. Includes the ETag when the server sends one. */
  private async readTiddler(title: string): Promise<{ tiddler: Tiddler; etag?: string } | null> {
    const url = this.tiddlerUrl(title);
    const response = await this.fetchImpl(url, { headers: await this.headers(url, 'GET') });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new OrchestrationError({ code: 'UNAVAILABLE', message: `tiddler read failed: HTTP ${response.status}`, retryable: true });
    }
    const tiddler = (await response.json()) as Tiddler;
    const etag = response.headers.get('etag') ?? undefined;
    return { tiddler, ...(etag ? { etag } : {}) };
  }

  /** CAS write: If-Match when an ETag is known; bounded retries on 412/409. */
  private async writeTiddler(title: string, build: (current: Tiddler | null) => Tiddler): Promise<void> {
    for (let attempt = 1; attempt <= this.maxCasAttempts; attempt += 1) {
      const current = await this.readTiddler(title);
      if (current && !current.etag) {
        throw new OrchestrationError({ code: 'CONFLICT', message: `tiddler '${title}' has no ETag for a safe update`, retryable: false });
      }
      const next = build(current?.tiddler ?? null);
      const url = this.tiddlerUrl(title);
      const precondition: Record<string, string> = current ? { 'if-match': current.etag! } : { 'if-none-match': '*' };
      const response = await this.fetchImpl(url, {
        method: 'PUT',
        headers: await this.headers(url, 'PUT', precondition),
        body: JSON.stringify(next),
      });
      if (response.ok) return;
      if (response.status === 412 || response.status === 409) {
        if (attempt === this.maxCasAttempts) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `tiddler '${title}' was modified concurrently after ${attempt} CAS attempts`,
            retryable: true,
          });
        }
        continue;
      }
      throw new OrchestrationError({ code: 'UNAVAILABLE', message: `tiddler write failed: HTTP ${response.status}`, retryable: true });
    }
  }

  private async listByPrefix(prefix: string): Promise<Tiddler[]> {
    const filter = `[prefix["${escapeFilterValue(prefix)}"]]`;
    const url = this.filterUrl(filter);
    const response = await this.fetchImpl(url, { headers: await this.headers(url, 'GET') });
    if (!response.ok) {
      throw new OrchestrationError({ code: 'UNAVAILABLE', message: `tiddler list failed: HTTP ${response.status}`, retryable: true });
    }
    return (await response.json()) as Tiddler[];
  }

  private parsePayload(tiddler: Tiddler): unknown {
    return JSON.parse(tiddler.text ?? '{}');
  }

  async listConversations(options: ListConversationsOptions = {}): Promise<ConversationMeta[]> {
    const tiddlers = await this.listByPrefix(`${PREFIX}/meta/`);
    const metas = tiddlers.map((tiddler) => this.parsePayload(tiddler) as ConversationMeta);
    metas.sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0));
    const offset = options.offset ?? 0;
    const limit = options.limit ?? metas.length;
    return metas.slice(offset, offset + limit);
  }

  async getMessages(conversationId: string, _options: GetMessagesOptions = {}): Promise<ChatMessage[]> {
    const tiddlers = await this.listByPrefix(`${PREFIX}/e/${conversationId}/`);
    const messages = tiddlers.map((tiddler) => this.parsePayload(tiddler) as ChatMessage);
    messages.sort((a, b) => (a.lamportClock ?? 0) - (b.lamportClock ?? 0));
    return messages;
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    await this.writeTiddler(this.eventTitle(message.conversationId, message.messageId), () => ({
      title: this.eventTitle(message.conversationId, message.messageId),
      text: JSON.stringify(message),
    }));
  }

  async insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      const title = this.eventTitle(message.conversationId, message.messageId);
      const existing = await this.readTiddler(title);
      if (!existing) {
        await this.writeTiddler(title, () => ({ title, text: JSON.stringify(message) }));
      }
    }
  }

  async getMaxLamportClockForConversation(conversationId: string): Promise<number> {
    const messages = await this.getMessages(conversationId);
    return messages.reduce((max, message) => Math.max(max, message.lamportClock ?? 0), 0);
  }

  async upsertConversationMetadata(meta: ConversationMeta): Promise<void> {
    const title = this.metaTitle(meta.conversationId);
    await this.writeTiddler(title, () => ({ title, text: JSON.stringify(meta) }));
  }

  async getConversationMeta(conversationId: string): Promise<ConversationMeta | null> {
    const result = await this.readTiddler(this.metaTitle(conversationId));
    return result ? this.parsePayload(result.tiddler) as ConversationMeta : null;
  }

  async saveAttachment(reference: AttachmentReference, data: Uint8Array): Promise<void> {
    if (data.byteLength > this.maxInlineBlobBytes) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `blob of ${data.byteLength} bytes exceeds the inline limit ${this.maxInlineBlobBytes}; store it in an external BlobStore and keep the reference`,
        retryable: false,
        details: { maxInlineBlobBytes: this.maxInlineBlobBytes },
      });
    }
    const title = this.blobTitle(reference.contentHash);
    await this.writeTiddler(title, () => ({
      title,
      text: JSON.stringify({ reference, dataBase64: bytesToBase64(data) }),
    }));
  }

  async getAttachment(contentHash: string): Promise<AttachmentReference | null> {
    const result = await this.readTiddler(this.blobTitle(contentHash));
    if (!result) return null;
    return (this.parsePayload(result.tiddler) as { reference: AttachmentReference }).reference;
  }

  async readAttachmentData(contentHash: string): Promise<Uint8Array | null> {
    const result = await this.readTiddler(this.blobTitle(contentHash));
    if (!result) return null;
    return base64ToBytes((this.parsePayload(result.tiddler) as { dataBase64: string }).dataBase64);
  }

  async getAgentDefinition(id: string): Promise<AgentDefinition | null> {
    const result = await this.readTiddler(this.definitionTitle(id));
    return result ? this.parsePayload(result.tiddler) as AgentDefinition : null;
  }

  async saveAgentDefinition(definition: AgentDefinition & { id: string }): Promise<void> {
    const title = this.definitionTitle(definition.id);
    await this.writeTiddler(title, () => ({ title, text: JSON.stringify(definition) }));
  }

  async saveAgentInstance(meta: AgentInstanceMeta): Promise<void> {
    const title = this.instanceTitle(meta.instanceId);
    await this.writeTiddler(title, () => ({ title, text: JSON.stringify(meta) }));
  }

  async getImBinding(channelId: string, imUserId: string): Promise<IMChannelBinding | null> {
    const result = await this.readTiddler(this.imTitle(channelId, imUserId));
    return result ? this.parsePayload(result.tiddler) as IMChannelBinding : null;
  }

  async setImBinding(record: IMChannelBinding): Promise<void> {
    const title = this.imTitle(record.channelId, record.imUserId);
    await this.writeTiddler(title, () => ({ title, text: JSON.stringify(record) }));
  }
}

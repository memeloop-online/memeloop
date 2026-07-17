import type { AgentDefinition, AgentInstanceMeta } from '../agent/types.js';
import type { AttachmentReference, ChatMessage } from '../conversation/index.js';
import type { IMChannelBinding } from '../im/protocol.js';
import type { ConversationMeta } from '../sync/protocol.js';

/**
 * Narrow logical storage ports (plan 24.41).
 *
 * Loop/runtime code depends on these small portable interfaces instead of a
 * monolithic storage facade. Hosts (CLI SQLite, Desktop repositories, browser
 * IndexedDB, remote adapters) implement any combination; binary payloads are
 * `Uint8Array` only, keeping the ports usable in browsers and edge runtimes.
 */

export type ConversationQueryMode = 'metadata-only' | 'full-content' | 'on-demand';

export interface ListConversationsOptions {
  limit?: number;
  offset?: number;
}

export interface GetMessagesOptions {
  mode?: ConversationQueryMode;
}

/** Append-only conversation event log. */
export interface ConversationEventStore {
  listConversations(options?: ListConversationsOptions): Promise<ConversationMeta[]>;
  getMessages(conversationId: string, options?: GetMessagesOptions): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  /** Merge remote/peer events; refreshes per-conversation messageCount. */
  insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void>;
  /** Optional optimization: `SELECT MAX(lamportClock)` instead of scanning. */
  getMaxLamportClockForConversation?(conversationId: string): Promise<number>;
}

/** Conversation directory/metadata rows (sync and peer metadata). */
export interface ConversationDirectoryStore {
  upsertConversationMetadata(meta: ConversationMeta): Promise<void>;
  /** Read the conversation metadata row used to resolve `definitionId`. */
  getConversationMeta(conversationId: string): Promise<ConversationMeta | null>;
}

/** Content-addressed binary storage. Bytes are `Uint8Array` on every path. */
export interface BlobStore {
  getAttachment(contentHash: string): Promise<AttachmentReference | null>;
  saveAttachment(reference: AttachmentReference, data: Uint8Array): Promise<void>;
  /** Read persisted attachment bytes (cross-node blob transfer). */
  readAttachmentData?(contentHash: string): Promise<Uint8Array | null>;
}

/** Agent definition lookup. */
export interface DefinitionStore {
  getAgentDefinition(id: string): Promise<AgentDefinition | null>;
}

/** Agent run/instance state. */
export interface AgentInstanceStore {
  saveAgentInstance(meta: AgentInstanceMeta): Promise<void>;
}

/** IM user-to-conversation binding persistence. */
export interface ImBindingStore {
  getImBinding?(channelId: string, imUserId: string): Promise<IMChannelBinding | null>;
  setImBinding?(record: IMChannelBinding): Promise<void>;
}

/**
 * Convenience composition for hosts that provide every port (the previous
 * `IAgentStorage` shape). New consumers should depend on the narrow port they
 * actually use.
 */
export interface FullAgentStorage extends ConversationEventStore, ConversationDirectoryStore, BlobStore, DefinitionStore, AgentInstanceStore, ImBindingStore {}

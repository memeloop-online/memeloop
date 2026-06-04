import type { AgentDefinition, AgentInstanceMeta, AttachmentReference, ChatMessage, ConversationMeta } from '../protocol/index.js';

import type { ConversationQueryMode, GetMessagesOptions, ListConversationsOptions } from '../types.js';

export interface IAgentStorage {
  listConversations(options?: ListConversationsOptions): Promise<ConversationMeta[]>;
  getMessages(conversationId: string, options?: GetMessagesOptions): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  upsertConversationMetadata(meta: ConversationMeta): Promise<void>;
  insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void>;
  getAttachment(contentHash: string): Promise<AttachmentReference | null>;
  saveAttachment(reference: AttachmentReference, data: Buffer | Uint8Array): Promise<void>;
  readAttachmentData?(contentHash: string): Promise<Uint8Array | null>;
  getAgentDefinition(id: string): Promise<AgentDefinition | null>;
  getMaxLamportClockForConversation?(conversationId: string): Promise<number>;
  saveAgentInstance(meta: AgentInstanceMeta): Promise<void>;
  getConversationMeta(conversationId: string): Promise<ConversationMeta | null>;

  getImBinding?(channelId: string, imUserId: string): Promise<import('../types.js').ImChannelBindingRecord | null>;
  setImBinding?(record: import('../types.js').ImChannelBindingRecord): Promise<void>;
}

export type { ConversationQueryMode, GetMessagesOptions, ListConversationsOptions };

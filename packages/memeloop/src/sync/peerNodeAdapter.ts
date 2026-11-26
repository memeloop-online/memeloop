import type { ConversationEvent, ConversationEventCursor } from '../conversation/index.js';
import type { AttachmentChunk } from '../device-network/types.js';
import type { MessageVersionFrontier, MessageVersionFrontierCursor, MessageVersionFrontierPage } from '../storage/ports.js';
import type { ConversationEventSyncPage, VersionRange } from './protocol.js';

import type { ChatSyncPeer, SyncIoOptions } from './chatSyncEngine.js';

export interface PeerNodeTransport {
  nodeId: string;
  exchangeVersionFrontierPage(
    targetNodeId: string,
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: MessageVersionFrontierCursor | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
    options?: SyncIoOptions,
  ): Promise<{
    remotePage: MessageVersionFrontierPage;
    missingForRemote: VersionRange[];
  }>;
  pullMissingEvents?(
    targetNodeId: string,
    conversationId: string,
    ranges: VersionRange[],
    cursor?: ConversationEventCursor,
    options?: SyncIoOptions,
  ): Promise<ConversationEventSyncPage>;

  /** 从指定节点拉取附件 BLOB（如 `memeloop.storage.getAttachmentBlob`）。 */
  pullAttachmentChunk?(
    targetNodeId: string,
    conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: SyncIoOptions,
  ): Promise<AttachmentChunk | null>;
  pushEvents?(
    targetNodeId: string,
    events: ConversationEvent[],
    options?: SyncIoOptions,
  ): Promise<void>;
  pushAttachmentChunk?(
    targetNodeId: string,
    conversationId: string,
    contentHash: string,
    chunk: AttachmentChunk,
    options?: SyncIoOptions,
  ): Promise<void>;
}

export class PeerNodeSyncAdapter implements ChatSyncPeer {
  public readonly nodeId: string;
  private readonly transport: PeerNodeTransport;

  constructor(nodeId: string, transport: PeerNodeTransport) {
    this.nodeId = nodeId;
    this.transport = transport;
  }

  exchangeVersionFrontierPage(
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: MessageVersionFrontierCursor | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
    options?: SyncIoOptions,
  ) {
    return this.transport.exchangeVersionFrontierPage(
      this.nodeId,
      localFrontiers,
      remoteAfter,
      includeRemotePage,
      conversationIds,
      options,
    );
  }

  pullMissingEvents(
    conversationId: string,
    ranges: VersionRange[],
    cursor?: ConversationEventCursor,
    options?: SyncIoOptions,
  ): Promise<ConversationEventSyncPage> {
    const function_ = this.transport.pullMissingEvents?.bind(this.transport);
    if (!function_) {
      return Promise.reject(new Error('Peer transport does not support event synchronization'));
    }
    return function_(this.nodeId, conversationId, ranges, cursor, options);
  }

  pullAttachmentChunk(
    conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: SyncIoOptions,
  ) {
    const function_ = this.transport.pullAttachmentChunk?.bind(this.transport);
    if (!function_) {
      return Promise.resolve(null);
    }
    return function_(this.nodeId, conversationId, contentHash, offset, maxBytes, options);
  }

  pushEvents(events: ConversationEvent[], options?: SyncIoOptions): Promise<void> {
    const function_ = this.transport.pushEvents?.bind(this.transport);
    if (!function_) return Promise.reject(new Error('Peer transport does not support event push'));
    return function_(this.nodeId, events, options);
  }

  pushAttachmentChunk(
    conversationId: string,
    contentHash: string,
    chunk: AttachmentChunk,
    options?: SyncIoOptions,
  ): Promise<void> {
    const function_ = this.transport.pushAttachmentChunk?.bind(this.transport);
    if (!function_) return Promise.reject(new Error('Peer transport does not support attachment push'));
    return function_(this.nodeId, conversationId, contentHash, chunk, options);
  }
}

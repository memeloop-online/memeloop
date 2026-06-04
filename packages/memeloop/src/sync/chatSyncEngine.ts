import type { AttachmentReference, ChatMessage, ConversationMeta } from '../protocol/index.js';

import type { IAgentStorage } from '../types.js';

export interface ChatSyncPeer {
  nodeId: string;
  /**
   * 取远端当前的 versionVector，并返回对方缺失的会话元数据。
   */
  exchangeVersionVector(localVersion: Record<string, number>): Promise<{
    remoteVersion: Record<string, number>;
    missingForRemote: ConversationMeta[];
  }>;

  /**
   * 将本地缺失的 metadata 从该 peer 拉回来。
   */
  pullMissingMetadata(sinceVersion: Record<string, number>): Promise<ConversationMeta[]>;

  /**
   * 按需拉取消息正文（TidGi / 审查单 Phase 4：消息级同步）。
   * 返回远端有而本地 unknownMessageIds 之外的新消息。
   */
  pullMissingMessages?(conversationId: string, knownMessageIds: string[]): Promise<ChatMessage[]>;

  /**
   * 按 contentHash 拉取附件二进制（与 `ChatMessage.attachments` / `AttachmentRef` 对齐）。
   * 典型实现：对 peer 发 `memeloop.storage.getAttachmentBlob` RPC。
   */
  pullAttachmentBlob?(
    contentHash: string,
  ): Promise<{ data: Uint8Array; filename: string; mimeType: string; size: number } | null>;
}

export interface ChatSyncEngineOptions {
  nodeId: string;
  storage: IAgentStorage;
  peers: () => ChatSyncPeer[];
}

export class ChatSyncEngine {
  private readonly nodeId: string;
  private readonly storage: IAgentStorage;
  private readonly getPeers: () => ChatSyncPeer[];
  private versionVector: Record<string, number> = {};

  constructor(options: ChatSyncEngineOptions) {
    this.nodeId = options.nodeId;
    this.storage = options.storage;
    this.getPeers = options.peers;
    this.versionVector[this.nodeId] = 0;
  }

  /**
   * 在本节点新产生一条消息时调用，增加本节点的 lamportClock。
   */
  public bumpLocalVersion(): void {
    this.versionVector[this.nodeId] = (this.versionVector[this.nodeId] ?? 0) + 1;
  }

  /**
   * 执行一次与所有 peer 的增量同步（metadata 级别），并尽力拉取缺失消息。
   */
  public async syncOnce(): Promise<void> {
    const peers = this.getPeers();
    if (peers.length === 0) return;

    const localVersion = { ...this.versionVector };
    const pulledConversations = new Set<string>();

    for (const peer of peers) {
      const { remoteVersion, missingForRemote } = await peer.exchangeVersionVector(localVersion);

      const missingForLocal = await peer.pullMissingMetadata(this.versionVector);

      for (const meta of missingForLocal) {
        await this.storage.upsertConversationMetadata(meta);
        pulledConversations.add(meta.conversationId);
      }

      for (const [nodeId, clock] of Object.entries(remoteVersion)) {
        const current = this.versionVector[nodeId] ?? 0;
        if (clock > current) {
          this.versionVector[nodeId] = clock;
        }
      }

      if (missingForRemote.length > 0) {
        this.bumpLocalVersion();
      }
    }

    for (const conversationId of pulledConversations) {
      await this.pullMessagesForConversationFromPeers(conversationId, peers);
    }
  }

  /**
   * Anti-entropy：先 syncOnce，再对已知会话逐个向各 peer 拉取缺失消息（参考审查单「定期对账」）。
   */
  public async antiEntropyOnce(): Promise<void> {
    await this.syncOnce();
    const list = await this.storage.listConversations({ limit: 500 });
    const peers = this.getPeers();
    for (const meta of list) {
      await this.pullMessagesForConversationFromPeers(meta.conversationId, peers);
    }
  }

  private async pullMessagesForConversationFromPeers(
    conversationId: string,
    peers: ChatSyncPeer[],
  ): Promise<void> {
    const localMsgs = await this.storage.getMessages(conversationId, { mode: 'full-content' });
    const knownIds = localMsgs.map((m) => m.messageId);

    for (const peer of peers) {
      if (!peer.pullMissingMessages) continue;
      try {
        const incoming = await peer.pullMissingMessages(conversationId, knownIds);
        if (incoming.length > 0) {
          await this.storage.insertMessagesIfAbsent(incoming);
          await this.ensureAttachmentsFromMessages(incoming, peers);
        }
      } catch {
        /* 单 peer 失败不阻塞 */
      }
    }
  }

  /** 从消息元数据收集 `attachments[].contentHash`，对本地缺失 BLOB 的哈希向各 peer 拉取并 `saveAttachment`。 */
  private async ensureAttachmentsFromMessages(
    messages: ChatMessage[],
    peers: ChatSyncPeer[],
  ): Promise<void> {
    const hashes = new Set<string>();
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (a.contentHash) hashes.add(a.contentHash);
      }
    }
    for (const h of hashes) {
      const reference = await this.storage.getAttachment(h);
      if (reference) {
        const reader = this.storage.readAttachmentData;
        if (!reader) continue;
        const bytes = await reader(h);
        if (bytes && bytes.length > 0) continue;
      }

      for (const peer of peers) {
        const pull = peer.pullAttachmentBlob;
        if (!pull) continue;
        try {
          const blob = await pull(h);
          if (blob?.data?.length) {
            const ar: AttachmentReference = {
              contentHash: h,
              filename: blob.filename,
              mimeType: blob.mimeType,
              size: blob.size > 0 ? blob.size : blob.data.length,
            };
            await this.storage.saveAttachment(ar, blob.data);
            break;
          }
        } catch {
          /* try next peer */
        }
      }
    }
  }

  public getVersionVector(): Record<string, number> {
    return { ...this.versionVector };
  }

  public getStorage(): IAgentStorage {
    return this.storage;
  }
}

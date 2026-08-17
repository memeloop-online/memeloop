import type { AttachmentReference, ChatMessage } from '../conversation/index.js';
import { type DeviceSyncStateStore, MemoryDeviceSyncStateStore } from '../device-network/deviceSyncStateStore.js';
import type { ConversationMetadataPage, VersionRange, VersionVector } from './protocol.js';

import type { IAgentStorage } from '../types.js';

export interface ChatSyncPeer {
  nodeId: string;
  /**
   * 取远端当前的 versionVector，并返回对方缺失的会话元数据。
   */
  exchangeVersionVector(localVersion: Record<string, number>): Promise<{
    remoteVersion: Record<string, number>;
    missingForRemote: VersionRange[];
    missingForLocal: VersionRange[];
  }>;

  /**
   * 将本地缺失的 metadata 从该 peer 拉回来。
   */
  pullMissingMetadata(
    sinceVersion: Record<string, number>,
    cursor?: string,
  ): Promise<ConversationMetadataPage>;

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
  stateStore?: DeviceSyncStateStore;
}

export class ChatSyncEngine {
  private readonly nodeId: string;
  private readonly storage: IAgentStorage;
  private readonly getPeers: () => ChatSyncPeer[];
  private readonly stateStore: DeviceSyncStateStore;
  private versionVector: VersionVector = {};
  private loadStatePromise?: Promise<void>;
  private stateMutation: Promise<void> = Promise.resolve();

  constructor(options: ChatSyncEngineOptions) {
    this.nodeId = options.nodeId;
    this.storage = options.storage;
    this.getPeers = options.peers;
    this.stateStore = options.stateStore ?? new MemoryDeviceSyncStateStore();
  }

  /**
   * 在本节点新产生一条消息时调用，增加本节点的 lamportClock。
   */
  public bumpLocalVersion(): Promise<number> {
    let nextClock = 0;
    const mutation = this.stateMutation.then(async () => {
      await this.ensureStateLoaded();
      nextClock = (this.versionVector[this.nodeId] ?? 0) + 1;
      this.versionVector[this.nodeId] = nextClock;
      await this.stateStore.saveVersionVector(this.versionVector);
    });
    this.stateMutation = mutation.catch(() => undefined);
    return mutation.then(() => nextClock);
  }

  /**
   * 执行一次与所有 peer 的增量同步（metadata 级别），并尽力拉取缺失消息。
   */
  public async syncOnce(): Promise<void> {
    await this.ensureStateLoaded();
    await this.stateMutation;
    await this.reconcileVersionVectorFromStorage();
    const peers = this.getPeers();
    if (peers.length === 0) return;

    const pulledConversations = new Set<string>();

    for (const peer of peers) {
      const { remoteVersion } = await peer.exchangeVersionVector({ ...this.versionVector });

      let cursor: string | undefined;
      do {
        const page = await peer.pullMissingMetadata(this.versionVector, cursor);
        for (const meta of page.items) {
          await this.storage.upsertConversationMetadata(meta);
          pulledConversations.add(meta.conversationId);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      for (const [nodeId, clock] of Object.entries(remoteVersion)) {
        const current = this.versionVector[nodeId] ?? 0;
        if (clock > current) this.versionVector[nodeId] = clock;
      }
      await this.stateStore.saveVersionVector(this.versionVector);
    }

    const pageSize = 100;
    let offset = 0;
    for (;;) {
      const conversations = await this.storage.listConversations({ limit: pageSize, offset });
      for (const conversation of conversations) {
        pulledConversations.add(conversation.conversationId);
      }
      if (conversations.length < pageSize) break;
      offset += conversations.length;
    }

    for (const conversationId of pulledConversations) {
      await this.pullMessagesForConversationFromPeers(conversationId, peers);
    }
  }

  /**
   * Anti-entropy 的定期对账入口。`syncOnce` 本身已经遍历全部已知会话，
   * 并在 metadata 对账后向各 peer 拉取缺失消息，因此这里无需第二次重复拉取。
   */
  public async antiEntropyOnce(): Promise<void> {
    await this.syncOnce();
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
        const reader = this.storage.readAttachmentData?.bind(this.storage);
        if (!reader) continue;
        const bytes = await reader(h);
        if (bytes && bytes.length > 0) continue;
      }

      for (const peer of peers) {
        const pull = peer.pullAttachmentBlob?.bind(peer);
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

  public async getVersionVector(): Promise<Record<string, number>> {
    await this.ensureStateLoaded();
    await this.stateMutation;
    return { ...this.versionVector };
  }

  public getStorage(): IAgentStorage {
    return this.storage;
  }

  private ensureStateLoaded(): Promise<void> {
    this.loadStatePromise ??= (async () => {
      const stored = await this.stateStore.loadVersionVector();
      this.versionVector = { ...stored, [this.nodeId]: stored[this.nodeId] ?? 0 };
    })();
    return this.loadStatePromise;
  }

  private async reconcileVersionVectorFromStorage(): Promise<void> {
    const pageSize = 100;
    let offset = 0;
    let changed = false;
    for (;;) {
      const conversations = await this.storage.listConversations({ limit: pageSize, offset });
      for (const conversation of conversations) {
        const current = this.versionVector[conversation.originNodeId] ?? 0;
        if (conversation.originClock > current) {
          this.versionVector[conversation.originNodeId] = conversation.originClock;
          changed = true;
        }
      }
      if (conversations.length < pageSize) break;
      offset += conversations.length;
    }
    if (changed) await this.stateStore.saveVersionVector(this.versionVector);
  }
}

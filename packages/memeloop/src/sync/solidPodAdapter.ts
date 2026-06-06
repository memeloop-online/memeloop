import { createContainerAt, getFile, overwriteFile } from '@inrupt/solid-client';
import type { ChatMessage, ChatRole } from '../protocol/index.js';
import type { ConversationMeta } from './protocol.js';

import type { IAgentStorage, IChatSyncAdapter } from '../types.js';

const MEMELOOP_CONTAINER = 'memeloop';
const BACKUP_FILENAME = 'backup.json';

export interface SolidPodSyncAdapterOptions {
  /** Root URL of the Solid Pod (e.g. https://pod.example.com/username/) */
  podRootUrl: string;
  /** Local storage to push from and optionally merge into when pulling */
  storage: IAgentStorage;
  /** Authenticated fetch (e.g. from @inrupt/solid-client-authn-node). If not provided, start/stop no-op (Pod unavailable). */
  fetch?: typeof globalThis.fetch;
  /** Interval in ms for periodic push. Default 5 minutes. */
  pushIntervalMs?: number;
}

interface BackupPayload {
  versionVector: Record<string, number>;
  conversations: ConversationMeta[];
  messagesByConversation: Record<
    string,
    { messageId: string; conversationId: string; originNodeId: string; timestamp: number; lamportClock: number; role: string; content: string }[]
  >;
  exportedAt: number;
}

/**
 * Sync adapter that backs up local data to a Solid Pod and can pull from Pod as fallback.
 * Pod 不可用时静默跳过 (no throw, no-op when fetch is missing or request fails).
 */
export class SolidPodSyncAdapter implements IChatSyncAdapter {
  private readonly podRootUrl: string;
  private readonly storage: IAgentStorage;
  private readonly fetchFn: typeof globalThis.fetch | undefined;
  private readonly pushIntervalMs: number;
  private timerId: ReturnType<typeof setInterval> | undefined;
  /** 上次成功全量/增量推送完成时间；用于跳过未改动的会话的 `getMessages`。 */
  private lastPushCompletedAt = 0;

  constructor(options: SolidPodSyncAdapterOptions) {
    this.podRootUrl = options.podRootUrl.replace(/\/?$/, '/');
    this.storage = options.storage;
    this.fetchFn = options.fetch;
    this.pushIntervalMs = options.pushIntervalMs ?? 5 * 60 * 1000;
  }

  private get backupFileUrl(): string {
    return `${this.podRootUrl}${MEMELOOP_CONTAINER}/${BACKUP_FILENAME}`;
  }

  private get containerUrl(): string {
    return `${this.podRootUrl}${MEMELOOP_CONTAINER}/`;
  }

  async start(): Promise<void> {
    if (!this.fetchFn) return;
    try {
      const pulled = await this.pullFromPod();
      if (pulled) {
        await this.mergePayloadIntoStorage(pulled);
      }
    } catch {
      /* Pod 不可用时静默跳过 */
    }
    const push = (): void => {
      this.pushToPod().catch(() => {
        /* Pod 不可用时静默跳过 */
      });
    };
    push();
    this.timerId = setInterval(push, this.pushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  /**
   * Push local conversations and messages to the Pod. Silently skips on failure.
   */
  async pushToPod(): Promise<void> {
    if (!this.fetchFn) return;
    try {
      const conversations = await this.storage.listConversations({});
      const versionVector: Record<string, number> = {};
      const messagesByConversation: BackupPayload['messagesByConversation'] = {};
      const previous = this.lastPushCompletedAt > 0 ? await this.pullFromPod().catch(() => null) : null;

      for (const meta of conversations) {
        const cid = meta.conversationId;
        const unchanged = previous &&
          typeof meta.lastMessageTimestamp === 'number' &&
          meta.lastMessageTimestamp <= this.lastPushCompletedAt &&
          Array.isArray(previous.messagesByConversation[cid]);

        let messages: ChatMessage[];
        if (unchanged) {
          const previousRows = previous.messagesByConversation[cid];
          messages = previousRows.map((m) => ({
            messageId: m.messageId,
            conversationId: m.conversationId ?? cid,
            originNodeId: m.originNodeId,
            timestamp: m.timestamp,
            lamportClock: m.lamportClock,
            role: m.role as ChatMessage['role'],
            content: m.content,
          }));
        } else {
          messages = await this.storage.getMessages(cid, { mode: 'full-content' });
        }

        messagesByConversation[cid] = messages.map((m) => ({
          messageId: m.messageId,
          conversationId: m.conversationId,
          originNodeId: m.originNodeId,
          timestamp: m.timestamp,
          lamportClock: m.lamportClock,
          role: m.role,
          content: m.content,
        }));
        const key = meta.originNodeId;
        const last = messages[messages.length - 1];
        if (last && (versionVector[key] == null || last.lamportClock > versionVector[key])) {
          versionVector[key] = last.lamportClock;
        }
      }

      const payload: BackupPayload = {
        versionVector,
        conversations,
        messagesByConversation,
        exportedAt: Date.now(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 0)], { type: 'application/json' });

      try {
        await overwriteFile(this.backupFileUrl, blob, { fetch: this.fetchFn });
      } catch {
        await createContainerAt(this.containerUrl, { fetch: this.fetchFn });
        await overwriteFile(this.backupFileUrl, blob, { fetch: this.fetchFn });
      }
      this.lastPushCompletedAt = payload.exportedAt;
    } catch {
      /* Pod 不可用时静默跳过 */
    }
  }

  /**
   * Pull backup from Pod and return parsed payload. Returns null when Pod unavailable or not found.
   */
  async pullFromPod(): Promise<BackupPayload | null> {
    if (!this.fetchFn) return null;
    try {
      const file = await getFile(this.backupFileUrl, { fetch: this.fetchFn });
      const text = await file.text();
      return JSON.parse(text) as BackupPayload;
    } catch {
      return null;
    }
  }

  /**
   * 将 Pod 备份合并进本地 storage（metadata upsert + 消息 INSERT OR IGNORE）。
   */
  async mergePayloadIntoStorage(payload: BackupPayload): Promise<void> {
    for (const meta of payload.conversations) {
      await this.storage.upsertConversationMetadata(meta);
    }
    const allMessages: ChatMessage[] = [];
    for (const [cid, msgs] of Object.entries(payload.messagesByConversation)) {
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        const role = normalizeBackupRole(m.role);
        allMessages.push({
          messageId: m.messageId,
          conversationId: m.conversationId ?? cid,
          originNodeId: m.originNodeId,
          timestamp: m.timestamp,
          lamportClock: m.lamportClock,
          role,
          content: m.content,
        });
      }
    }
    if (allMessages.length > 0) {
      await this.storage.insertMessagesIfAbsent(allMessages);
    }
  }
}

function normalizeBackupRole(role: string): ChatRole {
  if (role === 'assistant' || role === 'tool') return role;
  return 'user';
}

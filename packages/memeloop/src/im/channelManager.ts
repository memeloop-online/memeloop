import type { IMChannelBinding } from "./protocol.js";

import type { IIMAdapter, ImAgentDriver, ImInboundMessage } from "./interface.js";

/**
 * 管理 IM 用户与会话的绑定；可选 `storage` 使用 IAgentStorage 的 IM 绑定持久化。
 */
export class IMChannelManager {
  private readonly bindings = new Map<string, IMChannelBinding>();

  constructor(
    private readonly storage?: {
      getImBinding?(c: string, u: string): Promise<IMChannelBinding | null>;
      setImBinding?(r: IMChannelBinding): Promise<void>;
    },
  ) {}

  private key(channelId: string, imUserId: string): string {
    return `${channelId}::${imUserId}`;
  }

  async getBinding(channelId: string, imUserId: string): Promise<IMChannelBinding | undefined> {
    const k = this.key(channelId, imUserId);
    if (this.storage?.getImBinding) {
      const row = await this.storage.getImBinding(channelId, imUserId);
      if (row) {
        this.bindings.set(k, row);
        return row;
      }
    }
    return this.bindings.get(k);
  }

  async setBinding(record: IMChannelBinding): Promise<void> {
    this.bindings.set(this.key(record.channelId, record.imUserId), record);
    if (this.storage?.setImBinding) {
      await this.storage.setImBinding(record);
    }
  }

  /**
   * 处理入站文本：无 binding 时创建会话并发送首条用户消息。
   */
  async dispatchInbound(
    message: ImInboundMessage,
    driver: ImAgentDriver,
    options: { defaultDefinitionId: string },
  ): Promise<{ conversationId: string }> {
    const existing = await this.getBinding(message.channelId, message.imUserId);
    if (existing) {
      await driver.sendMessage({
        conversationId: existing.activeConversationId,
        message: message.text,
      });
      return { conversationId: existing.activeConversationId };
    }
    const definitionId = options.defaultDefinitionId;
    const { conversationId } = await driver.createAgent({
      definitionId,
      initialMessage: message.text,
    });
    await this.setBinding({
      channelId: message.channelId,
      imUserId: message.imUserId,
      activeConversationId: conversationId,
      createdAt: Date.now(),
      defaultDefinitionId: definitionId,
    });
    return { conversationId };
  }

  async switchConversation(
    channelId: string,
    imUserId: string,
    conversationId: string,
  ): Promise<void> {
    const current = await this.getBinding(channelId, imUserId);
    if (current) {
      await this.setBinding({ ...current, activeConversationId: conversationId });
    } else {
      await this.setBinding({
        channelId,
        imUserId,
        activeConversationId: conversationId,
        createdAt: Date.now(),
      });
    }
  }
}

export function pickAdapter(adapters: IIMAdapter[], platform: string): IIMAdapter | undefined {
  return adapters.find((a) => a.platform === platform);
}

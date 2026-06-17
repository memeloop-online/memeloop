import type { MemeLoopRuntime } from "../runtime.js";
import type { IAgentStorage } from "../storage/interface.js";

import type { IMChannelManager } from "./channelManager.js";
import type { ImAgentDriver } from "./interface.js";

export interface ImSlashCommandContext {
  rawText: string;
  channelId: string;
  imUserId: string;
  manager: IMChannelManager;
  storage: IAgentStorage;
  driver: ImAgentDriver;
  runtime: MemeLoopRuntime;
  defaultDefinitionId: string;
}

/**
 * Plan §20.6.4 — parse `/list`, `/switch`, `/new`, `/agent`, `/status`, `/cancel` locally (no LLM).
 */
export async function tryHandleImSlashCommand(context: ImSlashCommandContext): Promise<{
  handled: boolean;
  messages: string[];
}> {
  const t = context.rawText.trim();
  if (!t.startsWith("/") || t.startsWith("//") || t.length < 2) {
    return { handled: false, messages: [] };
  }
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).join(" ").trim();

  const binding = await context.manager.getBinding(context.channelId, context.imUserId);
  const ok = (lines: string[]) => ({ handled: true as const, messages: lines });

  if (cmd === "list") {
    const list = await context.storage.listConversations({ limit: 50 });
    if (list.length === 0) return ok(["（暂无会话）"]);
    const body = list.map(
      (c, index) =>
        `${index + 1}. ${c.title || c.conversationId} — ${c.conversationId.slice(0, 14)}…`,
    );
    return ok(["可切换会话：", ...body.map((l) => `• ${l}`)]);
  }

  if (cmd === "switch") {
    if (!binding) return ok(["当前无绑定会话，先用 /new 创建。"]);
    const list = await context.storage.listConversations({ limit: 50 });
    const argument = rest.trim();
    if (!argument) return ok(["用法：/switch <编号或 conversationId>"]);
    const n = parseInt(argument, 10);
    let targetId: string | undefined;
    if (!Number.isNaN(n) && n >= 1 && n <= list.length) {
      targetId = list[n - 1]?.conversationId;
    } else {
      targetId = list.find(
        (c) => c.conversationId === argument || c.conversationId.includes(argument),
      )?.conversationId;
    }
    if (!targetId) return ok([`未找到会话：${argument}`]);
    await context.manager.switchConversation(context.channelId, context.imUserId, targetId);
    return ok([`已切换到：${targetId}`]);
  }

  if (cmd === "new" || cmd === "agent") {
    const definitionId = rest || context.defaultDefinitionId;
    const { conversationId } = await context.driver.createAgent({ definitionId });
    await context.manager.setBinding({
      channelId: context.channelId,
      imUserId: context.imUserId,
      activeConversationId: conversationId,
      createdAt: Date.now(),
      defaultDefinitionId: definitionId,
    });
    return ok([`已新建并绑定会话。\nID：\`${conversationId}\`\n发送消息即可开始。`]);
  }

  if (cmd === "status") {
    if (!binding) return ok(["无活跃 IM 绑定。"]);
    const meta = await context.storage.getConversationMeta(binding.activeConversationId);
    return ok([
      `会话：${binding.activeConversationId}`,
      `定义：${meta?.definitionId ?? "?"}`,
      `消息数：${meta?.messageCount ?? "?"}`,
    ]);
  }

  if (cmd === "cancel") {
    if (!binding) return ok(["无会话可取消。"]);
    await context.runtime.cancelAgent(binding.activeConversationId);
    return ok(["已请求取消当前任务。"]);
  }

  return { handled: false, messages: [] };
}

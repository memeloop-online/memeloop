import { z } from "zod";

import type { IMChannelManager } from "../../im/channelManager.js";
import type { MemeLoopRuntime } from "../../runtime.js";
import type { IToolRegistry } from "../../types.js";
import type { BuiltinToolContext } from "./types.js";

import { registerToolParameterSchema } from "../schemaRegistry.js";

export const IM_SESSION_TOOL_IDS = [
  "im.listConversations",
  "im.switchConversation",
  "im.newConversation",
  "im.summarizeHistory",
] as const;

const listSchema = z.object({});

const switchSchema = z.object({
  conversationId: z.string().min(1),
});

const newSchema = z.object({
  definitionId: z.string().min(1).optional(),
});

const summarizeSchema = z.object({
  maxMessages: z.number().int().positive().max(200).optional(),
});

export interface ImSessionBuiltinRegistration {
  imChannelManager: IMChannelManager;
  getMemeLoopRuntime: () => MemeLoopRuntime;
}

function error(message: string): { error: string } {
  return { error: message };
}

async function requireImSource(
  context: BuiltinToolContext,
  conversationId: string,
): Promise<{ channelId: string; imUserId: string; platform: string } | { error: string }> {
  const meta = await context.storage.getConversationMeta(conversationId);
  const sc = meta?.sourceChannel;
  if (!sc) {
    return { error: "im_tools_only_in_im_session" };
  }
  return { channelId: sc.channelId, imUserId: sc.imUserId, platform: sc.platform };
}

export async function imListConversationsImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
  _reg: ImSessionBuiltinRegistration,
): Promise<{ result: string } | { error: string }> {
  const parsed = listSchema.safeParse(arguments_);
  if (!parsed.success) return error("invalid_args");
  const cid = context.activeToolConversationId;
  if (!cid) return error("no_active_conversation");
  const source = await requireImSource(context, cid);
  if ("error" in source) return source;
  const all = await context.storage.listConversations({});
  if (all.length === 0) return { result: "（暂无会话）" };
  const sorted = [...all].sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
  const lines = sorted.map((m, index) => {
    const title = m.title || m.conversationId;
    const t = new Date(m.lastMessageTimestamp).toISOString();
    return `${index + 1}. ${title}\n   id: ${m.conversationId}\n   def: ${m.definitionId} | ${t}`;
  });
  return { result: `可切换的会话：\n${lines.join("\n")}` };
}

export async function imSwitchConversationImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
  reg: ImSessionBuiltinRegistration,
): Promise<{ result: string } | { error: string }> {
  const parsed = switchSchema.safeParse(arguments_);
  if (!parsed.success) return error("invalid_args");
  const cid = context.activeToolConversationId;
  if (!cid) return error("no_active_conversation");
  const source = await requireImSource(context, cid);
  if ("error" in source) return source;
  await reg.imChannelManager.switchConversation(
    source.channelId,
    source.imUserId,
    parsed.data.conversationId,
  );
  return { result: `已切换到会话：${parsed.data.conversationId}` };
}

export async function imNewConversationImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
  reg: ImSessionBuiltinRegistration,
): Promise<{ result: string } | { error: string }> {
  const parsed = newSchema.safeParse(arguments_);
  if (!parsed.success) return error("invalid_args");
  const cid = context.activeToolConversationId;
  if (!cid) return error("no_active_conversation");
  const source = await requireImSource(context, cid);
  if ("error" in source) return source;
  const current = await reg.imChannelManager.getBinding(source.channelId, source.imUserId);
  const definitionId =
    parsed.data.definitionId?.trim() ||
    current?.defaultDefinitionId ||
    "memeloop:general-assistant";
  const rt = reg.getMemeLoopRuntime();
  const { conversationId } = await rt.createAgent({ definitionId, initialMessage: "" });
  await reg.imChannelManager.setBinding({
    channelId: source.channelId,
    imUserId: source.imUserId,
    activeConversationId: conversationId,
    createdAt: Date.now(),
    defaultDefinitionId: definitionId,
  });
  const meta = await context.storage.getConversationMeta(conversationId);
  if (meta) {
    await context.storage.upsertConversationMetadata({
      ...meta,
      sourceChannel: {
        channelId: source.channelId,
        platform: source.platform,
        imUserId: source.imUserId,
      },
    });
  }
  return {
    result: `已新建并切换到会话：${conversationId}\ndefinition: ${definitionId}\n请让用户发送下一条消息以开始对话。`,
  };
}

export async function imSummarizeHistoryImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
  _reg: ImSessionBuiltinRegistration,
): Promise<{ result: string } | { error: string }> {
  const parsed = summarizeSchema.safeParse(arguments_);
  if (!parsed.success) return error("invalid_args");
  const cid = context.activeToolConversationId;
  if (!cid) return error("no_active_conversation");
  const source = await requireImSource(context, cid);
  if ("error" in source) return source;
  void source;
  const max = parsed.data.maxMessages ?? 40;
  const msgs = await context.storage.getMessages(cid, { mode: "full-content" });
  const tail = msgs.slice(-max);
  if (tail.length === 0) return { result: "（当前会话尚无消息）" };
  const lines = tail.map(
    (m) => `[${m.role}] ${m.content.slice(0, 2000)}${m.content.length > 2000 ? "…" : ""}`,
  );
  return {
    result: `最近 ${tail.length} 条消息摘要（供 IM 上下文）：\n${lines.join("\n---\n")}`,
  };
}

/**
 * 注册 IM 会话专用工具（需节点传入 `imChannelManager` 与 `getMemeLoopRuntime`）。
 */
export function registerImSessionBuiltinTools(
  registry: IToolRegistry,
  context: BuiltinToolContext,
  reg: ImSessionBuiltinRegistration,
): void {
  const bound =
    (function_: typeof imListConversationsImpl) => (arguments_: Record<string, unknown>) =>
      function_(arguments_, context, reg);

  registry.registerTool("im.listConversations", bound(imListConversationsImpl));
  registry.registerTool("im.switchConversation", bound(imSwitchConversationImpl));
  registry.registerTool("im.newConversation", bound(imNewConversationImpl));
  registry.registerTool("im.summarizeHistory", bound(imSummarizeHistoryImpl));

  registerToolParameterSchema("im.listConversations", listSchema, {
    displayName: "IM: list conversations",
    description: "List conversations the user can switch to (IM sessions only).",
  });
  registerToolParameterSchema("im.switchConversation", switchSchema, {
    displayName: "IM: switch conversation",
    description: "Switch this IM user binding to another conversationId.",
  });
  registerToolParameterSchema("im.newConversation", newSchema, {
    displayName: "IM: new conversation",
    description: "Create a new agent conversation and bind this IM user to it.",
  });
  registerToolParameterSchema("im.summarizeHistory", summarizeSchema, {
    displayName: "IM: summarize history",
    description: "Return a plain-text digest of recent messages in the current conversation.",
  });
}

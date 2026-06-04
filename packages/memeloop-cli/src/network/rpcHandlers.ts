/**
 * JSON-RPC 2.0 handlers: agent.*, terminal.*, knowledge.*, chat.*, file.*, mcp.*, auth.*, wiki.*
 */

import type { AgentDefinition, ChatMessage, ConversationMeta, WikiInfo } from "../../../memeloop/src/protocol/index.js";

import type { MemeLoopRuntime } from "memeloop";
import { resolveQuestionAnswer } from "memeloop";
import { resolveApproval } from "memeloop";
import type { IAgentStorage } from "memeloop";
import type { ITerminalSessionManager } from "../terminal/index.js";
import {
  prepareTerminalSessionStorage,
  wireTerminalOutputToStorage,
} from "../terminal/sessionStorage";
import { createThrottledTerminalOutputNotify } from "../terminal/throttleOutputNotify.js";
import {
  normalizeTerminalCommandRequest,
  runTerminalGetOutput,
  runTerminalSignal,
  runTerminalStart,
} from "../tools/terminal.js";
import type { TerminalOutputChunk } from "../terminal/types.js";
import type { IWikiManager } from "../knowledge/wikiManager.js";
import type { ImChannelYaml } from "../config";

function maxTimestampPerOrigin(metas: ConversationMeta[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of metas) {
    const t = typeof c.lastMessageTimestamp === "number" ? c.lastMessageTimestamp : 0;
    m[c.originNodeId] = Math.max(m[c.originNodeId] ?? 0, t);
  }
  return m;
}

export interface McpServerInfo {
  name: string;
  command: string;
  args?: string[];
}

/** memeloop.auth.confirmPin：连续失败 3 次后锁定 5 分钟（与方案 v8 一致）。 */
const PIN_CONFIRM_MAX_FAILS = 3;
const PIN_CONFIRM_LOCK_MS = 5 * 60 * 1000;

export interface RpcHandlerContext {
  runtime: MemeLoopRuntime;
  storage: IAgentStorage;
  terminalManager?: ITerminalSessionManager;
  wikiManager?: IWikiManager;
  toolRegistry?: { listTools(): string[] };
  nodeId: string;
  /** Local MCP server configs for memeloop.mcp.listServers. */
  mcpServers?: McpServerInfo[];
  /** memeloop.im.* 使用的 YAML 配置（不含明文 token 输出） */
  imChannels?: ImChannelYaml[];
  /** memeloop.agent.getDefinitions */
  agentDefinitions?: AgentDefinition[];
  /** memeloop.file.* 根目录（与 CLI fileBaseDir 一致） */
  fileBaseDir?: string;
  /** 可选通知发送器（JSON-RPC notification）。 */
  notify?: (method: string, params: unknown) => void;
  /** 由 createNodeServer 每 WebSocket 连接注入；单测可省略（由 confirmPin 内懒创建）。 */
  pinConfirmState?: { consecutiveFails: number; lockedUntil: number };
  /** 可选：校验 PIN 确认码（用于 LAN 配对流程）。 */
  verifyPinCode?: (confirmCode: string) => Promise<boolean>;
}

function getOrCreatePinConfirmState(context: RpcHandlerContext): {
  consecutiveFails: number;
  lockedUntil: number;
} {
  if (!context.pinConfirmState) {
    context.pinConfirmState = { consecutiveFails: 0, lockedUntil: 0 };
  }
  return context.pinConfirmState;
}

function decodeJwtUserId(jwt: string): string | null {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as {
      userId?: unknown;
      sub?: unknown;
    };
    if (typeof payload.userId === "string" && payload.userId.trim()) return payload.userId;
    if (typeof payload.sub === "string" && payload.sub.trim()) return payload.sub;
    return null;
  } catch {
    return null;
  }
}

export async function handleRpc(
  context: RpcHandlerContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const { runtime, storage, terminalManager, wikiManager } = context;

  if (method === "memeloop.auth.handshake") {
    return { ok: true, nodeId: context.nodeId };
  }
  if (method === "memeloop.auth.hello") {
    const p = params as { nodeId?: string; capabilities?: Record<string, unknown> };
    const nodeId =
      typeof p?.nodeId === "string" && p.nodeId.trim() ? p.nodeId.trim() : context.nodeId;
    return { ok: true, nodeId, receivedAt: Date.now() };
  }
  if (method === "memeloop.auth.confirmPin") {
    const p = params as { confirmCode?: string };
    const confirmCode = typeof p?.confirmCode === "string" ? p.confirmCode.trim() : "";
    if (!confirmCode) return { ok: false, reason: "invalid_confirm_code" };
    if (!context.verifyPinCode) {
      return { ok: false, reason: "pin_verifier_not_configured" };
    }
    const st = getOrCreatePinConfirmState(context);
    const now = Date.now();
    if (now < st.lockedUntil) {
      return {
        ok: false,
        reason: "pin_rate_limited",
        retryAfterMs: st.lockedUntil - now,
      };
    }
    const ok = await context.verifyPinCode(confirmCode);
    if (ok) {
      st.consecutiveFails = 0;
      st.lockedUntil = 0;
      return { ok: true };
    }
    st.consecutiveFails += 1;
    if (st.consecutiveFails >= PIN_CONFIRM_MAX_FAILS) {
      st.lockedUntil = now + PIN_CONFIRM_LOCK_MS;
    }
    return { ok: false, reason: "pin_mismatch" };
  }
  if (method === "memeloop.auth.exchangeJwt") {
    const p = params as { localJwt?: string; remoteJwt?: string };
    const localUserId = decodeJwtUserId(typeof p?.localJwt === "string" ? p.localJwt : "");
    const remoteUserId = decodeJwtUserId(typeof p?.remoteJwt === "string" ? p.remoteJwt : "");
    if (!localUserId || !remoteUserId) return { ok: false };
    if (localUserId !== remoteUserId) return { ok: false };
    return { ok: true, matchedUserId: localUserId };
  }

  if (method === "memeloop.im.listChannels") {
    const channels = (context.imChannels ?? []).map((ch) => ({
      channelId: ch.channelId,
      platform: ch.platform,
      defaultDefinitionId: ch.defaultDefinitionId,
      hasBotToken: Boolean(ch.botToken?.trim()),
      hasWebhookSecret: Boolean(ch.webhookSecret?.trim()),
      hasDiscordPublicKey: Boolean(ch.discordPublicKey?.trim()),
      hasLarkEncryptKey: Boolean(ch.larkEncryptKey?.trim()),
      hasWecomEncodingAesKey: Boolean(ch.wecomEncodingAesKey?.trim()),
    }));
    return { channels };
  }

  if (method === "memeloop.im.getChannel") {
    const p = params as { channelId?: string };
    const id = typeof p?.channelId === "string" ? p.channelId.trim() : "";
    const ch = (context.imChannels ?? []).find((c) => c.channelId === id);
    if (!ch) {
      return { channel: null };
    }
    return {
      channel: {
        channelId: ch.channelId,
        platform: ch.platform,
        defaultDefinitionId: ch.defaultDefinitionId,
        hasBotToken: Boolean(ch.botToken?.trim()),
        hasWebhookSecret: Boolean(ch.webhookSecret?.trim()),
        hasDiscordPublicKey: Boolean(ch.discordPublicKey?.trim()),
        hasLarkEncryptKey: Boolean(ch.larkEncryptKey?.trim()),
        hasWecomEncodingAesKey: Boolean(ch.wecomEncodingAesKey?.trim()),
      },
    };
  }

  if (method === "memeloop.agent.create") {
    const p = params as { definitionId: string; initialMessage?: string };
    return runtime.createAgent({
      definitionId: p.definitionId,
      initialMessage: p.initialMessage,
    });
  }
  if (method === "memeloop.agent.send") {
    const p = params as { conversationId: string; message: string };
    await runtime.sendMessage({ conversationId: p.conversationId, message: p.message });
    return { ok: true };
  }
  if (method === "memeloop.agent.cancel") {
    const p = params as { conversationId: string };
    await runtime.cancelAgent(p.conversationId);
    return { ok: true };
  }
  if (method === "memeloop.agent.list") {
    const list = await storage.listConversations({ limit: 100 });
    return { conversations: list };
  }
  if (method === "memeloop.agent.getDefinitions") {
    return { definitions: context.agentDefinitions ?? [] };
  }
  if (method === "memeloop.agent.resolveQuestion") {
    const p = params as { questionId?: string; answer?: string };
    const questionId = typeof p?.questionId === "string" ? p.questionId.trim() : "";
    const answer = typeof p?.answer === "string" ? p.answer : "";
    if (!questionId || !answer) {
      return { ok: false };
    }
    const ok = resolveQuestionAnswer(questionId, answer);
    return { ok };
  }
  if (method === "memeloop.agent.resolveApproval") {
    const p = params as { approvalId?: string; decision?: "allow" | "deny" };
    const approvalId = typeof p?.approvalId === "string" ? p.approvalId.trim() : "";
    const decision = p?.decision === "allow" ? "allow" : "deny";
    if (!approvalId) {
      return { ok: false };
    }
    resolveApproval(approvalId, decision);
    return { ok: true };
  }

  if (terminalManager) {
    if (method === "memeloop.terminal.execute") {
      const p = params as {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        timeoutMs?: number | string;
        cwd?: string;
        waitMode?: "until-exit" | "until-timeout" | "detached";
        maxWaitMs?: number | string;
        stream?: boolean;
      };
      const timeoutMsRaw = p.timeoutMs ?? 60_000;
      const timeoutMs0 =
        typeof timeoutMsRaw === "number"
          ? timeoutMsRaw
          : typeof timeoutMsRaw === "string"
            ? Number(timeoutMsRaw)
            : 60_000;
      const timeoutMs = Number.isFinite(timeoutMs0) && timeoutMs0 > 0 ? timeoutMs0 : 60_000;
      const cwd = p.cwd;
      const waitMode = p.waitMode ?? "until-timeout";
      const maxWaitMsRaw = p.maxWaitMs ?? timeoutMs;
      const maxWaitMs0 =
        typeof maxWaitMsRaw === "number"
          ? maxWaitMsRaw
          : typeof maxWaitMsRaw === "string"
            ? Number(maxWaitMsRaw)
            : timeoutMs;
      const maxWaitMs = Number.isFinite(maxWaitMs0) && maxWaitMs0 > 0 ? maxWaitMs0 : timeoutMs;
      const stream = p.stream === true;
      const normalized = normalizeTerminalCommandRequest(
        (params as Record<string, unknown>) ?? {},
        "terminal.execute",
      );
      if (!normalized.ok) {
        return { error: normalized.error };
      }
      const { command: cmd, args: cmdArgs, env } = normalized.value;

      const { sessionId } = await terminalManager.start({
        command: cmd,
        args: cmdArgs,
        cwd,
        env,
        promptPatterns: [{ name: "generic", regex: /[?%]\s*$|>\s*$|:\s*$/m }],
        idleTimeoutMs: Math.min(15_000, timeoutMs),
      });

      const originNodeId = context.nodeId;
      const { terminalCid } = await prepareTerminalSessionStorage(storage, originNodeId, sessionId);
      const throttledNotify = context.notify
        ? createThrottledTerminalOutputNotify(
            (method, params) => context.notify?.(method, params),
            1000,
          )
        : undefined;
      const { persistQueue, unsubOutput } = wireTerminalOutputToStorage(
        storage,
        originNodeId,
        terminalCid,
        sessionId,
        terminalManager,
        throttledNotify ? (chunk) => throttledNotify.push(chunk) : undefined,
      );
      const unsubPrompt = context.notify
        ? terminalManager.onInteractionPrompt((prompt) => {
            if (prompt.sessionId !== sessionId) return;
            context.notify?.("memeloop.terminal.interaction.prompt", prompt);
          })
        : undefined;
      const unsubStatus = terminalManager.onStatusUpdate((status) => {
        if (status.sessionId !== sessionId) return;
        context.notify?.("memeloop.terminal.status.update", status);
        if (status.status !== "running") {
          throttledNotify?.flush();
          unsubOutput();
          unsubPrompt?.();
          unsubStatus();
        }
      });
      const info = terminalManager.get(sessionId);
      if (info?.status !== "running") {
        throttledNotify?.flush();
        unsubOutput();
        unsubPrompt?.();
        unsubStatus();
      }
      if (waitMode === "detached") {
        return {
          sessionId,
          status: "running",
          exitCode: null,
          done: false,
          timedOut: false,
          nextSeq: 1,
          chunks: [],
        };
      }
      const follow = await terminalManager.follow(sessionId, {
        fromSeq: 1,
        untilExit: waitMode === "until-exit",
        maxWaitMs,
      });
      await persistQueue;
      const timedOut = waitMode === "until-timeout" && !follow.done;
      if (timedOut) await terminalManager.cancel(sessionId);
      const stdout = follow.chunks
        .filter((c) => c.stream === "stdout")
        .map((c) => c.data)
        .join("");
      const stderr = follow.chunks
        .filter((c) => c.stream === "stderr")
        .map((c) => c.data)
        .join("");
      return {
        sessionId,
        status: follow.status,
        exitCode: follow.exitCode,
        done: follow.done,
        nextSeq: follow.nextSeq,
        chunks: stream ? follow.chunks : [],
        timedOut,
        stdout,
        stderr,
        output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
      };
    }

    if (method === "memeloop.terminal.list") {
      return { sessions: await terminalManager.list() };
    }
    if (method === "memeloop.terminal.respond") {
      const p = params as { sessionId: string; input: string };
      await terminalManager.respond(p.sessionId, p.input);
      return { ok: true };
    }
    if (method === "memeloop.terminal.cancel") {
      const p = params as { sessionId: string };
      await terminalManager.cancel(p.sessionId);
      const info = terminalManager.get(p.sessionId);
      return { ok: true, sessionId: p.sessionId, finalStatus: info?.status ?? "killed" };
    }
    if (method === "memeloop.terminal.follow") {
      const p = params as {
        sessionId: string;
        fromSeq?: number;
        untilExit?: boolean;
        maxWaitMs?: number;
      };
      return terminalManager.follow(p.sessionId, {
        fromSeq: p.fromSeq ?? 1,
        untilExit: p.untilExit === true,
        maxWaitMs: p.maxWaitMs ?? 30_000,
      });
    }
    if (method === "memeloop.terminal.start") {
      return runTerminalStart(params as Record<string, unknown>, terminalManager, {
        storage,
        nodeId: context.nodeId,
        terminalWsNotify: context.notify,
      });
    }
    if (method === "memeloop.terminal.signal") {
      return runTerminalSignal(params as Record<string, unknown>, terminalManager);
    }
    if (method === "memeloop.terminal.getOutput") {
      return runTerminalGetOutput(params as Record<string, unknown>, terminalManager);
    }
  }

  if (wikiManager) {
    if (method === "memeloop.knowledge.query" || method === "memeloop.knowledge.list") {
      const p = (params as { wikiId?: string; query?: string }) ?? {};
      const wikiId = p.wikiId ?? "default";
      const tiddlers = p.query
        ? await wikiManager.search(wikiId, p.query)
        : await wikiManager.listTiddlers(wikiId);
      return { tiddlers };
    }
    if (method === "memeloop.knowledge.get") {
      const p = params as { wikiId?: string; title: string };
      const tiddler = await wikiManager.getTiddler(p.wikiId ?? "default", p.title);
      return { tiddler: tiddler ?? null };
    }
    if (method === "memeloop.knowledge.write") {
      const p = params as {
        wikiId?: string;
        title: string;
        text?: string;
        type?: string;
        tags?: string | string[];
      };
      const tags =
        p.tags == null
          ? undefined
          : Array.isArray(p.tags)
            ? p.tags
            : p.tags.split(/\s+/).filter(Boolean);
      await wikiManager.setTiddler(p.wikiId ?? "default", {
        title: p.title,
        text: p.text ?? "",
        type: p.type ?? "text/vnd.tiddlywiki",
        ...(tags?.length ? { tags } : {}),
      });
      return { ok: true };
    }
  }

  if (method === "memeloop.wiki.listWikis") {
    const wikis: WikiInfo[] = wikiManager ? [{ wikiId: "default", title: "default" }] : [];
    return { wikis };
  }
  if (method === "memeloop.node.getInfo") {
    const tools = context.toolRegistry?.listTools?.() ?? [];
    const imChannelIds = (context.imChannels ?? []).map((c) => c.channelId);
    const wikis: WikiInfo[] = wikiManager ? [{ wikiId: "default", title: "default" }] : [];
    return {
      nodeId: context.nodeId,
      capabilities: {
        tools,
        hasWiki: !!wikiManager,
        mcpServers: (context.mcpServers ?? []).map((s) => s.name),
        imChannels: imChannelIds,
        wikis,
      },
    };
  }

  if (method === "memeloop.mcp.listServers") {
    return { servers: (context.mcpServers ?? []).map((s) => ({ name: s.name })) };
  }
  if (method === "memeloop.mcp.listTools") {
    try {
      const { listAllMcpTools } = await import("../mcp/localMcpClient.js");
      const tools = await listAllMcpTools(context.mcpServers ?? []);
      return { tools };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `MCP listTools failed: ${message}`, tools: [] as unknown[] };
    }
  }
  if (context.fileBaseDir) {
    const root = context.fileBaseDir;
    if (method === "memeloop.file.read") {
      const { runFileReadRpc } = await import("../tools/fileSystem.js");
      return runFileReadRpc((params as Record<string, unknown>) ?? {}, root);
    }
    if (method === "memeloop.file.write") {
      const { runFileWriteRpc } = await import("../tools/fileSystem.js");
      return runFileWriteRpc((params as Record<string, unknown>) ?? {}, root);
    }
    if (method === "memeloop.file.list") {
      const { runFileListRpc } = await import("../tools/fileSystem.js");
      return runFileListRpc((params as Record<string, unknown>) ?? {}, root);
    }
    if (method === "memeloop.file.search") {
      const { runFileSearchRpc } = await import("../tools/fileSystem.js");
      return runFileSearchRpc((params as Record<string, unknown>) ?? {}, root);
    }
    if (method === "memeloop.file.tail") {
      const { runFileTailRpc } = await import("../tools/fileSystem.js");
      return runFileTailRpc((params as Record<string, unknown>) ?? {}, root);
    }
  }

  if (method === "memeloop.sync.exchangeVersionVector") {
    const p = params as { localVersion?: Record<string, number> };
    const localVersion =
      p?.localVersion && typeof p.localVersion === "object" && !Array.isArray(p.localVersion)
        ? p.localVersion
        : {};
    const all = await storage.listConversations({ limit: 5000 });
    const clocks = maxTimestampPerOrigin(all);
    clocks[context.nodeId] = Math.max(clocks[context.nodeId] ?? 0, Date.now());
    const missingForRemote = all.filter(
      (c) => (localVersion[c.originNodeId] ?? 0) < (clocks[c.originNodeId] ?? 0),
    );
    return { remoteVersion: clocks, missingForRemote };
  }
  if (method === "memeloop.sync.pullMissingMetadata") {
    const p = params as { sinceVersion?: Record<string, number> };
    const since =
      p?.sinceVersion && typeof p.sinceVersion === "object" && !Array.isArray(p.sinceVersion)
        ? p.sinceVersion
        : {};
    const all = await storage.listConversations({ limit: 5000 });
    const clocks = maxTimestampPerOrigin(all);
    const metas = all.filter((c) => (since[c.originNodeId] ?? 0) < (clocks[c.originNodeId] ?? 0));
    return { metas };
  }
  if (method === "memeloop.sync.pullMissingMessages") {
    const p = params as { conversationId?: string; knownMessageIds?: string[] };
    const cid = typeof p?.conversationId === "string" ? p.conversationId.trim() : "";
    const known = new Set(Array.isArray(p?.knownMessageIds) ? p.knownMessageIds : []);
    if (!cid) {
      return { messages: [] };
    }
    const msgs = await storage.getMessages(cid, { mode: "full-content" });
    const messages = msgs.filter((m) => !known.has(m.messageId));
    return { messages };
  }

  if (method === "memeloop.chat.pullSubAgentLog") {
    const p = params as { conversationId?: string; knownMessageIds?: string[] };
    const cid = typeof p?.conversationId === "string" ? p.conversationId.trim() : "";
    const known = new Set(Array.isArray(p?.knownMessageIds) ? p.knownMessageIds : []);
    if (!cid) {
      return { nodeId: context.nodeId, conversationId: "", messages: [] as ChatMessage[] };
    }
    const msgs = await storage.getMessages(cid, { mode: "full-content" });
    const messages = msgs.filter((m) => !known.has(m.messageId));
    return { nodeId: context.nodeId, conversationId: cid, messages };
  }

  if (method === "memeloop.chat.pullTerminalSession") {
    const p = params as { sessionId?: string; fromSeq?: number };
    const sessionId = typeof p?.sessionId === "string" ? p.sessionId.trim() : "";
    const fromSeq = typeof p?.fromSeq === "number" && p.fromSeq >= 1 ? p.fromSeq : 1;
    if (!sessionId) {
      return {
        nodeId: context.nodeId,
        source: "none" as const,
        sessionId: "",
        messages: [] as ChatMessage[],
        chunks: [] as TerminalOutputChunk[],
      };
    }
    const terminalConversationId = `terminal:${sessionId}`;
    const stored = await storage.getMessages(terminalConversationId, { mode: "full-content" });
    if (stored.length > 0) {
      return {
        nodeId: context.nodeId,
        source: "storage" as const,
        sessionId,
        conversationId: terminalConversationId,
        messages: stored,
        chunks: [] as TerminalOutputChunk[],
      };
    }
    if (terminalManager?.get(sessionId)) {
      const chunks = terminalManager.getChunksSince(sessionId, fromSeq);
      const session = terminalManager.get(sessionId);
      return {
        nodeId: context.nodeId,
        source: "memory" as const,
        sessionId,
        conversationId: terminalConversationId,
        session,
        messages: [] as ChatMessage[],
        chunks,
      };
    }
    return {
      nodeId: context.nodeId,
      source: "none" as const,
      sessionId,
      conversationId: terminalConversationId,
      messages: [] as ChatMessage[],
      chunks: [] as TerminalOutputChunk[],
    };
  }

  if (method === "memeloop.storage.getAttachmentBlob") {
    const p = params as { contentHash?: string };
    const contentHash = typeof p?.contentHash === "string" ? p.contentHash.trim() : "";
    if (!contentHash) {
      return { error: "contentHash is required" };
    }
    const reader = storage.readAttachmentData;
    if (!reader) {
      return { error: "readAttachmentData not supported on this storage" };
    }
    const data = await reader(contentHash);
    if (!data?.length) {
      return { found: false as const };
    }
    const ref = await storage.getAttachment(contentHash);
    return {
      found: true as const,
      contentHash,
      filename: ref?.filename ?? "attachment",
      mimeType: ref?.mimeType ?? "application/octet-stream",
      size: ref?.size ?? data.length,
      dataBase64: Buffer.from(data).toString("base64"),
    };
  }

  if (method === "memeloop.mcp.callTool") {
    const p = params as {
      serverName?: string;
      toolName?: string;
      arguments?: Record<string, unknown>;
    };
    const serverName = typeof p?.serverName === "string" ? p.serverName.trim() : "";
    const toolName = typeof p?.toolName === "string" ? p.toolName.trim() : "";
    if (!serverName || !toolName) {
      return { error: "serverName and toolName are required" };
    }
    try {
      const { callMcpToolOnServer } = await import("../mcp/localMcpClient.js");
      const result = await callMcpToolOnServer(
        context.mcpServers ?? [],
        serverName,
        toolName,
        p.arguments ?? {},
      );
      return { result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `MCP callTool failed: ${message}` };
    }
  }

  throw new Error(`Method not found: ${method}`);
}

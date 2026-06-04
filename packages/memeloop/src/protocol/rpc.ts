import type { AgentDefinition } from "./agent.js";
import type { AuthHandshakeParameters, PinConfirmation } from "./auth.js";
import type { ChatMessage } from "./message.js";
import type { WikiInfo } from "./node.js";
import type { ConversationMeta, VersionVector } from "./sync.js";

export interface JsonRpcRequest<TParameters = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: TParameters;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;

/** memeloop-cli `rpcHandlers.ts` 中已实现的主要 JSON-RPC 方法（可随实现扩展）。 */
export interface RpcMethodMap {
  "memeloop.auth.handshake": {
    params: AuthHandshakeParameters;
    result: { ok: true; nodeId: string };
  };
  "memeloop.auth.hello": {
    params: {
      nodeId: string;
      capabilities?: Record<string, unknown>;
    };
    result: { ok: true; nodeId: string; receivedAt: number };
  };
  "memeloop.auth.confirmPin": {
    params: PinConfirmation;
    result: { ok: boolean; reason?: string; retryAfterMs?: number };
  };
  "memeloop.auth.exchangeJwt": {
    params: { localJwt: string; remoteJwt: string };
    result: { ok: boolean; matchedUserId?: string };
  };
  "memeloop.agent.create": {
    params: { definitionId: string; initialMessage?: string };
    result: { conversationId: string };
  };
  "memeloop.agent.send": {
    params: { conversationId: string; message: string };
    result: { ok: true };
  };
  "memeloop.agent.cancel": {
    params: { conversationId: string };
    result: { ok: true };
  };
  "memeloop.agent.list": {
    params: Record<string, never>;
    result: { conversations: ConversationMeta[] };
  };
  "memeloop.agent.getDefinitions": {
    params: Record<string, never>;
    result: { definitions: AgentDefinition[] };
  };
  "memeloop.agent.resolveQuestion": {
    params: { questionId: string; answer: string };
    result: { ok: boolean };
  };
  "memeloop.im.listChannels": {
    params: Record<string, never>;
    result: {
      channels: Array<{
        channelId: string;
        platform: string;
        defaultDefinitionId: string;
        hasBotToken: boolean;
        hasWebhookSecret: boolean;
        hasDiscordPublicKey: boolean;
        hasLarkEncryptKey: boolean;
        hasWecomEncodingAesKey: boolean;
      }>;
    };
  };
  "memeloop.im.getChannel": {
    params: { channelId: string };
    result: { channel: unknown };
  };
  "memeloop.terminal.execute": {
    params: { command: string; timeoutMs?: number; cwd?: string };
    result: { sessionId: string };
  };
  "memeloop.terminal.list": {
    params: Record<string, never>;
    result: unknown;
  };
  "memeloop.terminal.respond": {
    params: { sessionId: string; text: string };
    result: unknown;
  };
  "memeloop.terminal.cancel": {
    params: { sessionId: string };
    result: unknown;
  };
  "memeloop.terminal.start": {
    params: {
      command: string;
      mode?: "await" | "background" | "interactive" | "service";
      cwd?: string;
      parentConversationId?: string;
      label?: string;
      idleTimeoutMs?: number;
    };
    result: unknown;
  };
  "memeloop.terminal.signal": {
    params: { sessionId: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL" };
    result: unknown;
  };
  "memeloop.terminal.getOutput": {
    params: { sessionId: string; tailLines?: number; tailChars?: number };
    result: unknown;
  };
  "memeloop.knowledge.query": {
    params: { query: string; limit?: number };
    result: unknown;
  };
  "memeloop.knowledge.list": {
    params: Record<string, never>;
    result: unknown;
  };
  "memeloop.knowledge.get": {
    params: { id: string };
    result: unknown;
  };
  "memeloop.knowledge.write": {
    params: { title: string; text: string; tags?: string[] };
    result: unknown;
  };
  "memeloop.wiki.listWikis": {
    params: Record<string, never>;
    result: { wikis: WikiInfo[] };
  };
  "memeloop.node.getInfo": {
    params: Record<string, never>;
    result: unknown;
  };
  "memeloop.mcp.listServers": {
    params: Record<string, never>;
    result: unknown;
  };
  "memeloop.mcp.listTools": {
    params: { server: string };
    result: unknown;
  };
  "memeloop.mcp.callTool": {
    params: { server: string; tool: string; arguments?: unknown };
    result: unknown;
  };
  "memeloop.file.read": {
    params: { path: string; encoding?: string };
    result: unknown;
  };
  "memeloop.file.write": {
    params: { path: string; content: string };
    result: unknown;
  };
  "memeloop.file.list": {
    params: { path: string };
    result: unknown;
  };
  "memeloop.file.search": {
    params: { pattern: string; path?: string };
    result: unknown;
  };
  "memeloop.file.tail": {
    params: { path: string; lines?: number };
    result: unknown;
  };
  "memeloop.sync.exchangeVersionVector": {
    params: { vector: VersionVector };
    result: unknown;
  };
  "memeloop.sync.pullMissingMetadata": {
    params: { since?: number };
    result: unknown;
  };
  "memeloop.sync.pullMissingMessages": {
    params: { conversationId: string; afterLamport?: number };
    result: unknown;
  };
  "memeloop.chat.pullSubAgentLog": {
    params: { conversationId: string; knownMessageIds?: string[] };
    result: { nodeId: string; conversationId: string; messages: ChatMessage[] };
  };
  "memeloop.chat.pullTerminalSession": {
    params: { sessionId: string; fromSeq?: number };
    result: unknown;
  };
  "memeloop.storage.getAttachmentBlob": {
    params: { contentHash: string };
    result: unknown;
  };
}

export type RpcMethodName = keyof RpcMethodMap;

// eslint-disable-next-line unicorn/prevent-abbreviations
export type RpcParams<M extends RpcMethodName> = RpcMethodMap[M]["params"];

export type RpcResult<M extends RpcMethodName> = RpcMethodMap[M]["result"];

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return o.jsonrpc === "2.0" && typeof o.method === "string";
}

/** 对 JSON-RPC 调用方提供编译期方法/参数关联（实际发送仍由宿主 transport 执行）。 */
export async function sendJsonRpcMethod<M extends RpcMethodName>(
  send: (method: string, parameters: unknown) => Promise<unknown>,
  method: M,
  parameters: RpcParams<M>,
): Promise<RpcResult<M>> {
  return (await send(method, parameters)) as RpcResult<M>;
}

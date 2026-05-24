/**
 * ACP (Agent Client Protocol) – JSON-RPC over stdio/TCP for IDE integration.
 * Inspired by copilot-cli --acp.
 *
 * All messages are newline-delimited JSON (NDJSON).
 * Each line is a complete JSON-RPC 2.0 request, response, or notification.
 */
import type { JsonRpcError, JsonRpcRequest, JsonRpcResponse } from "@memeloop/protocol";

// ---------------------------------------------------------------------------
// ACP-specific method definitions
// ---------------------------------------------------------------------------

/** Capabilities reported by the client during initialization. */
export interface AcpClientCapabilities {
  /** Optional client name (e.g. "vscode", "intellij"). */
  clientName?: string;
  /** Client version string. */
  clientVersion?: string;
}

/** Server info returned from `initialize`. */
export interface AcpServerInfo {
  name: string;
  version: string;
  /** Supported protocol version. */
  protocolVersion: "0.1.0";
}

export interface AcpInitializeParams {
  capabilities?: AcpClientCapabilities;
}

export interface AcpInitializeResult {
  serverInfo: AcpServerInfo;
}

export interface AcpCreateSessionParams {
  /** Agent definition ID. Defaults to "memeloop:general-assistant". */
  agentId?: string;
  /** Resume an existing conversation from a checkpoint ID. */
  resumeId?: string;
}

export interface AcpCreateSessionResult {
  sessionId: string;
}

export interface AcpSendPromptParams {
  sessionId: string;
  prompt: string;
}

export type AcpResponseChunkType =
  | "thinking"
  | "tool"
  | "message"
  | "status";

export interface AcpResponseChunk {
  type: AcpResponseChunkType;
  /** Opaque data payload – tool results, thinking text, model output, etc. */
  data: unknown;
  /** Optional metadata (tool name, timestamp, etc.). */
  meta?: Record<string, unknown>;
}

export interface AcpSendPromptResult {
  /** Session id echoed back. */
  sessionId: string;
  /** Number of response chunks streamed. */
  chunkCount: number;
}

export interface AcpGetSessionParams {
  sessionId: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  agentId: string;
  conversationId: string;
  createdAt: number;
  /** Number of messages exchanged so far. */
  messageCount: number;
  /** Status: 'active', 'completed', 'cancelled', 'error'. */
  status: "active" | "completed" | "cancelled" | "error";
}

export interface AcpGetSessionResult {
  session: AcpSessionInfo | null;
}

export interface AcpListSessionsResult {
  sessions: AcpSessionInfo[];
}

export interface AcpCancelSessionParams {
  sessionId: string;
}

export interface AcpCancelSessionResult {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// ACP method map for typed JSON-RPC dispatch
// ---------------------------------------------------------------------------

export type AcpMethod =
  | "acp/initialize"
  | "acp/createSession"
  | "acp/sendPrompt"
  | "acp/getSession"
  | "acp/listSessions"
  | "acp/cancelSession";

export interface AcpMethodMap {
  "acp/initialize": {
    params: AcpInitializeParams;
    result: AcpInitializeResult;
  };
  "acp/createSession": {
    params: AcpCreateSessionParams;
    result: AcpCreateSessionResult;
  };
  "acp/sendPrompt": {
    params: AcpSendPromptParams;
    result: AcpSendPromptResult;
  };
  "acp/getSession": {
    params: AcpGetSessionParams;
    result: AcpGetSessionResult;
  };
  "acp/listSessions": {
    params: Record<string, never>;
    result: AcpListSessionsResult;
  };
  "acp/cancelSession": {
    params: AcpCancelSessionParams;
    result: AcpCancelSessionResult;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createRequest<M extends keyof AcpMethodMap>(
  id: string | number,
  method: M,
  params: AcpMethodMap[M]["params"],
): JsonRpcRequest<AcpMethodMap[M]["params"]> {
  return { jsonrpc: "2.0", id, method, params };
}

export function createSuccess<M extends keyof AcpMethodMap>(
  id: string | number | null,
  result: AcpMethodMap[M]["result"],
): JsonRpcResponse<AcpMethodMap[M]["result"]> {
  return { jsonrpc: "2.0", id, result };
}

export function createError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse<never> {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function createNotification(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: null, method, params };
}

// Standard JSON-RPC error codes
export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  SESSION_NOT_FOUND: -32001,
  UNKNOWN: -32000,
} as const;

export function errorMessage(code: number, default_: string): string {
  const map: Record<number, string> = {
    [-32700]: "Parse error",
    [-32600]: "Invalid Request",
    [-32601]: "Method not found",
    [-32602]: "Invalid params",
    [-32603]: "Internal error",
    [-32002]: "Server not initialized",
    [-32001]: "Session not found",
    [-32000]: "Unknown error",
  };
  return map[code] ?? default_;
}

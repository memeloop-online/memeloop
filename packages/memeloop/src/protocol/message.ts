import type { AttachmentReference } from "./attachment.js";

export type ChatRole = "user" | "assistant" | "tool" | "agent" | "error";

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: unknown;
}

/** Points to large tool output stored elsewhere (sub-agent log, terminal session, file). */
// eslint-disable-next-line unicorn/prevent-abbreviations
export type DetailRefType = "sub-agent" | "terminal-session" | "file";

export interface DetailReference {
  type: DetailRefType;
  /** Sub-agent / spawn / remote conversation id */
  conversationId?: string;
  /** Terminal session id (often paired with `terminal:<sessionId>` conversation) */
  sessionId?: string;
  /** Node that holds the detail payload */
  nodeId?: string;
  /** e.g. `memeloop://node/.../file/...` from `buildMemeloopFileUri` in `./uri.js` */
  fileUri?: string;
  exitCode?: number;
}

export interface ChatMessage {
  messageId: string;
  conversationId: string;
  originNodeId: string;
  timestamp: number;
  lamportClock: number;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
  /** Summary lives in `content`; full payload fetched via detail ref (plan §5.2.1). */
  detailRef?: DetailReference;
  /** Reasoning/thinking content */
  reasoning_content?: string;
  /** Content MIME type */
  contentType?: string;
  /** Whether message should be hidden in UI */
  hidden?: boolean;
  /** Message processing duration in ms */
  duration?: number | null;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

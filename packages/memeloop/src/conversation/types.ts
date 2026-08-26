export interface AttachmentReference {
  contentHash: string;
  filename: string;
  mimeType: string;
  size: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'agent' | 'error';

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: unknown;
}

export interface ChatToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

/** Points to large tool output stored elsewhere (agent-run log, terminal session, file). */
// eslint-disable-next-line unicorn/prevent-abbreviations
export type DetailRefType = 'agent-run' | 'terminal-session' | 'file';

export interface DetailReference {
  type: DetailRefType;
  /** Durable run identity; required by producers when type is `agent-run`. */
  runId?: string;
  /** Delegated agent / spawn / remote conversation id */
  conversationId?: string;
  /** Terminal session id (often paired with `terminal:<sessionId>` conversation) */
  sessionId?: string;
  /** Node that holds the detail payload */
  nodeId?: string;
  /** e.g. `memeloop://node/.../file/...` from `buildMemeloopFileUri` in `../network/uri.js` */
  fileUri?: string;
  exitCode?: number;
  /** Optional durable orchestration resource version for remote detail reads. */
  resourceVersion?: string;
}

export interface ChatAttachmentPart {
  type: 'attachment';
  attachment: AttachmentReference;
}

export interface ChatToolResultPart {
  type: 'tool-result';
  toolCallId?: string;
  toolName: string;
  parameters?: unknown;
  result: string;
  isError?: boolean;
  payload?: unknown;
  detailRef?: DetailReference;
}

export type ChatMessagePart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatToolCallPart
  | ChatAttachmentPart
  | ChatToolResultPart;

export interface ChatMessage {
  messageId: string;
  /** Stable turn membership; user messages use their own messageId. */
  turnId: string;
  conversationId: string;
  originNodeId: string;
  /** Per-conversation, per-origin contiguous event sequence used by sync/compaction frontiers. */
  originSequence: number;
  timestamp: number;
  lamportClock: number;
  role: ChatRole;
  /** Canonical structured message payload used for rendering and protocol projection. */
  parts?: ChatMessagePart[];
  /** Summary / fallback text projection of `parts` for hosts that only need plain text. */
  content: string;
  /** Materialized tool-call projection derived from `parts`. */
  toolCalls?: ToolCall[];
  /** Materialized attachment projection derived from `parts`. */
  attachments?: AttachmentReference[];
  /** Summary lives in `content`; full payload fetched via detail ref (plan §5.2.1). */
  detailRef?: DetailReference;
  /** Materialized reasoning projection derived from `parts`. */
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

/**
 * TUI type definitions
 */

export interface TUIMessage {
  kind?: 'message' | 'compaction';
  /** Canonical Core ChatMessage identity; compaction markers use their entryId. */
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  /** tool call metadata */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  /** thinking/reasoning content (displayed dimmed) */
  thinking?: string;
  /** Bounded pointer/metadata for detail that is intentionally not resident. */
  detail?: {
    truncated: boolean;
    originalBytes: number;
    detailRef?: string;
  };
  /** Real semantic compaction marker; it never invents a turn/message identity. */
  compaction?: {
    entryId: string;
    summaryPreview: string;
    compactedMessageCount: number;
    compactedTurnCount: number;
  };
}

export interface ToolProgress {
  toolName: string;
  status: 'running' | 'done' | 'error';
  message?: string;
  startTime: Date;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  message: string;
  /** allowed actions */
  actions: ('allow' | 'deny' | 'always')[];
}

export type TUIMode = 'chat' | 'plan' | 'autopilot';

export interface TUIState {
  messages: TUIMessage[];
  semanticAnchor?: TUIMessage;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  pendingTailCount: number;
  loadingPage: boolean;
  windowError?: string;
  thinking: boolean;
  progress: ToolProgress | null;
  permission: PermissionRequest | null;
  statusText: string;
  mode: TUIMode;
}

export type TUIAction =
  | { type: 'ADD_MESSAGE'; message: TUIMessage }
  | { type: 'SET_MESSAGES'; messages: TUIMessage[] }
  | {
    type: 'SET_WINDOW';
    messages: TUIMessage[];
    semanticAnchor?: TUIMessage;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    pendingTailCount: number;
    loadingPage: boolean;
    windowError?: string;
  }
  | { type: 'APPEND_TO_LAST'; text: string }
  | { type: 'SET_THINKING'; thinking: boolean }
  | { type: 'SET_PROGRESS'; progress: TUIState['progress'] }
  | { type: 'SET_PERMISSION'; permission: TUIState['permission'] }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'SET_MODE'; mode: TUIMode };

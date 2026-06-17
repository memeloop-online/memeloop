import type { ChatMessage } from "memeloop";
import type { ReactNode } from "react";

/** Attachment metadata for a wiki tiddler selected in the composer. */
export interface WikiTiddlerAttachment {
  workspaceName: string;
  tiddlerTitle: string;
}

/** Host-supplied adapter that wires a MemeLoop conversation into assistant-ui. */
export interface MemeLoopChatAdapter {
  /** All messages for the current conversation, in display order. */
  messages: readonly ChatMessage[];

  /** True while the agent is generating a response. */
  isRunning: boolean;

  /** True while the conversation/agent metadata is loading. */
  isLoading: boolean;

  /** Check if a specific message is currently streaming. */
  isMessageStreaming?: (messageId: string) => boolean;

  /** Last error, if any. */
  error: Error | null;

  /** Send a new user message. */
  sendMessage: (input: {
    text: string;
    file?: File;
    wikiTiddlers?: WikiTiddlerAttachment[];
  }) => Promise<void>;

  /** Cancel the current generation. */
  cancel: () => Promise<void>;

  /** Delete a turn starting at the given user message id. */
  deleteTurn: (userMessageId: string) => Promise<void>;

  /** Retry a turn starting at the given user message id. */
  retryTurn: (userMessageId: string) => Promise<void>;

  /** Edit an existing user message and regenerate the response. */
  editMessage?: (messageId: string, text: string) => Promise<void>;

  /** Reload/regenerate an assistant message. */
  reloadMessage?: (messageId: string) => Promise<void>;

  /** Resolve an ask-question tool call with the user's answer (same-turn). */
  resolveAskQuestion?: (questionId: string, answer: string) => Promise<void>;

  /** Persist a metadata update for a single message. */
  updateMessage?: (message: ChatMessage) => Promise<void>;
}

/** Data passed to onWikiTiddlerClick when a tiddler chip is clicked in a message. */
export interface WikiTiddlerClickData {
  workspaceId: string;
  workspaceName: string;
  tiddlerTitle: string;
  renderedContent?: string;
}

/** Props accepted by MemeLoopThread. */
export interface MemeLoopThreadProps {
  /** Rendered above the message list (e.g. host-specific header). */
  header?: ReactNode;

  /** Rendered below the message list (e.g. host-specific footer). */
  footer?: ReactNode;

  /** Empty state content. */
  empty?: ReactNode;

  /** Optional custom message content renderer passed to MemeLoopMessage. */
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => ReactNode;

  /** Optional turn action renderer shown below assistant messages. */
  renderTurnActions?: (message: ChatMessage) => ReactNode;

  /** Optional handler when a wiki tiddler chip is clicked in a message. */
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;

  /** Custom composer component; defaults to MemeLoopComposer. */
  composerComponent?: React.ComponentType;

  /** Extra className or style for the root. */
  className?: string;
}

/** Props accepted by MemeLoopMessage. */
export interface MemeLoopMessageProps {
  message: ChatMessage;
  /** Optional custom content renderer. Defaults to a plain text renderer. */
  renderContent?: (message: ChatMessage, isUser: boolean) => ReactNode;
  /** Optional turn action renderer shown below assistant messages. */
  renderTurnActions?: (message: ChatMessage) => ReactNode;
  /** Optional handler when a wiki tiddler chip is clicked in a message. */
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;
}

/** Props accepted by MemeLoopComposer. */
export interface MemeLoopComposerProps {
  /** Called when the user selects a file attachment. */
  onFileSelect?: (file: File) => void;

  /** Called when the user selects a wiki tiddler attachment. */
  onWikiTiddlerSelect?: (tiddler: WikiTiddlerAttachment) => void;

  /** Currently selected file attachment. */
  selectedFile?: File;

  /** Currently selected wiki tiddler attachments. */
  selectedWikiTiddlers?: WikiTiddlerAttachment[];

  /** Called when the user clears the selected file. */
  onClearFile?: () => void;

  /** Called when the user removes a wiki tiddler attachment. */
  onRemoveWikiTiddler?: (index: number) => void;

  /** Extra attachment action buttons rendered next to the file button. */
  renderAttachmentActions?: ReactNode;

  /** Placeholder text for the input. */
  placeholder?: string;

  /** Whether the composer is disabled. */
  disabled?: boolean;
}
